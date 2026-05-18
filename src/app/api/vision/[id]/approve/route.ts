// no-auth: 410-gone stub, no body processed (#1386 audit)
/**
 * POST /api/vision/[id]/approve
 *
 * QUARANTINED 2026-04-19: Part of the deprecated proposal-approval flow.
 * Approval is now expressed by moving the approval horizon
 * (`project.autonomy.approvedThrough`) directly via the roadmap UI.
 * See docs/decisions/2026-04-19-version-numbering-convention.md.
 */

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST() {
  return NextResponse.json(
    { ok: false, error: 'gone', message: 'POST /api/vision/[id]/approve has been retired. Move the approval horizon on the roadmap instead.' },
    { status: 410 }
  );
}
