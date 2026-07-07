import { NextRequest, NextResponse } from 'next/server';
import { cloudReadGate } from '@/lib/read-gate';
import { resolveWorkspaceIdForRequest } from '@/lib/workspace-auth';
import { getWorkerScorecard } from '@/lib/worker-scorecard';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const denied = await cloudReadGate(req);
  if (denied) return denied;

  const workspaceId = await resolveWorkspaceIdForRequest(req);

  const url = new URL(req.url);
  const raw = parseInt(url.searchParams.get('windowDays') || '14', 10);
  const windowDays = Math.max(1, Math.min(90, Number.isFinite(raw) ? raw : 14));

  const summary = await getWorkerScorecard(workspaceId, windowDays);
  if (!summary) {
    return NextResponse.json(
      { error: 'Worker scorecard unavailable (no DATABASE_URL?)' },
      { status: 503 },
    );
  }

  return NextResponse.json(summary);
}
