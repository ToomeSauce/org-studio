/**
 * heartbeats.ts — TypeScript helper for writing agent loop heartbeats.
 *
 * Called from the scheduler route (src/app/api/scheduler/route.ts) after
 * a loop fires successfully. Uses the same Postgres pool pattern as the
 * rest of the codebase. Silently no-ops if DATABASE_URL is not set.
 */

let _pool: any = undefined; // undefined = not yet initialized, null = no DB

async function getPool(): Promise<any> {
  if (_pool !== undefined) return _pool;

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    _pool = null;
    return null;
  }

  try {
    const pg = await import('pg');
    const Pool = pg.default?.Pool || pg.Pool;
    _pool = new Pool({ connectionString: dbUrl, max: 3 });
    return _pool;
  } catch (e: any) {
    console.error('[Heartbeat] Failed to create pool:', e.message);
    _pool = null;
    return null;
  }
}

/**
 * Write (UPSERT) a heartbeat for the given agent loop.
 * Safe to call frequently — uses ON CONFLICT to update in place.
 * Never throws; heartbeat failures must not break scheduler execution.
 */
export async function writeHeartbeat({
  agentId,
  loopId,
  status,
}: {
  agentId: string;
  loopId?: string;
  status?: string;
}): Promise<void> {
  const pool = await getPool();
  if (!pool) return;

  try {
    await pool.query(
      `INSERT INTO org_studio_heartbeats (agent_id, loop_id, last_heartbeat, last_status, updated_at)
       VALUES ($1, $2, NOW(), $3, NOW())
       ON CONFLICT (agent_id) DO UPDATE SET
         loop_id = EXCLUDED.loop_id,
         last_heartbeat = NOW(),
         last_status = EXCLUDED.last_status,
         updated_at = NOW()`,
      [agentId, loopId || null, status || null]
    );
  } catch (e: any) {
    // Swallow — heartbeat failures must never break the scheduler
    console.warn('[Heartbeat] writeHeartbeat failed:', e.message);
  }
}
