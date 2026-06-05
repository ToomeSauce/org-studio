/**
 * GET /api/runtimes — Discover all configured runtimes with health + agents (READ-ONLY)
 * POST /api/runtimes — Discover + scaffold new agents into teammates/loops (AUTHENTICATED)
 *
 * Returns only runtimes that are actually configured (based on env vars
 * and local detection). A fresh install with no runtimes returns an empty array.
 *
 * Historically the GET also auto-scaffolded newly discovered agents into the
 * teammate/loop store and auto-cleared loopDisabledAt on re-discovery. #1623
 * removes those mutations from the GET path entirely (F-P3): state-changing GETs
 * are wrong regardless of auth and were CSRF-able when unauthenticated. The
 * scaffolding now lives in scaffoldDiscoveredAgents() and runs only from the
 * authenticated POST below (gated by the same cloud read-gate as /api/ping).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getRuntimeRegistry } from '@/lib/runtimes/registry';
import { getStoreProvider } from '@/lib/store-provider';
import { resolveWorkspaceIdForRequest } from '@/lib/workspace-auth';
import { auditRuntimeMetadata, logMismatches } from '@/lib/runtimes/audit';
import { scaffoldDiscoveredAgents } from '@/lib/runtimes/scaffold';
import { authenticateRequestWithContext, requireWriteScope } from '@/lib/auth';
import { isCloudMode } from '@/lib/read-gate';

export async function GET(request: NextRequest) {
  try {
    const workspaceId = await resolveWorkspaceIdForRequest(request);
    const registry = await getRuntimeRegistry();

    // Discover all agents from all configured runtimes
    const allAgents = await registry.discoverAll();

    // Get health status for each runtime
    const health = await registry.healthAll();

    // #1623 / #1610 F-P3: intentionally NO store writes on GET.
    // Discovery is now read-only; teammate/loop bootstrap and loop re-enable
    // must happen through explicit authenticated mutations elsewhere.

    // Build response dynamically from whatever runtimes are registered
    const runtimes = Object.entries(health).map(([id, status]) => ({
      id,
      name: registry.getRuntimeName(id) || id,
      connected: status.connected,
      detail: status.detail,
      agents: allAgents.filter(a => a.runtime === id),
    }));

    // #1353 slice 3 — Post-discovery metadata audit. Compares
    // each discovered agent's runtime-declared model against the
    // teammate store record. Advisory only — logs warnings, exposes
    // the list via the response, never auto-writes.
    // Best-effort: any failure here must NOT break /api/runtimes,
    // which is on the dashboard's hot path.
    let runtime_metadata_mismatches: any[] = [];
    try {
      const auditStore = await getStoreProvider(workspaceId).read();
      const auditTeammates = auditStore?.settings?.teammates || [];
      runtime_metadata_mismatches = await auditRuntimeMetadata({
        agents: allAgents,
        runtimes: registry.getRuntimes(),
        teammates: auditTeammates,
      });
      logMismatches(runtime_metadata_mismatches);
    } catch (auditErr: any) {
      console.warn(
        '[Runtimes #1353] audit failed (non-fatal):',
        auditErr?.message || auditErr,
      );
    }

    return NextResponse.json({ runtimes, runtime_metadata_mismatches });
  } catch (e: any) {
    const msg = typeof e === 'string' ? e : e?.message || 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * POST /api/runtimes — discover runtimes AND scaffold newly-found agents into
 * the teammate/loop store (the side-effects formerly hidden in GET, #1623/F-P3).
 *
 * Auth: same conditional cloud gate as POST /api/ping. When DATABASE_URL is
 * configured (hosted/cloud) a real authenticated session/key with write scope
 * is required; localhost/file mode without auth configured stays open for
 * OSS/dev ergonomics. The UI agent panels call this (best-effort) so new-agent
 * bootstrap still happens — now through an intentional, authenticated mutation.
 */
export async function POST(request: NextRequest) {
  if (isCloudMode()) {
    const auth = await authenticateRequestWithContext(request);
    if (auth.error) return auth.error;
    const denied = requireWriteScope(auth.context);
    if (denied) return denied;
  }
  try {
    const workspaceId = await resolveWorkspaceIdForRequest(request);
    const registry = await getRuntimeRegistry();
    const allAgents = await registry.discoverAll();
    const scaffold = await scaffoldDiscoveredAgents(workspaceId, allAgents);
    return NextResponse.json({ ok: true, scaffold });
  } catch (e: any) {
    const msg = typeof e === 'string' ? e : e?.message || 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
