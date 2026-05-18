// no-auth: 410-gone stub, no body processed (#1386 audit)
/**
 * POST /api/vision/callback
 *
 * QUARANTINED 2026-04-19: This endpoint auto-bumped `project.autonomy.autoAdvance`
 * and processed approval-mode logic that bypassed the explicit-approval-only
 * contract. See docs/decisions/2026-04-19-version-numbering-convention.md.
 *
 * Nothing in the codebase calls this endpoint. If reintroduced, must respect
 * the approval horizon (no auto-advance).
 */

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST() {
  return NextResponse.json(
    { ok: false, error: 'gone', message: 'POST /api/vision/callback has been retired.' },
    { status: 410 }
  );
}
