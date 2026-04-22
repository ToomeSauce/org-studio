/**
 * POST /api/agent/bootstrap-ping — Record bootstrap file SHAs for an agent (#864 vector #5).
 *
 * Called by agents at session start:
 *   curl -s http://localhost:4501/api/agent/bootstrap-ping \
 *     -X POST -H 'content-type: application/json' \
 *     -d '{"agentId":"mikey","files":{"SOUL.md":"<sha256>","USER.md":"<sha256>",...}}'
 *
 * GET /api/agent/bootstrap-ping — Returns latest pings per agent.
 *   ?agent=<id>  — returns pings for a specific agent.
 *   ?drift=true  — includes drift check (compares reported vs source SHAs).
 */
import { NextRequest, NextResponse } from 'next/server';
import { recordBootstrapPing, listBootstrapPings, checkBootstrapDrift } from '@/lib/bootstrap-pings';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const agentId = String(body.agentId || body.agent || '').trim();
    const files = body.files;

    if (!agentId) {
      return NextResponse.json({ ok: false, error: 'Missing agentId' }, { status: 400 });
    }
    if (!files || typeof files !== 'object') {
      return NextResponse.json({ ok: false, error: 'Missing or invalid files object' }, { status: 400 });
    }

    const result = await recordBootstrapPing({ agentId, files });
    return NextResponse.json(result, { status: result.ok ? 200 : 500 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'Unknown error' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const agentId = url.searchParams.get('agent') || undefined;
  const driftCheck = url.searchParams.get('drift') === 'true';

  if (driftCheck && agentId) {
    const drift = await checkBootstrapDrift(agentId);
    return NextResponse.json({ ok: true, drift });
  }

  const pings = await listBootstrapPings(agentId);
  return NextResponse.json({ ok: true, pings });
}
