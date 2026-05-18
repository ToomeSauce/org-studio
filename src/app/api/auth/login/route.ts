// no-auth: pre-auth (credentials exchange) (#1386 audit)
import { NextRequest, NextResponse } from 'next/server';
import { verifyPassword, createSession, getSessionTokenFromCookie } from '@/lib/auth';
import { getStoreProviderAllWorkspaces } from '@/lib/store-provider'; // login: pre-workspace bootstrap
import { lookupUserWorkspace, WORKSPACE_COOKIE_KEY } from '@/lib/workspace-auth';

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
    const store = await getStoreProviderAllWorkspaces().read();
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

    // Create session (30-day expiry to match workspace cookie)
    // Use username (not auto-generated user.id) so session.userId matches
    // teammate.id and workspace membership user_id (e.g. 'basil', not 'user-1713...')
    const SESSION_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
    const sessionToken = await createSession(user.username, SESSION_EXPIRY_MS);

    // Resolve workspace via membership lookup (use username to match membership user_id)
    const workspaceId = await lookupUserWorkspace(user.username);

    // Return response with session cookie + workspace_id cookie
    const response = NextResponse.json({
      ok: true,
      message: 'Logged in',
      sessionToken,
      workspaceId,
    });

    const isProduction = process.env.NODE_ENV === 'production';
    const maxAge = 30 * 24 * 60 * 60; // 30 days in seconds

    // Set secure httpOnly session cookie
    response.cookies.set({
      name: 'session_token',
      value: sessionToken,
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge,
    });

    // Set workspace_id cookie (HttpOnly, Secure-in-prod, SameSite=Lax, 30-day)
    response.cookies.set({
      name: WORKSPACE_COOKIE_KEY,
      value: workspaceId,
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge,
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
