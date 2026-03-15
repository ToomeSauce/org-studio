import { NextRequest, NextResponse } from 'next/server';

/**
 * Authenticate mutation requests using a bearer token.
 *
 * If `ORG_STUDIO_API_KEY` is set, all non-GET requests must include
 * `Authorization: Bearer <key>`. If the env var is unset, auth is skipped
 * (backward-compatible for localhost development).
 *
 * @returns `null` if authenticated (or auth not configured), or a 401 NextResponse.
 */
export function authenticateRequest(req: NextRequest): NextResponse | null {
  const apiKey = process.env.ORG_STUDIO_API_KEY;

  // No key configured — skip auth (localhost dev mode)
  if (!apiKey) return null;

  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (token !== apiKey) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return null;
}
