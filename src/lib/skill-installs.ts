/**
 * skill-installs.ts — Postgres helpers for the skill-install-ping endpoint (#861).
 * Mirrors lib/skill-installs.mjs. API routes must use this (TS), server.mjs uses .mjs.
 */

let _pool: any = undefined;

async function getPool(): Promise<any> {
  if (_pool !== undefined) return _pool;
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    _pool = null;
    return null;
  }
  try {
    const pg = await import('pg');
    const Pool = (pg as any).default?.Pool || (pg as any).Pool;
    _pool = new Pool({ connectionString: dbUrl, max: 3 });
    return _pool;
  } catch (e: any) {
    console.error('[SkillInstalls] Failed to create pool:', e.message);
    _pool = null;
    return null;
  }
}

export async function recordInstall({
  agentId,
  skill,
  commitHash,
}: {
  agentId: string;
  skill: string;
  commitHash?: string | null;
}): Promise<{ ok: boolean; reason?: string }> {
  const p = await getPool();
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
  } catch (e: any) {
    // Table may not exist yet; create-on-demand once, then retry.
    if (/does not exist/i.test(e?.message || '')) {
      try {
        await p.query(`
          CREATE TABLE IF NOT EXISTS org_studio_skill_installs (
            agent_id TEXT NOT NULL,
            skill TEXT NOT NULL,
            commit_hash TEXT,
            installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (agent_id, skill)
          );
        `);
        await p.query(
          `INSERT INTO org_studio_skill_installs (agent_id, skill, commit_hash, installed_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (agent_id, skill)
           DO UPDATE SET commit_hash = EXCLUDED.commit_hash, installed_at = NOW()`,
          [agentId, skill, commitHash || null]
        );
        return { ok: true };
      } catch (e2: any) {
        console.error('[SkillInstalls] recordInstall retry failed:', e2.message);
        return { ok: false, reason: e2.message };
      }
    }
    console.error('[SkillInstalls] recordInstall failed:', e.message);
    return { ok: false, reason: e.message };
  }
}

export interface InstallRow {
  agent_id: string;
  skill: string;
  commit_hash: string | null;
  installed_at: string;
  age_seconds: number;
}

export async function listInstalls({
  skill = 'org-studio',
}: { skill?: string } = {}): Promise<InstallRow[]> {
  const p = await getPool();
  if (!p) return [];
  try {
    // #980 — 'all' (or empty) returns every skill, not just org-studio.
    const allSkills = !skill || skill === 'all' || skill === '*';
    const { rows } = allSkills
      ? await p.query(
          `SELECT agent_id, skill, commit_hash, installed_at,
                  EXTRACT(EPOCH FROM (NOW() - installed_at))::INT AS age_seconds
             FROM org_studio_skill_installs
            ORDER BY skill ASC, installed_at DESC`,
        )
      : await p.query(
          `SELECT agent_id, skill, commit_hash, installed_at,
                  EXTRACT(EPOCH FROM (NOW() - installed_at))::INT AS age_seconds
             FROM org_studio_skill_installs
            WHERE skill = $1
            ORDER BY installed_at DESC`,
          [skill],
        );
    return rows;
  } catch (e: any) {
    if (/does not exist/i.test(e?.message || '')) return [];
    console.error('[SkillInstalls] listInstalls failed:', e.message);
    return [];
  }
}
