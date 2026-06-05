import { NextRequest, NextResponse } from 'next/server';
import { cloudReadGate } from '@/lib/read-gate';
import { getStoreProvider } from '@/lib/store-provider';
import { resolveWorkspaceIdForRequest } from '@/lib/workspace-auth';

/**
 * GET /api/metrics/team — Get aggregated team metrics
 * Query params: from, to
 */
export async function GET(request: NextRequest) {
  const denied = await cloudReadGate(request); // #1624 F-P5
  if (denied) return denied;
  const workspaceId = await resolveWorkspaceIdForRequest(request);
  const provider = getStoreProvider(workspaceId);

  if (!provider.getTeamMetrics) {
    return NextResponse.json({ error: 'Metrics not available (requires PostgreSQL)' }, { status: 501 });
  }

  const url = new URL(request.url);
  const from = url.searchParams.get('from') || undefined;
  const to = url.searchParams.get('to') || undefined;

  try {
    const metrics = await provider.getTeamMetrics({ from, to });
    return NextResponse.json({ metrics, count: metrics.length });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
