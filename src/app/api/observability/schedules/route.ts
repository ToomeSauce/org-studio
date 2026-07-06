/**
 * /api/observability/schedules — #1642 (T2) schedule registry + drift.
 *
 * GET — unified inventory of every recurring mechanism (Org Studio loops,
 * gateway crons, server.mjs internals) with cost class + last-fire, plus
 * drift findings (orphans/zombies). Persists findings so the /health page
 * and future alerting (#1643) can read the latest reconcile result.
 *
 * Query-class only by construction (ticket constraint): store read, one
 * read-only gateway RPC, one heartbeat query. Never dispatches.
 *
 * Gated by cloudReadGate (#1624 pattern).
 */

import { NextRequest, NextResponse } from 'next/server';
import { cloudReadGate } from '@/lib/read-gate';
import { getStoreProviderAllWorkspaces } from '@/lib/store-provider';
import { buildScheduleRegistry, persistFindings } from '@/lib/schedule-registry';

export const dynamic = 'force-dynamic';

async function getHeartbeats(): Promise<Record<string, { lastFire: string | null }>> {
  try {
    if (!process.env.DATABASE_URL) return {};
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    try {
      const res = await pool.query(
        `SELECT agent_id, MAX(last_heartbeat) AS last_fire
         FROM org_studio_heartbeats GROUP BY agent_id`,
      );
      const out: Record<string, { lastFire: string | null }> = {};
      for (const row of res.rows) {
        out[row.agent_id] = {
          lastFire: row.last_fire ? new Date(row.last_fire).toISOString() : null,
        };
      }
      return out;
    } finally {
      await pool.end();
    }
  } catch {
    return {}; // best-effort — registry still renders without heartbeat data
  }
}

export async function GET(req: NextRequest) {
  const denied = await cloudReadGate(req);
  if (denied) return denied;

  try {
    const store = await getStoreProviderAllWorkspaces().read();
    const loops = ((store.settings as any)?.loops || []).map((l: any) => ({
      agentId: l.agentId,
      enabled: !!l.enabled,
      intervalMinutes: l.intervalMinutes,
      cronJobId: l.cronJobId ?? null,
    }));

    const heartbeatsByAgent = await getHeartbeats();
    const snapshot = await buildScheduleRegistry({ loops, heartbeatsByAgent });

    // Persist the current findings snapshot (daily-reconcile semantics: every
    // read refreshes it; the server-side daily cron just GETs this endpoint).
    persistFindings(snapshot.findings, snapshot.generatedAt);

    return NextResponse.json(snapshot);
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || 'schedule registry failed' },
      { status: 500 },
    );
  }
}
