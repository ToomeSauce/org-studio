/**
 * Watchdog kill-switch endpoint (#1180).
 *
 * Pauses the heartbeat watchdog for a specific agent (or all agents) for
 * N minutes. Used during fires when the watchdog is dispatching on top of
 * an agent that's already burning the box (e.g. Gem in build-loop on
 * 2026-05-02 → 96°C thermal incident).
 *
 * Pause state is persisted in Postgres (`org_studio_watchdog_pauses`),
 * so it survives server restarts and is visible to both the Next.js TS
 * runtime and the server.mjs watchdog tick.
 *
 * POST /api/scheduler/pause-watchdog
 * Body: { agentId: string | "*", minutes: number }
 *   agentId: "*" pauses globally (all agents)
 *   minutes: 1..240 (max 4 hours)
 *
 * POST /api/scheduler/pause-watchdog
 * Body: { agentId: string, unpause: true }
 *   Clears an existing pause.
 *
 * GET /api/scheduler/pause-watchdog
 *   Lists currently active pauses.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequestWithContext, requireWriteScope } from '@/lib/auth';

const MAX_MINUTES = 240; // 4 hours hard cap

let _pool: any = undefined; // undefined = not yet checked, null = no DB

async function getPool(): Promise<any> {
  if (_pool !== undefined) return _pool;
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    _pool = null;
    return null;
  }
  try {
    const { Pool } = await import('pg');
    _pool = new (Pool as any)({ connectionString: dbUrl, max: 2 });
    return _pool;
  } catch {
    _pool = null;
    return null;
  }
}

async function ensureSchema(pool: any) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_studio_watchdog_pauses (
      agent_id TEXT PRIMARY KEY,
      until_at TIMESTAMPTZ NOT NULL
    );
  `);
}

export async function POST(request: NextRequest) {
  const authCtx = await authenticateRequestWithContext(request);
  if (authCtx.error) return authCtx.error;
  const scopeFail = requireWriteScope(authCtx.context);
  if (scopeFail) return scopeFail;

  try {
    const body = await request.json();
    const { agentId, minutes, unpause } = body || {};

    if (!agentId || typeof agentId !== 'string') {
      return NextResponse.json({ error: 'agentId is required (string or "*")' }, { status: 400 });
    }

    const pool = await getPool();
    if (!pool) {
      return NextResponse.json(
        { error: 'Watchdog pauses require Postgres (DATABASE_URL not set)' },
        { status: 503 },
      );
    }
    await ensureSchema(pool);

    if (unpause === true) {
      await pool.query(`DELETE FROM org_studio_watchdog_pauses WHERE agent_id = $1`, [agentId]);
      return NextResponse.json({ ok: true, action: 'unpaused', agentId });
    }

    const mins = Number(minutes);
    if (!Number.isFinite(mins) || mins <= 0) {
      return NextResponse.json({ error: 'minutes must be > 0' }, { status: 400 });
    }
    const clamped = Math.min(mins, MAX_MINUTES);
    const untilIso = new Date(Date.now() + clamped * 60_000).toISOString();

    await pool.query(
      `INSERT INTO org_studio_watchdog_pauses (agent_id, until_at)
       VALUES ($1, $2)
       ON CONFLICT (agent_id) DO UPDATE SET until_at = EXCLUDED.until_at`,
      [agentId, untilIso],
    );

    return NextResponse.json({
      ok: true,
      action: 'paused',
      agentId,
      minutes: clamped,
      untilIso,
      ...(clamped < mins ? { note: `Capped at ${MAX_MINUTES}m max` } : {}),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'pause-watchdog failed' }, { status: 500 });
  }
}

export async function GET() {
  try {
    const pool = await getPool();
    if (!pool) {
      return NextResponse.json({ paused: [], note: 'No DATABASE_URL — pauses unavailable' });
    }
    await ensureSchema(pool);
    // Best-effort cleanup of expired rows
    pool.query(`DELETE FROM org_studio_watchdog_pauses WHERE until_at <= NOW()`).catch(() => {});

    const { rows } = await pool.query(
      `SELECT agent_id, until_at FROM org_studio_watchdog_pauses WHERE until_at > NOW() ORDER BY until_at`,
    );
    return NextResponse.json({
      paused: rows.map((r: any) => ({
        agentId: r.agent_id,
        untilIso: r.until_at,
      })),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'GET failed' }, { status: 500 });
  }
}
