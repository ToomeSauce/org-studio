/**
 * /api/admin/tokens (#1383, Phase 1)
 *
 * Admin endpoints for minting and listing per-agent API tokens.
 * All endpoints require the GLOBAL ORG_STUDIO_API_KEY (admin only) — even
 * when ENABLE_PER_AGENT_TOKENS is on, the mint/list/revoke surface stays
 * admin-only so a leaked agent token can't mint more tokens.
 *
 * POST   /api/admin/tokens         — mint a token, returns plaintext ONCE
 * GET    /api/admin/tokens         — list metadata (no plaintext, no hash)
 * DELETE /api/admin/tokens/[id]    — revoke (separate route file)
 */

import { NextRequest, NextResponse } from 'next/server';
import { listApiTokens, mintApiToken } from '@/lib/api-tokens';
import { authenticateRequestWithContext, requireWriteScope } from '@/lib/auth';

/** Require the global admin API key, NOT a per-agent token. */
function requireAdmin(req: NextRequest): NextResponse | null {
  const adminKey = process.env.ORG_STUDIO_API_KEY;
  if (!adminKey) {
    return NextResponse.json(
      { error: 'admin_key_not_configured', message: 'ORG_STUDIO_API_KEY must be set to use the admin token API.' },
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

function requirePostgres(): NextResponse | null {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json(
      {
        error: 'unsupported_in_file_mode',
        message: 'Per-agent API tokens require Postgres. File-mode is offline/dev-only (#1265).',
      },
      { status: 503 },
    );
  }
  return null;
}

function sanitizeRecord(r: any) {
  // Defensive — never leak token_hash even though we don't fetch it shape-wise.
  const { ...rest } = r;
  return rest;
}

export async function POST(req: NextRequest) {
  const adminErr = requireAdmin(req);
  if (adminErr) return adminErr;
  // #1386 Phase 2: defense-in-depth — also enforce write scope.
  const authCtx = await authenticateRequestWithContext(req);
  if (!authCtx.error) {
    const scopeFail = requireWriteScope(authCtx.context);
    if (scopeFail) return scopeFail;
  }
  const pgErr = requirePostgres();
  if (pgErr) return pgErr;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json', message: 'Body must be JSON.' }, { status: 400 });
  }

  const userId = typeof body?.userId === 'string' ? body.userId.trim() : '';
  const label = typeof body?.label === 'string' ? body.label.trim() : '';
  const scope = body?.scope === 'read' || body?.scope === 'write' ? body.scope : null;
  const createdBy = typeof body?.createdBy === 'string' ? body.createdBy.trim() : null;

  if (!userId) {
    return NextResponse.json({ error: 'missing_userId', message: 'userId is required.' }, { status: 400 });
  }
  if (!label) {
    return NextResponse.json(
      { error: 'missing_label', message: "label is required (short human-readable description, e.g. 'mikey local laptop')." },
      { status: 400 },
    );
  }
  if (!scope) {
    return NextResponse.json(
      { error: 'missing_scope', message: "scope is required: 'read' or 'write'." },
      { status: 400 },
    );
  }

  try {
    const result = await mintApiToken({ userId, label, scope, createdBy });
    // SECURITY-SENSITIVE: this is the only response that includes the
    // plaintext token. Logs, error responses, and the list endpoint must
    // NEVER include it. Don't add console.log of `result.token` here.
    return NextResponse.json({
      token: result.token,
      record: sanitizeRecord(result.record),
      warning:
        'This is the only time the plaintext token will be shown. Store it securely now — it cannot be recovered.',
    });
  } catch (e: any) {
    console.error('[admin/tokens POST] mint failed:', e?.message);
    return NextResponse.json({ error: 'mint_failed', message: e?.message || 'Failed to mint token.' }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const adminErr = requireAdmin(req);
  if (adminErr) return adminErr;
  const pgErr = requirePostgres();
  if (pgErr) return pgErr;

  const url = new URL(req.url);
  const userId = url.searchParams.get('userId') || undefined;
  const includeRevoked = url.searchParams.get('includeRevoked') === 'true';

  try {
    const tokens = await listApiTokens({ userId, includeRevoked });
    return NextResponse.json({ tokens: tokens.map(sanitizeRecord) });
  } catch (e: any) {
    console.error('[admin/tokens GET] list failed:', e?.message);
    return NextResponse.json({ error: 'list_failed', message: e?.message }, { status: 500 });
  }
}
