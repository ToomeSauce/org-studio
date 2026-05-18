// #1387 Slice B.1 — test-only endpoint for requireWorkspaceRole.
//
// Mounted ONLY when ORG_STUDIO_TEST_HOOKS=1. In any other environment the
// endpoint returns 404, so this cannot leak the helper to production.
//
// Purpose: gives scripts/test-workspace-role-gate.mjs a deterministic surface
// to probe each branch of requireWorkspaceRole without needing to wire the
// gate into a real (B.2) endpoint yet. Once B.2 lands, the live endpoint
// tests subsume this probe — but the helper-level test remains useful for
// regression coverage on the helper's contract.
import { NextRequest, NextResponse } from 'next/server';
import { requireWorkspaceRole, WorkspaceRole } from '@/lib/workspace-auth';

function notFound() {
  return NextResponse.json({ error: 'not_found' }, { status: 404 });
}

export async function GET(req: NextRequest) {
  if (process.env.ORG_STUDIO_TEST_HOOKS !== '1') return notFound();

  const url = new URL(req.url);
  const minRole = (url.searchParams.get('minRole') || 'member') as WorkspaceRole;
  const workspaceId = url.searchParams.get('workspaceId') || 'default-workspace';

  const result = await requireWorkspaceRole(req, workspaceId, minRole);
  if (!result.allowed) {
    // Mirror the helper's prepared response so the test can assert on the
    // shape it would return in a real call site.
    return result.response;
  }
  return NextResponse.json({
    allowed: true,
    via: result.via,
    userId: result.userId,
    role: result.role ?? null,
  });
}
