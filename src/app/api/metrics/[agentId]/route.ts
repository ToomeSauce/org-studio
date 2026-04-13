import { NextRequest, NextResponse } from 'next/server';
import { getStoreProvider } from '@/lib/store-provider';

/**
 * GET /api/metrics/{agentId} — Get daily metrics for an agent
 * Query params: from, to, limit
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const provider = getStoreProvider();

  if (!provider.getMetrics) {
    return NextResponse.json({ error: 'Metrics not available (requires PostgreSQL)' }, { status: 501 });
  }

  const url = new URL(request.url);
  const from = url.searchParams.get('from') || undefined;
  const to = url.searchParams.get('to') || undefined;
  const limit = url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit')!) : undefined;

  try {
    const metrics = await provider.getMetrics(agentId, { from, to, limit });
    return NextResponse.json({ agentId, metrics, count: metrics.length });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/**
 * POST /api/metrics/{agentId} — Upsert daily metrics
 * Body: { date: "YYYY-MM-DD", metrics: { ... } }
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const provider = getStoreProvider();

  if (!provider.upsertMetrics) {
    return NextResponse.json({ error: 'Metrics not available (requires PostgreSQL)' }, { status: 501 });
  }

  try {
    const { date, metrics } = await request.json();
    if (!date || !metrics) {
      return NextResponse.json({ error: 'Missing date or metrics' }, { status: 400 });
    }
    const result = await provider.upsertMetrics(agentId, date, metrics);
    return NextResponse.json({ ok: true, result });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
