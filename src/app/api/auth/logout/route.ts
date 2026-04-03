import { NextRequest, NextResponse } from 'next/server';
import { destroySession, getSessionTokenFromCookie } from '@/lib/auth';

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

    return response;
  } catch (e: any) {
    console.error('[Auth] Logout error:', e);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
