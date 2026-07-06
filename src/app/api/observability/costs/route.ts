/**
 * GET /api/observability/costs — #1644 (T4: token/cost analytics rollups).
 *
 * Read-only rollup over the #1641 dispatch ledger + model-call tables:
 *   - totals (tokens, cost, cache hit rate, unmetered calls/dispatches)
 *   - byAgent / byModel (served) / bySource / byProject / byTicketType
 *   - daily trend + week-over-week per-agent cost anomalies
 *
 * Query params:
 *   ?windowDays=30    default 30, max 365
 *
 * Auth: cloudReadGate (#1624 F-P5 pattern — open on localhost/OSS,
 * auth-required in cloud mode). Workspace scoping is MANDATORY (cloud
 * launch feature): resolved per-request, never trusts a query param.
 */
import { NextRequest, NextResponse } from 'next/server';
import { cloudReadGate } from '@/lib/read-gate';
import { resolveWorkspaceIdForRequest } from '@/lib/workspace-auth';
import { getCostAnalytics } from '@/lib/cost-analytics';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const denied = await cloudReadGate(req);
  if (denied) return denied;

  const workspaceId = await resolveWorkspaceIdForRequest(req);

  const url = new URL(req.url);
  const raw = parseInt(url.searchParams.get('windowDays') || '30', 10);
  const windowDays = Math.max(1, Math.min(365, Number.isFinite(raw) ? raw : 30));

  const summary = await getCostAnalytics(workspaceId, windowDays);
  if (!summary) {
    return NextResponse.json(
      { error: 'Cost analytics unavailable (no DATABASE_URL?)' },
      { status: 503 },
    );
  }
  return NextResponse.json(summary);
}
