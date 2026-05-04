/**
 * GET /api/scheduler/status
 *
 * Read-only snapshot of scheduler dispatch state for the Dispatch Health
 * widget on /scheduler and any operator who needs to know what the
 * scheduler currently thinks is happening (#983, silent-drift audit
 * vector #4).
 *
 * Returns:
 * {
 *   now: number,
 *   triggerCooldownMs: number,
 *   inFlightAgents: string[],         // agentIds currently dispatched, awaiting completion
 *   lastTriggerByAgent: Record<agentId, ms>,
 *   outboxDepth: { queued: number, in_flight: number, failed: number, total: number } | null,
 *   lastSweep: {
 *     finishedAt, durationMs, checked, triggered,
 *     results: [{ agentId, reason, triggered }]
 *   } | null
 * }
 *
 * No write side-effects. No DB writes. Falls back gracefully when DB or
 * scheduler module hasn't initialized yet.
 */
import { NextResponse } from 'next/server';
import { getInFlightAgents } from '@/lib/runtimes/scheduler-bridge';
import { getSchedulerStateSnapshot } from '@/lib/scheduler-state';

let _pool: any = undefined; // undefined = not init, null = no DB

async function getPool(): Promise<any> {
  if (_pool !== undefined) return _pool;
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { _pool = null; return null; }
  try {
    const pg = await import('pg');
    const Pool = pg.default?.Pool || (pg as any).Pool;
    _pool = new Pool({ connectionString: dbUrl, max: 2 });
    return _pool;
  } catch {
    _pool = null;
    return null;
  }
}

async function getOutboxDepth() {
  const pool = await getPool();
  if (!pool) return null;
  try {
    const { rows } = await pool.query(
      `SELECT status, COUNT(*)::int AS n
         FROM org_studio_outbox
        WHERE workspace_id = $1
        GROUP BY status`,
      ['default-workspace'],
    );
    const out: Record<string, number> = { queued: 0, in_flight: 0, failed: 0, done: 0 };
    let total = 0;
    for (const r of rows) {
      out[r.status] = Number(r.n) || 0;
      total += Number(r.n) || 0;
    }
    return {
      queued: out.queued || 0,
      in_flight: out.in_flight || 0,
      failed: out.failed || 0,
      total,
    };
  } catch (e: any) {
    return { error: e?.message || 'outbox query failed' } as any;
  }
}

export async function GET() {
  try {
    const snap = getSchedulerStateSnapshot();
    const inFlightAgents = getInFlightAgents();
    const outboxDepth = await getOutboxDepth();

    return NextResponse.json({
      now: Date.now(),
      triggerCooldownMs: snap.triggerCooldownMs,
      inFlightAgents,
      lastTriggerByAgent: snap.lastTriggerByAgent,
      outboxDepth,
      lastSweep: snap.lastSweep,
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || 'Scheduler status check failed' },
      { status: 500 },
    );
  }
}
