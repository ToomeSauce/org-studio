/**
 * /api/observability — #1641 (T1) system-level observability surface.
 *
 * GET — aggregate view over the dispatch ledger, model-call token capture,
 * and internal-call failure counters:
 *   - dispatches/hour per agent + source + outcome, p95 duration, concurrency
 *   - token/cost rollup by served model (unmetered calls counted separately)
 *   - internal-call failure counters (the #1640 silent-degradation class)
 *
 * Query params:
 *   ?windowMinutes=1440   default 24h, max 90 days
 *
 * Gated by cloudReadGate (#1624 F-P5 pattern) — open on localhost/OSS,
 * auth-required in cloud mode.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cloudReadGate } from '@/lib/read-gate';
import { getObservabilitySummary } from '@/lib/dispatch-ledger';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const denied = await cloudReadGate(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const raw = parseInt(url.searchParams.get('windowMinutes') || '1440', 10);
  const windowMinutes = Math.max(
    1,
    Math.min(90 * 24 * 60, Number.isFinite(raw) ? raw : 1440),
  );

  const summary = await getObservabilitySummary(windowMinutes);
  if (!summary) {
    return NextResponse.json(
      { error: 'Observability data unavailable (no DATABASE_URL?)' },
      { status: 503 },
    );
  }

  return NextResponse.json(summary);
}
