/**
 * /api/dispatch-health/[agentId] — #1184 visibility surface.
 *
 * GET — returns last-N-min outcome breakdown for the agent. Used by:
 *   - Project dashboard banner (when staleBacklog === true)
 *   - Per-ticket badge (paired with classifyBlocker on the ticket)
 *   - Operator triage ("why isn't Mikey moving?")
 *
 * Query params:
 *   ?windowMinutes=60   default 60, max 1440 (24h)
 *
 * Read-only. No auth required (matches GET-store policy).
 */

import { NextRequest, NextResponse } from 'next/server';
import { cloudReadGate } from '@/lib/read-gate';
import { getDispatchHealth } from '@/lib/dispatch-attempts';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const denied = await cloudReadGate(req); // #1624 F-P5
  if (denied) return denied;
  const { agentId } = await params;
  if (!agentId || typeof agentId !== 'string') {
    return NextResponse.json({ error: 'Missing agentId' }, { status: 400 });
  }

  const url = new URL(req.url);
  const raw = parseInt(url.searchParams.get('windowMinutes') || '60', 10);
  const windowMinutes = Math.max(
    1,
    Math.min(24 * 60, Number.isFinite(raw) ? raw : 60),
  );

  const health = await getDispatchHealth(agentId, windowMinutes);
  if (!health) {
    return NextResponse.json(
      { error: 'Health data unavailable (no DATABASE_URL?)' },
      { status: 503 },
    );
  }

  return NextResponse.json(health);
}
