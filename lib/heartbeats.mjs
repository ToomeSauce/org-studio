/**
 * heartbeats.mjs — Agent loop heartbeat watchdog (server-side, ESM)
 *
 * Provides:
 *   ensureHeartbeatSchema() — creates org_studio_heartbeats + org_studio_incidents tables
 *   startLoopWatchdog()     — periodic checker that restarts stale loops
 *
 * Called from server.mjs at startup. Postgres-only; silently no-ops in file mode.
 */

import crypto from 'node:crypto';
import { sendHealthAlert } from './health-alerts.mjs';

const TAG = '[HeartbeatWatchdog]';

/**
 * Returns a pg Pool connected to DATABASE_URL, or null if unavailable.
 */
async function getPool() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return null;
  try {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: dbUrl, max: 3 });
    return pool;
  } catch (e) {
    console.error(`${TAG} Failed to create pool:`, e.message);
    return null;
  }
}

// Module-level pool (lazy singleton)
let _pool = undefined; // undefined = not yet initialized, null = no DB

async function pool() {
  if (_pool === undefined) {
    _pool = await getPool();
  }
  return _pool;
}

/**
 * Create heartbeat + incidents tables if they don't exist.
 */
export async function ensureHeartbeatSchema() {
  const p = await pool();
  if (!p) {
    console.log(`${TAG} Disabled (file mode — Postgres required)`);
    return;
  }

  const client = await p.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS org_studio_heartbeats (
        agent_id TEXT PRIMARY KEY,
        loop_id TEXT,
        last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_status TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS org_studio_incidents (
        id TEXT PRIMARY KEY,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        type TEXT NOT NULL,
        agent_id TEXT,
        message TEXT NOT NULL,
        context JSONB
      );
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_incidents_timestamp ON org_studio_incidents(timestamp DESC);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_incidents_agent_id ON org_studio_incidents(agent_id);`);

    console.log(`${TAG} Schema ensured (heartbeats + incidents tables)`);
  } finally {
    client.release();
  }
}

/**
 * Log an incident to org_studio_incidents.
 */
export async function logIncident({ type, agentId, message, context }) {
  const p = await pool();
  if (!p) return;

  try {
    await p.query(
      `INSERT INTO org_studio_incidents (id, timestamp, type, agent_id, message, context, workspace_id)
       VALUES ($1, NOW(), $2, $3, $4, $5, $6)`,
      [crypto.randomUUID(), type, agentId, message, context ? JSON.stringify(context) : null, 'default-workspace']
    );
  } catch (e) {
    console.error(`${TAG} Failed to log incident:`, e.message);
  }
}

/**
 * Pause-watchdog control. Pauses are persisted in Postgres so they survive
 * server restarts and can be set/cleared from any process (Next.js API
 * routes, mjs server runtime, ops scripts).
 *
 * Schema:
 *   org_studio_watchdog_pauses (
 *     agent_id TEXT PRIMARY KEY,   -- '*' for global pause
 *     until_at TIMESTAMPTZ NOT NULL
 *   )
 *
 * Created lazily on first read/write.
 */
async function ensurePauseSchema(p) {
  await p.query(`
    CREATE TABLE IF NOT EXISTS org_studio_watchdog_pauses (
      agent_id TEXT PRIMARY KEY,
      until_at TIMESTAMPTZ NOT NULL
    );
  `);
}

export async function pauseWatchdog(agentId, untilMs) {
  const p = await pool();
  if (!p) return;
  await ensurePauseSchema(p);
  const untilIso = new Date(untilMs).toISOString();
  await p.query(
    `INSERT INTO org_studio_watchdog_pauses (agent_id, until_at)
     VALUES ($1, $2)
     ON CONFLICT (agent_id) DO UPDATE SET until_at = EXCLUDED.until_at`,
    [agentId, untilIso]
  );
}

export async function unpauseWatchdog(agentId) {
  const p = await pool();
  if (!p) return;
  await ensurePauseSchema(p);
  await p.query(`DELETE FROM org_studio_watchdog_pauses WHERE agent_id = $1`, [agentId]);
}

/**
 * Returns Set<agentId> of currently paused agents (resolves '*' as wildcard).
 * Cleans up expired rows as a side effect.
 */
async function getPausedSet(p) {
  await ensurePauseSchema(p);
  const { rows } = await p.query(
    `SELECT agent_id FROM org_studio_watchdog_pauses WHERE until_at > NOW()`
  );
  // Clean expired (best-effort, ignore errors)
  p.query(`DELETE FROM org_studio_watchdog_pauses WHERE until_at <= NOW()`).catch(() => {});
  return new Set(rows.map(r => r.agent_id));
}

export async function isWatchdogPaused(agentId) {
  const p = await pool();
  if (!p) return false;
  const set = await getPausedSet(p);
  return set.has('*') || set.has(agentId);
}

/**
 * Start the periodic heartbeat watchdog.
 *
 * On each tick:
 *   1. Query heartbeats where now() - last_heartbeat > thresholdMs
 *   2. For each stale agent, POST /api/scheduler { action: 'trigger', agentId }
 *   3. ONLY when the trigger actually dispatches, log an incident + health
 *      alert. Silent fizzles (no actionable work, no enabled loop, agent
 *      already in-flight, cooldown) do not pollute the journal — that was
 *      the 229-dead-letter / nightly-spam pattern in #1180.
 *   4. Respect restart cooldown per agent. Cooldown grows when an agent
 *      keeps fizzling so dormant agents (heartbeat days old, no loop) stop
 *      thrashing the trigger endpoint every 2 minutes forever.
 *   5. Skip entirely when the agent is paused via the kill-switch.
 *
 * Defaults bumped (#1180):
 *   - thresholdMs: 5min → 15min. Agents doing real work (e.g. running a
 *     long build) shouldn't be considered stale until they've been silent
 *     for a meaningfully long stretch. The 5-min default fired during
 *     normal Gem build cycles and re-dispatched the same task on top of
 *     itself, causing the 96°C thermal incident.
 *   - restartCooldownMs: 2min → 10min base, with multiplicative backoff
 *     when consecutive triggers all fizzle (capped at 60min).
 */
export function startLoopWatchdog({
  intervalMs = 60_000,
  thresholdMs = 15 * 60_000,
  restartCooldownMs = 10 * 60_000,
  maxCooldownMs = 60 * 60_000,
} = {}) {
  // In-memory cooldown + fizzle-streak maps
  const lastRestart = new Map(); // agentId -> timestamp ms
  const fizzleStreak = new Map(); // agentId -> consecutive fizzle count

  const apiKey = process.env.ORG_STUDIO_API_KEY || '';
  const baseUrl = `http://127.0.0.1:${process.env.PORT || '4501'}`;

  const tick = async () => {
    const p = await pool();
    if (!p) return;

    try {
      // Snapshot pause set once per tick (single query) for cheap per-row
      // checks below. Stale agents that are paused are silently skipped.
      let pauseSet = new Set();
      try {
        pauseSet = await getPausedSet(p);
      } catch (e) {
        // Schema may not exist yet on first run; treat as empty set
        pauseSet = new Set();
      }
      const globallyPaused = pauseSet.has('*');

      // Find agents whose heartbeat is older than threshold
      const { rows } = await p.query(
        `SELECT agent_id, loop_id, last_heartbeat, last_status
         FROM org_studio_heartbeats
         WHERE last_heartbeat < NOW() - INTERVAL '1 millisecond' * $1`,
        [thresholdMs]
      );

      if (rows.length === 0) return;

      const now = Date.now();

      for (const row of rows) {
        const agentId = row.agent_id;

        // Kill-switch: skip paused agents entirely (#1180)
        if (globallyPaused || pauseSet.has(agentId)) {
          continue;
        }

        // Check cooldown — back off when this agent keeps fizzling
        const streak = fizzleStreak.get(agentId) || 0;
        const effectiveCooldown = Math.min(
          restartCooldownMs * Math.pow(2, streak),
          maxCooldownMs,
        );
        const lastMs = lastRestart.get(agentId) || 0;
        if (now - lastMs < effectiveCooldown) {
          continue; // skip — backed-off cooldown still active
        }

        console.log(`${TAG} Stale heartbeat for ${agentId} (last: ${row.last_heartbeat}, streak: ${streak}) — triggering restart`);
        lastRestart.set(agentId, Date.now());

        // Trigger restart via scheduler API
        let result = {};
        try {
          const resp = await fetch(`${baseUrl}/api/scheduler`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify({ action: 'trigger', agentId }),
          });

          result = await resp.json().catch(() => ({}));
        } catch (e) {
          console.error(`${TAG} Failed to trigger restart for ${agentId}:`, e.message);
          // Network/transport error counts as a fizzle
          fizzleStreak.set(agentId, streak + 1);
          continue;
        }

        // Distinguish a real dispatch from a fizzle. A real dispatch is the
        // only thing worth incident-logging + health-alerting.
        const dispatched = result.ok && result.triggered === true;

        if (!dispatched) {
          // Fizzle — bump streak, increase cooldown next time, do NOT log
          // an incident or send a health alert. (Pre-#1180 we logged every
          // fizzle as a `watchdog_restart`, which is what produced the
          // 229-message dead-letter backlog and per-minute spam for
          // dormant agents like billy/kate/main whose heartbeats were
          // days old.)
          fizzleStreak.set(agentId, streak + 1);
          console.log(`${TAG} Restart fizzled for ${agentId}: ${result.reason || (result.ok ? 'unknown' : 'error')} (cooldown now ${Math.min(effectiveCooldown * 2, maxCooldownMs) / 60000}m)`);
          continue;
        }

        // Real dispatch — reset streak, log incident, send alert
        fizzleStreak.delete(agentId);

        await logIncident({
          type: 'watchdog_restart',
          agentId,
          message: `Heartbeat watchdog restarted loop for ${agentId} (last heartbeat: ${row.last_heartbeat})`,
          context: {
            lastHeartbeat: row.last_heartbeat,
            lastStatus: row.last_status,
            loopId: row.loop_id,
            triggerResult: result,
          },
        });

        const minutesStale = Math.round((Date.now() - new Date(row.last_heartbeat).getTime()) / 60000);
        await sendHealthAlert({
          type: 'watchdog_restart',
          emoji: '🚨',
          title: 'Watchdog auto-restart',
          context: `Agent: ${agentId} (${row.loop_id || 'unknown'}) restarted after ${minutesStale}m silence`,
        });

        console.log(`${TAG} Restart dispatched for ${agentId}`);
      }
    } catch (e) {
      console.error(`${TAG} Tick error:`, e.message);
    }
  };

  // Run on interval
  const handle = setInterval(tick, intervalMs);

  // Run first tick after a short delay (let server fully start)
  setTimeout(tick, 10_000);

  console.log(`${TAG} Started (interval: ${intervalMs / 1000}s, threshold: ${thresholdMs / 60_000}min, base cooldown: ${restartCooldownMs / 60_000}min, max cooldown: ${maxCooldownMs / 60_000}min)`);

  return handle;
}
