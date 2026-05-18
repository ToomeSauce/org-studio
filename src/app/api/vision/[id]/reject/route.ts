// no-auth: 410-gone stub, no body processed (#1386 audit)
/**
 * POST /api/vision/[id]/reject
 *
 * QUARANTINED 2026-04-19: Part of the deprecated proposal-approval flow.
 * Rejection is now implicit — if a version isn't moved into the approval
 * horizon, the agent never executes it.
 */

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST() {
  return NextResponse.json(
    { ok: false, error: 'gone', message: 'POST /api/vision/[id]/reject has been retired.' },
    { status: 410 }
  );
}
