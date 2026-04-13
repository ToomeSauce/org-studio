import { NextRequest, NextResponse } from 'next/server';
import { getStoreProvider } from '@/lib/store-provider';

/**
 * GET /api/metrics/team — Get aggregated team metrics
 * Query params: from, to
 */
export async function GET(request: NextRequest) {
  const provider = getStoreProvider();

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
