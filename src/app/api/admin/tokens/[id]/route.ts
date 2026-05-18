/**
 * DELETE /api/admin/tokens/[id] (#1383, Phase 1)
 *
 * Soft-revoke a per-agent API token. Requires global ORG_STUDIO_API_KEY.
 * Revocation is non-destructive (revoked_at timestamp) so audit trail
 * is preserved; the token cannot reauthenticate.
 */

import { NextRequest, NextResponse } from 'next/server';
import { revokeApiToken } from '@/lib/api-tokens';
import { authenticateRequestWithContext, requireWriteScope } from '@/lib/auth';

function requireAdmin(req: NextRequest): NextResponse | null {
  const adminKey = process.env.ORG_STUDIO_API_KEY;
  if (!adminKey) {
    return NextResponse.json(
      { error: 'admin_key_not_configured' },
      { status: 503 },
    );
  }
  const authHeader = req.headers.get('authorization') || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (bearer !== adminKey) {
    return NextResponse.json(
      { error: 'admin_only', message: 'This endpoint requires the global ORG_STUDIO_API_KEY (admin).' },
      { status: 401 },
    );
  }
  return null;
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const adminErr = requireAdmin(req);
  if (adminErr) return adminErr;
  // #1386 Phase 2: defense-in-depth — also enforce write scope.
  const authCtx = await authenticateRequestWithContext(req);
  if (!authCtx.error) {
    const scopeFail = requireWriteScope(authCtx.context);
    if (scopeFail) return scopeFail;
  }

  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'unsupported_in_file_mode' }, { status: 503 });
  }

  const { id } = await params;
  try {
    const ok = await revokeApiToken(id);
    if (!ok) {
      return NextResponse.json(
        { error: 'not_found_or_already_revoked', id },
        { status: 404 },
      );
    }
    return NextResponse.json({ action: 'revoked', id });
  } catch (e: any) {
    console.error('[admin/tokens DELETE] revoke failed:', e?.message);
    return NextResponse.json({ error: 'revoke_failed', message: e?.message }, { status: 500 });
  }
}
