import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequestWithContext, requireWriteScope } from '@/lib/auth';
import { getStoreProvider } from '@/lib/store-provider';

/**
 * GET /api/metrics/{agentId} — Get daily metrics for an agent
 * Query params: from, to, limit, sectionId
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
  const sectionId = url.searchParams.get('sectionId') || undefined;

  try {
    const metrics = await provider.getMetrics(agentId, { from, to, limit, sectionId });
    return NextResponse.json({ agentId, metrics, count: metrics.length });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/**
 * POST /api/metrics/{agentId} — Upsert daily metrics
 * Body: { date: "YYYY-MM-DD", metrics: { ... }, sectionId?: string }
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  // #1386 Phase 2: require auth + write-scope.
  const authCtx = await authenticateRequestWithContext(request);
  if (authCtx.error) return authCtx.error;
  const scopeFail = requireWriteScope(authCtx.context);
  if (scopeFail) return scopeFail;

  const { agentId } = await params;
  const provider = getStoreProvider();

  if (!provider.upsertMetrics) {
    return NextResponse.json({ error: 'Metrics not available (requires PostgreSQL)' }, { status: 501 });
  }

  try {
    const { date, metrics, sectionId } = await request.json();
    if (!date || !metrics) {
      return NextResponse.json({ error: 'Missing date or metrics' }, { status: 400 });
    }
    const result = await provider.upsertMetrics(agentId, date, metrics, sectionId || null);
    return NextResponse.json({ ok: true, result });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
