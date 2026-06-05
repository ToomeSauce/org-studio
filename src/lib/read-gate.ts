/**
 * #1624 (T-F) — shared read-cluster auth gates (from #1610 audit F-P4/F-P5).
 *
 * A cluster of GET endpoints historically returned tenant-sensitive data with
 * NO auth. This module centralizes the gate so every read endpoint shares one
 * definition (instead of bespoke per-route checks), mirroring the pattern that
 * `/api/memory/search` already shipped (`gate()` there).
 *
 * Two gates, per Henry's 2026-06-04 ruling on #1610 §4.7:
 *
 *  - cloudReadGate  (F-P5 cluster): CONDITIONAL. Require auth only in "cloud
 *    mode" = DATABASE_URL set AND ALLOW_ANONYMOUS_READS !== 'true'. OSS/
 *    localhost (no DB, or anon-reads opt-in) stays open. Same predicate as
 *    the store GET and /api/memory/search, so behavior is uniform.
 *
 *  - sensitiveReadGate  (F-P4: /api/memory, /api/docs): UNCONDITIONAL w.r.t.
 *    the anon-reads escape hatch. Require auth whenever DATABASE_URL is set,
 *    REGARDLESS of ALLOW_ANONYMOUS_READS — memory/doc content is credential-
 *    adjacent, so the anon-reads bypass must NOT open it. In pure file/OSS
 *    mode (no DATABASE_URL) there is no auth system and these stay open, so
 *    localhost behavior is unchanged.
 *
 * Both delegate the actual credential check to `authenticateRequest`, which:
 *   - returns null (allow) for a valid session cookie or valid global/agent token,
 *   - returns a 401 NextResponse when ORG_STUDIO_API_KEY is set but no/!bad creds,
 *   - returns null (allow) when nothing is configured (localhost dev).
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';

/** True when running against a real datastore (cloud/hosted), not file/OSS mode. */
export function isCloudMode(): boolean {
  return !!process.env.DATABASE_URL && process.env.ALLOW_ANONYMOUS_READS !== 'true';
}

/**
 * Conditional read gate for the F-P5 cluster (org-context, metrics endpoints,
 * stats, activity-feed, dispatch-health, roadmap health). Returns a 401 response
 * to short-circuit with, or null to proceed.
 */
export async function cloudReadGate(req: NextRequest): Promise<NextResponse | null> {
  if (isCloudMode()) {
    const denied = await authenticateRequest(req);
    if (denied) return denied; // 401 when neither session nor bearer present/valid
  }
  return null;
}

/**
 * Unconditional read gate for the F-P4 sensitive cluster (/api/memory, /api/docs).
 * Requires auth whenever a datastore is configured, IGNORING the
 * ALLOW_ANONYMOUS_READS escape hatch. Returns a 401 response or null.
 */
export async function sensitiveReadGate(req: NextRequest): Promise<NextResponse | null> {
  if (process.env.DATABASE_URL) {
    const denied = await authenticateRequest(req);
    if (denied) return denied;
  }
  return null;
}

/**
 * Headers for INTERNAL server-to-server fetches that hit a now-gated read
 * endpoint (e.g. agent-comparison/org-context/coaching-insights/weekly-digest
 * calling /api/metrics/*). Gating those endpoints (above) would otherwise 401
 * these internal calls in cloud mode.
 *
 * We attach the global API-key bearer when it is configured, so the internal
 * call authenticates through the SAME `authenticateRequest` path as any other
 * caller — no new, spoofable bypass. (`X-Internal-Request` is kept for any
 * existing logging/telemetry that keys off it, but it is NOT an auth bypass.)
 * In OSS/file mode (no key) the gate is open anyway, so the plain header is
 * sufficient and behavior is unchanged.
 */
export function internalAuthHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { 'X-Internal-Request': 'true', ...(extra || {}) };
  const key = process.env.ORG_STUDIO_API_KEY;
  if (key) headers['Authorization'] = `Bearer ${key}`;
  return headers;
}
