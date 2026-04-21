/**
 * POST /api/skill-install-ping — Record a skill install event for #861.
 *
 * Called from the compound npx command emitted by ORG.md:
 *   npx skills add ToomeSauce/org-studio --yes && curl -s $ORG_STUDIO_URL/api/skill-install-ping \
 *     -X POST -H 'content-type: application/json' \
 *     -d '{"agentId":"mikey","skill":"org-studio","commitHash":"<sha>"}'
 *
 * No auth — this is a passive write, high-volume, and the payload carries no secrets.
 * If payload is invalid, returns 400. Never blocks session startup.
 *
 * GET /api/skill-install-ping — returns latest install per agent (used by
 * /performance widget).
 */
import { NextRequest, NextResponse } from 'next/server';
import { recordInstall, listInstalls } from '@/lib/skill-installs';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const agentId = String(body.agentId || body.agent || '').trim();
    const skill = String(body.skill || 'org-studio').trim();
    const commitHash = body.commitHash || body.commit || body.sha || null;

    if (!agentId) {
      return NextResponse.json({ ok: false, error: 'Missing agentId' }, { status: 400 });
    }

    const result = await recordInstall({ agentId, skill, commitHash });
    return NextResponse.json(result, { status: result.ok ? 200 : 500 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'Unknown error' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const skill = url.searchParams.get('skill') || 'org-studio';
  const installs = await listInstalls({ skill });
  return NextResponse.json({ ok: true, installs });
}
