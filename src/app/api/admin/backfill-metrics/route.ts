import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';

/**
 * POST /api/metrics/backfill — Trigger metrics computation for a specific date
 * Body: { date: "YYYY-MM-DD" }
 * 
 * Uses the global computeDailyMetrics function exposed by server.mjs
 */
export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request);
  if (authError) return authError;

  try {
    const { date } = await request.json();
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: 'Invalid date format (expected YYYY-MM-DD)' }, { status: 400 });
    }

    const computeFn = (globalThis as any).__computeDailyMetrics;
    if (!computeFn) {
      return NextResponse.json({ error: 'Metrics computation not available (server.mjs not running)' }, { status: 501 });
    }

    const result = await computeFn(date);
    return NextResponse.json({ ok: true, date, agents: result || 0 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
