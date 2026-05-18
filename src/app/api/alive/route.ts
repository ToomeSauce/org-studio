// no-auth: public liveness probe (#1386 audit)
/**
 * GET /api/alive — Ultra-cheap liveness/readiness probe.
 *
 * Returns 200 + a tiny JSON payload. Does NOT touch the database,
 * the store, or any other dependency — existence of this response
 * means the Node process is up and Next.js is serving routes.
 *
 * Used by Azure Container Apps startup/liveness/readiness probes.
 * Do not replace /api/health (which is the dashboard-facing deep
 * health check) with this — the two serve different audiences.
 *
 * Filed as part of #1112 follow-up after the "legion" node image-pull
 * stall on 2026-04-24 where the revision spent 20+ minutes in
 * Activating because no explicit probe was configured.
 */
import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({ ok: true, sha: process.env.NEXT_PUBLIC_BUILD_SHA || 'dev' });
}
