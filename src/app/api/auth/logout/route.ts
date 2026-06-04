// no-auth: pre-auth (clears session cookie) (#1386 audit)
import { NextRequest, NextResponse } from 'next/server';
import { destroySession, getSessionTokenFromCookie } from '@/lib/auth';
import { WORKSPACE_COOKIE_KEY } from '@/lib/workspace-auth';

/**
 * POST /api/auth/logout
 * 
 * Clear session and logout.
 */
export async function POST(req: NextRequest) {
  try {
    const cookieHeader = req.headers.get('cookie');
    const sessionToken = getSessionTokenFromCookie(cookieHeader);

    if (sessionToken) {
      await destroySession(sessionToken);
    }

    const response = NextResponse.json({
      ok: true,
      message: 'Logged out',
    });

    // Clear session cookie
    response.cookies.set({
      name: 'session_token',
      value: '',
      maxAge: 0,
    });

    // #1619 (audit F-8): also clear the workspace cookie so a logged-out
    // browser doesn't retain its last workspace selection (which the
    // workspace resolver would otherwise pick up on the next request).
    response.cookies.set({
      name: WORKSPACE_COOKIE_KEY,
      value: '',
      maxAge: 0,
    });

    return response;
  } catch (e: any) {
    console.error('[Auth] Logout error:', e);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
