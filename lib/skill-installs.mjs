/**
 * skill-installs.mjs — Track agent skill installation events (#861)
 *
 * Each agent session runs `npx skills add ToomeSauce/org-studio --yes` at startup
 * (per ORG.md). To verify this design works, we instrument install events:
 *   1. ORG.md emits a compound command that posts to /api/skill-install-ping
 *      after install completes.
 *   2. This module persists {agent_id, skill, commit_hash, installed_at}.
 *   3. /performance widget shows per-agent freshness.
 *   4. Drift watchdog flags agents active in the last hour but silent > 24h.
 *
 * Postgres-only; file-mode is a graceful no-op.
 */

import { logIncident } from './heartbeats.mjs';

const TAG = '[SkillInstalls]';

async function getPool() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return null;
  try {
    const { default: pg } = await import('pg');
    return new pg.Pool({ connectionString: dbUrl, max: 3 });
  } catch (e) {
    console.error(`${TAG} Failed to create pool:`, e.message);
    return null;
  }
}

let _pool = undefined;
async function pool() {
  if (_pool === undefined) _pool = await getPool();
  return _pool;
}

/**
 * Create skill_installs table if it doesn't exist.
 * One row per (agent_id, skill) — upsert on ping, last install wins.
 */
export async function ensureSkillInstallsSchema() {
  const p = await pool();
  if (!p) {
    console.log(`${TAG} Disabled (file mode — Postgres required)`);
    return;
  }
  const client = await p.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS org_studio_skill_installs (
        agent_id TEXT NOT NULL,
        skill TEXT NOT NULL,
        commit_hash TEXT,
        installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (agent_id, skill)
      );
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_skill_installs_installed_at ON org_studio_skill_installs(installed_at DESC);`
    );
    console.log(`${TAG} Schema ensured (org_studio_skill_installs)`);
  } finally {
    client.release();
  }
}

/**
 * Record an install-ping event.
 * @param {Object} args
 * @param {string} args.agentId
 * @param {string} args.skill
 * @param {string} [args.commitHash]
 */
export async function recordInstall({ agentId, skill, commitHash }) {
  const p = await pool();
  if (!p) return { ok: false, reason: 'no-db' };
  if (!agentId || !skill) return { ok: false, reason: 'missing-fields' };

  try {
    await p.query(
      `INSERT INTO org_studio_skill_installs (agent_id, skill, commit_hash, installed_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (agent_id, skill)
       DO UPDATE SET commit_hash = EXCLUDED.commit_hash, installed_at = NOW()`,
      [agentId, skill, commitHash || null]
    );
    return { ok: true };
  } catch (e) {
    console.error(`${TAG} recordInstall failed:`, e.message);
    return { ok: false, reason: e.message };
  }
}

/**
 * Get latest install per agent for a given skill (default: org-studio).
 * Returns [{agent_id, skill, commit_hash, installed_at, age_seconds}]
 */
export async function listInstalls({ skill = 'org-studio' } = {}) {
  const p = await pool();
  if (!p) return [];
  try {
    const { rows } = await p.query(
      `SELECT agent_id, skill, commit_hash, installed_at,
              EXTRACT(EPOCH FROM (NOW() - installed_at))::INT AS age_seconds
         FROM org_studio_skill_installs
        WHERE skill = $1
        ORDER BY installed_at DESC`,
      [skill]
    );
    return rows;
  } catch (e) {
    console.error(`${TAG} listInstalls failed:`, e.message);
    return [];
  }
}

/**
 * Drift check: agents who have been active recently (lastActivityAt on their
 * tasks within `activeWithinMs`) but haven't pinged install in `staleAfterMs`.
 *
 * @param {Object} args
 * @param {Array} args.tasks — current tasks from store
 * @param {Array} args.teammates — store teammates
 * @param {number} [args.activeWithinMs=3600_000]  (1 hour)
 * @param {number} [args.staleAfterMs=86_400_000]  (24 hours)
 * @returns {Promise<Array<{agentId,name,lastInstallAt,lastActivityAt}>>}
 */
export async function detectDrift({
  tasks = [],
  teammates = [],
  activeWithinMs = 60 * 60 * 1000,
  staleAfterMs = 24 * 60 * 60 * 1000,
} = {}) {
  const installs = await listInstalls();
  const installByAgent = new Map(installs.map((r) => [r.agent_id.toLowerCase(), r]));

  // Build per-agent last activity from task.lastActivityAt (matching assignee by name)
  const now = Date.now();
  const activityByAgent = new Map();
  for (const t of tasks) {
    if (!t.assignee || !t.lastActivityAt) continue;
    const key = String(t.assignee).toLowerCase();
    const prev = activityByAgent.get(key) || 0;
    if (t.lastActivityAt > prev) activityByAgent.set(key, t.lastActivityAt);
  }

  const drifted = [];
  for (const tm of teammates) {
    if (tm.isHuman) continue;
    const nameKey = String(tm.name || '').toLowerCase();
    const idKey = String(tm.agentId || tm.id || '').toLowerCase();
    const lastActivity = activityByAgent.get(nameKey) || activityByAgent.get(idKey) || 0;
    if (!lastActivity || now - lastActivity > activeWithinMs) continue;

    const install = installByAgent.get(idKey) || installByAgent.get(nameKey);
    const lastInstallMs = install ? new Date(install.installed_at).getTime() : 0;
    const staleFor = now - lastInstallMs;

    if (!install || staleFor > staleAfterMs) {
      drifted.push({
        agentId: tm.agentId || tm.id,
        name: tm.name,
        lastInstallAt: install ? install.installed_at : null,
        lastActivityAt: new Date(lastActivity).toISOString(),
      });
    }
  }
  return drifted;
}

let _lastDriftIncidentAt = 0;
const DRIFT_INCIDENT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Run drift check and log a soft incident if anything is drifted.
 * Cooldown to avoid incident spam.
 */
export async function runDriftCheck({ tasks, teammates }) {
  const drifted = await detectDrift({ tasks, teammates });
  if (drifted.length === 0) return { drifted: [] };
  if (Date.now() - _lastDriftIncidentAt < DRIFT_INCIDENT_COOLDOWN_MS) {
    return { drifted, incidentLogged: false, reason: 'cooldown' };
  }
  _lastDriftIncidentAt = Date.now();
  try {
    await logIncident({
      type: 'skill_install_drift',
      agentId: null,
      message: `${drifted.length} active agent(s) missing recent skill install-ping`,
      context: { drifted },
    });
  } catch (e) {
    console.error(`${TAG} logIncident failed:`, e.message);
  }
  return { drifted, incidentLogged: true };
}
