/**
 * GET /api/org-context/refreshes
 *
 * Returns the last recorded ORG.md refresh per agent (sha, generatedAt,
 * sections, ageMs). Populated in-memory by /api/org-context on every
 * generation. Intended for the Mission Control agent-detail panel.
 *
 * Query params:
 *   ?agent=<agentId>  — return a single agent's record, or 404 if never generated.
 *   (no params)       — return the full map.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getOrgRefresh, getOrgRefreshes } from '@/lib/org-context-refresh-tracker';

function withAge<T extends { generatedAt: string }>(rec: T): T & { ageMs: number } {
  const ts = Date.parse(rec.generatedAt);
  const ageMs = Number.isFinite(ts) ? Date.now() - ts : 0;
  return { ...rec, ageMs };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get('agent');

  if (agentId) {
    const rec = getOrgRefresh(agentId);
    if (!rec) {
      return NextResponse.json(
        { error: 'No ORG.md refresh recorded for this agent', agentId },
        { status: 404 }
      );
    }
    return NextResponse.json({ agentId, ...withAge(rec) });
  }

  const all = getOrgRefreshes();
  const refreshes: Record<string, ReturnType<typeof withAge>> = {};
  for (const [key, value] of Object.entries(all)) {
    refreshes[key] = withAge(value);
  }
  return NextResponse.json({ refreshes });
}
