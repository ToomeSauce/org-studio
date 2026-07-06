/**
 * POST /api/observability/host — #1643 host-signal ingestion (push side).
 *
 * Accepts CPU / event-loop-delay / memory samples from the gateway (or any
 * external host agent) and stores them in org_studio_host_samples, joinable
 * to dispatch-ledger rows by time window. The local server samples itself
 * via lib/host-sampler.mjs (direct pg); this endpoint is for hosts that
 * can't reach Postgres directly.
 *
 * Auth: standard Bearer write path (authenticateRequestWithContext) — same
 * contract as every other store mutation. Not the health-alerts HMAC: this
 * is ingestion, not alerting.
 *
 * Body: { host, source?, load1?, cpuPct?, eventLoopDelayMs?, memUsedMb?, memTotalMb? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequestWithContext, requireWriteScope } from '@/lib/auth';
import { recordHostSample } from '@/lib/dispatch-breaker';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const authCtx = await authenticateRequestWithContext(request);
  if (authCtx.error) return authCtx.error;
  const scopeFail = requireWriteScope(authCtx.context);
  if (scopeFail) return scopeFail;

  try {
    const body = await request.json();
    if (!body?.host || typeof body.host !== 'string') {
      return NextResponse.json({ error: 'Missing required field: host' }, { status: 400 });
    }
    const num = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const ok = await recordHostSample({
      host: body.host.slice(0, 128),
      source: typeof body.source === 'string' ? body.source.slice(0, 32) : 'gateway',
      load1: num(body.load1),
      cpuPct: num(body.cpuPct),
      eventLoopDelayMs: num(body.eventLoopDelayMs),
      memUsedMb: num(body.memUsedMb),
      memTotalMb: num(body.memTotalMb),
    });
    if (!ok) {
      return NextResponse.json(
        { error: 'Host-sample storage unavailable (no DATABASE_URL?)' },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
}
