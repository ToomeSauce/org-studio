import { NextRequest, NextResponse } from 'next/server';
import { verifyPassword, createSession, getSessionTokenFromCookie } from '@/lib/auth';
import { getStoreProvider } from '@/lib/store-provider';

/**
 * POST /api/auth/login
 * 
 * Login with username and password.
 * On success, returns a session token as a cookie.
 * 
 * Request:
 *   { username: string, password: string }
 * 
 * Response:
 *   { ok: true, message: "Logged in", sessionToken: string }
 *   OR
 *   { error: string } (401 or 400)
 */
export async function POST(req: NextRequest) {
  try {
    const { username, password } = await req.json();

    if (!username || !password) {
      return NextResponse.json(
        { error: 'Username and password required' },
        { status: 400 }
      );
    }

    // Get users from settings
    const store = await getStoreProvider().read();
    const users = store.settings?.users || [];
    
    // Find user by username
    const user = users.find((u: any) => u.username === username);
    if (!user) {
      return NextResponse.json(
        { error: 'Invalid credentials' },
        { status: 401 }
      );
    }

    // Verify password
    if (!verifyPassword(password, user.passwordHash)) {
      return NextResponse.json(
        { error: 'Invalid credentials' },
        { status: 401 }
      );
    }

    // Create session
    const sessionToken = await createSession(user.id, 24 * 60 * 60 * 1000); // 24-hour session

    // Return response with session cookie
    const response = NextResponse.json({
      ok: true,
      message: 'Logged in',
      sessionToken,
    });

    // Set secure httpOnly cookie
    response.cookies.set({
      name: 'session_token',
      value: sessionToken,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60, // 24 hours
    });

    return response;
  } catch (e: any) {
    console.error('[Auth] Login error:', e);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/auth/login
 * Check if currently logged in
 */
export async function GET(req: NextRequest) {
  try {
    const cookieHeader = req.headers.get('cookie');
    const sessionToken = getSessionTokenFromCookie(cookieHeader);

    if (!sessionToken) {
      return NextResponse.json({ authenticated: false });
    }

    // If session is valid, we're authenticated
    return NextResponse.json({ authenticated: true });
  } catch (e: any) {
    console.error('[Auth] Check error:', e);
    return NextResponse.json({ authenticated: false });
  }
}
