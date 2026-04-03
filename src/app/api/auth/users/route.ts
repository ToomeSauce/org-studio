import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, hashPassword } from '@/lib/auth';
import { getStoreProvider } from '@/lib/store-provider';

/**
 * POST /api/auth/users
 * 
 * Create a new user (admin-only).
 * Requires ORG_STUDIO_API_KEY authentication.
 * 
 * Request:
 *   { username: string, password: string }
 * 
 * Response:
 *   { ok: true, user: { id, username } }
 */
export async function POST(req: NextRequest) {
  // Require API key for user management
  const authError = await authenticateRequest(req);
  if (authError) return authError;

  try {
    const { username, password } = await req.json();

    if (!username || !password) {
      return NextResponse.json(
        { error: 'Username and password required' },
        { status: 400 }
      );
    }

    const store = await getStoreProvider().read();
    const users = store.settings?.users || [];

    // Check if user already exists
    if (users.some((u: any) => u.username === username)) {
      return NextResponse.json(
        { error: 'Username already exists' },
        { status: 409 }
      );
    }

    // Create new user
    const newUser = {
      id: `user-${Date.now()}`,
      username,
      passwordHash: hashPassword(password),
    };

    users.push(newUser);

    // Update settings
    const newSettings = {
      ...store.settings,
      users,
    };

    await getStoreProvider().updateSettings(newSettings);

    return NextResponse.json({
      ok: true,
      user: {
        id: newUser.id,
        username: newUser.username,
      },
    });
  } catch (e: any) {
    console.error('[Auth] Create user error:', e);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/auth/users
 * List all users (admin-only, API key required)
 */
export async function GET(req: NextRequest) {
  // Require API key for user management
  const authError = await authenticateRequest(req);
  if (authError) return authError;

  try {
    const store = await getStoreProvider().read();
    const users = (store.settings?.users || []).map((u: any) => ({
      id: u.id,
      username: u.username,
    }));

    return NextResponse.json({ users });
  } catch (e: any) {
    console.error('[Auth] List users error:', e);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
