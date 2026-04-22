/**
 * bootstrap-pings.ts — Postgres helpers for the bootstrap-ping endpoint (#864 vector #5).
 *
 * Agents POST their bootstrap file SHAs at session start. Org Studio stores
 * the latest ping per agent and can compare against the source files to
 * detect drift (stale cache, partial injection, etc.).
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

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
    console.error('[BootstrapPings] Failed to create pool:', e.message);
    _pool = null;
    return null;
  }
}

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS org_studio_bootstrap_pings (
    agent_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    reported_sha TEXT NOT NULL,
    pinged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (agent_id, file_path)
  );
`;

export async function recordBootstrapPing({
  agentId,
  files,
}: {
  agentId: string;
  files: Record<string, string>; // { "SOUL.md": "sha256hex", ... }
}): Promise<{ ok: boolean; recorded: number; reason?: string }> {
  const p = await getPool();
  if (!p) return { ok: false, recorded: 0, reason: 'no-db' };
  if (!agentId || !files || typeof files !== 'object') {
    return { ok: false, recorded: 0, reason: 'missing-fields' };
  }

  const entries = Object.entries(files).filter(([, v]) => typeof v === 'string' && v.length > 0);
  if (entries.length === 0) return { ok: false, recorded: 0, reason: 'no-files' };

  try {
    let recorded = 0;
    for (const [filePath, sha] of entries) {
      await p.query(
        `INSERT INTO org_studio_bootstrap_pings (agent_id, file_path, reported_sha, pinged_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (agent_id, file_path)
         DO UPDATE SET reported_sha = EXCLUDED.reported_sha, pinged_at = NOW()`,
        [agentId, filePath, sha],
      );
      recorded++;
    }
    return { ok: true, recorded };
  } catch (e: any) {
    if (/does not exist/i.test(e?.message || '')) {
      try {
        await p.query(CREATE_TABLE);
        // Retry
        let recorded = 0;
        for (const [filePath, sha] of entries) {
          await p.query(
            `INSERT INTO org_studio_bootstrap_pings (agent_id, file_path, reported_sha, pinged_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (agent_id, file_path)
             DO UPDATE SET reported_sha = EXCLUDED.reported_sha, pinged_at = NOW()`,
            [agentId, filePath, sha],
          );
          recorded++;
        }
        return { ok: true, recorded };
      } catch (e2: any) {
        console.error('[BootstrapPings] recordBootstrapPing retry failed:', e2.message);
        return { ok: false, recorded: 0, reason: e2.message };
      }
    }
    console.error('[BootstrapPings] recordBootstrapPing failed:', e.message);
    return { ok: false, recorded: 0, reason: e.message };
  }
}

export interface BootstrapPingRow {
  agent_id: string;
  file_path: string;
  reported_sha: string;
  pinged_at: string;
  age_seconds: number;
}

export async function listBootstrapPings(agentId?: string): Promise<BootstrapPingRow[]> {
  const p = await getPool();
  if (!p) return [];
  try {
    const query = agentId
      ? `SELECT agent_id, file_path, reported_sha, pinged_at,
                EXTRACT(EPOCH FROM (NOW() - pinged_at))::INT AS age_seconds
           FROM org_studio_bootstrap_pings
          WHERE agent_id = $1
          ORDER BY file_path ASC`
      : `SELECT agent_id, file_path, reported_sha, pinged_at,
                EXTRACT(EPOCH FROM (NOW() - pinged_at))::INT AS age_seconds
           FROM org_studio_bootstrap_pings
          ORDER BY agent_id ASC, file_path ASC`;
    const { rows } = agentId
      ? await p.query(query, [agentId])
      : await p.query(query);
    return rows;
  } catch (e: any) {
    if (/does not exist/i.test(e?.message || '')) return [];
    console.error('[BootstrapPings] listBootstrapPings failed:', e.message);
    return [];
  }
}

/**
 * Resolve agent workspace directory.
 * Convention: ~/.openclaw/workspace-{agentId} (main agent uses bare "workspace").
 */
function resolveAgentWorkspaceDir(agentId: string): string {
  const home = process.env.HOME || '/home/openclaw_user';
  const suffix = agentId === 'main' ? '' : `-${agentId}`;
  return join(home, '.openclaw', `workspace${suffix}`);
}

/**
 * Compute SHA-256 of a file's content. Returns null if file doesn't exist.
 */
async function computeFileSha(filePath: string): Promise<string | null> {
  try {
    const content = await readFile(filePath);
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

const BOOTSTRAP_FILES = ['SOUL.md', 'USER.md', 'ORG.md', 'MEMORY.md', 'AGENTS.md', 'IDENTITY.md'];

export interface DriftCheckResult {
  agentId: string;
  files: Array<{
    path: string;
    reportedSha: string | null;
    sourceSha: string | null;
    match: boolean;
    drifted: boolean;
    pingedAt: string | null;
    ageSeconds: number | null;
  }>;
  hasDrift: boolean;
  lastPingedAt: string | null;
}

/**
 * Compare an agent's reported SHAs against the actual files on disk.
 */
export async function checkBootstrapDrift(agentId: string): Promise<DriftCheckResult> {
  const pings = await listBootstrapPings(agentId);
  const pingMap = new Map(pings.map(p => [p.file_path, p]));
  const wsDir = resolveAgentWorkspaceDir(agentId);

  const files: DriftCheckResult['files'] = [];
  let hasDrift = false;
  let lastPingedAt: string | null = null;

  for (const fileName of BOOTSTRAP_FILES) {
    const fullPath = join(wsDir, fileName);
    const sourceSha = await computeFileSha(fullPath);

    // Skip files that don't exist on disk and weren't reported
    const ping = pingMap.get(fileName);
    if (!sourceSha && !ping) continue;

    const reportedSha = ping?.reported_sha || null;
    const match = sourceSha !== null && reportedSha !== null && sourceSha === reportedSha;
    const drifted = sourceSha !== null && reportedSha !== null && sourceSha !== reportedSha;

    if (drifted) hasDrift = true;

    const pingedAt = ping?.pinged_at || null;
    if (pingedAt && (!lastPingedAt || pingedAt > lastPingedAt)) {
      lastPingedAt = pingedAt;
    }

    files.push({
      path: fileName,
      reportedSha,
      sourceSha,
      match,
      drifted,
      pingedAt,
      ageSeconds: ping?.age_seconds ?? null,
    });
  }

  return { agentId, files, hasDrift, lastPingedAt };
}
