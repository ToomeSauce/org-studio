// no-auth: 410-gone stub, no body processed (#1386 audit)
/**
 * POST /api/vision/[id]/complete
 *
 * QUARANTINED 2026-04-19: This endpoint contained a parallel approval flow
 * (`approvalMode: 'per-major'`) that auto-approved minor version bumps without
 * touching `project.autonomy.approvedThrough`. That contradicts the explicit-
 * approval-only contract documented in
 * docs/decisions/2026-04-19-version-numbering-convention.md.
 *
 * The Launch button uses /api/vision/[id]/launch instead. Nothing in the
 * codebase calls /complete anymore. If a roadmap-proposal flow is reintroduced
 * later, it must respect the approval horizon (no auto-advance) and a fresh
 * design pass should be done first.
 */

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST() {
  return NextResponse.json(
    {
      ok: false,
      error: 'gone',
      message:
        'POST /api/vision/[id]/complete has been retired. The auto-approve flow violated the approval-horizon contract. Use POST /api/vision/[id]/launch to create tasks for an already-approved version.',
    },
    { status: 410 }
  );
}
