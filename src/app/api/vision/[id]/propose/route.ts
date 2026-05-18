// no-auth: 410-gone stub, no body processed (#1386 audit)
/**
 * POST /api/vision/[id]/propose
 *
 * RETIRED 2026-05-05 (#1230): the only consumer of this endpoint was the
 * legacy `buildLaunchMessage` script that told the launched agent to
 * "draft a version proposal and send a Telegram message with
 * approve/reject buttons." That flow was abandoned in favor of roadmap-
 * level approval (approvedVersions[] checkboxes in the Org Studio UI)
 * and the launch message no longer instructs anyone to call this route.
 *
 * Kept as a 410 stub so that any stale agent invocation gets a loud,
 * obvious error rather than silently re-spawning the old loop.
 */

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST() {
  return NextResponse.json(
    {
      ok: false,
      error: 'gone',
      message:
        'POST /api/vision/[id]/propose has been retired (#1230). Version planning happens in the Org Studio roadmap UI; agents do not draft proposals. If a future flow needs version proposals, design it fresh.',
    },
    { status: 410 },
  );
}
