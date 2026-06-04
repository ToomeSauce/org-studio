// no-auth: pre-auth (credentials exchange) (#1386 audit)
//
// #1387 A.4 — multi-workspace login selector.
//
// The endpoint is a single POST with two shapes:
//
//   1) `{ username, password }`
//        - Validate credentials.
//        - Look up the user's memberships in `org_studio_workspace_memberships`.
//        - 0 memberships  -> 500 (data error, should not happen).
//        - 1 membership   -> auto-pick: createSession with that workspace_id,
//                            set cookies, return `{ ok: true, workspaceId }`.
//        - >1 memberships -> return `{ requiresWorkspaceSelection: true,
//                                       workspaces: [{ id, name, role }, ...] }`
//                            status 200. NO session is created yet.
//
//   2) `{ username, password, workspaceId }`
//        - Re-validate credentials (defense in depth — never trust the
//          workspaceId alone).
//        - Verify the user is a member of `workspaceId`. If not -> 403.
//        - createSession(userId, ttl, workspaceId), set cookies, return
//          `{ ok: true, workspaceId }`.
//
// The credentials-re-supply shape (rather than an intermediate signed token)
// keeps the server stateless and the wire format simple. The selector UI
// just hangs onto the password in memory between the two calls.
import { NextRequest, NextResponse } from 'next/server';
import { verifyPassword, createSession, getSession, getSessionTokenFromCookie } from '@/lib/auth';
import { getStoreProviderAllWorkspaces } from '@/lib/store-provider'; // login: pre-workspace bootstrap
import {
  WORKSPACE_COOKIE_KEY,
  listUserWorkspaceMemberships,
  hasWorkspaceMembership,
} from '@/lib/workspace-auth';

const SESSION_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;            // 30 days, seconds

function setSessionCookies(
  res: NextResponse,
  sessionToken: string,
  workspaceId: string,
) {
  const isProduction = process.env.NODE_ENV === 'production';
  res.cookies.set({
    name: 'session_token',
    value: sessionToken,
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE,
  });
  res.cookies.set({
    name: WORKSPACE_COOKIE_KEY,
    value: workspaceId,
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE,
  });
}

/**
 * POST /api/auth/login
 *
 * Step 1 payload: { username, password }
 * Step 2 payload: { username, password, workspaceId }
 *
 * See module-level comment for response shapes.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { username, password, workspaceId: requestedWorkspaceId } = body || {};

    if (!username || !password) {
      return NextResponse.json(
        { error: 'Username and password required' },
        { status: 400 },
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
        { status: 401 },
      );
    }

    // Verify password (validated on BOTH steps — defense in depth)
    if (!verifyPassword(password, user.passwordHash)) {
      return NextResponse.json(
        { error: 'Invalid credentials' },
        { status: 401 },
      );
    }

    // membership lookup via org_studio_workspace_memberships
    // (listUserWorkspaceMemberships reads the same cache as
    // resolveWorkspaceContext, so it stays in sync with the rest of the app)
    const memberships = await listUserWorkspaceMemberships(user.username);

    // ── Step 2: workspaceId provided in the payload ──────────────────────
    if (requestedWorkspaceId) {
      const isMember = await hasWorkspaceMembership(
        user.username,
        requestedWorkspaceId,
      );
      // In OSS mode (no DB) the membership table is empty, but listUserWorkspaceMemberships
      // returns the default workspace. Accept that case too.
      const fallbackOk =
        memberships.length === 1 &&
        memberships[0].id === requestedWorkspaceId;
      if (!isMember && !fallbackOk) {
        return NextResponse.json(
          { error: 'Not a member of the requested workspace' },
          { status: 403 },
        );
      }

      const sessionToken = await createSession(
        user.username,
        SESSION_EXPIRY_MS,
        requestedWorkspaceId,
      );
      const response = NextResponse.json({
        ok: true,
        message: 'Logged in',
        sessionToken,
        workspaceId: requestedWorkspaceId,
      });
      setSessionCookies(response, sessionToken, requestedWorkspaceId);
      return response;
    }

    // ── Step 1: no workspaceId — decide based on membership count ────────
    if (memberships.length === 0) {
      // Data error: an authenticated user with no workspace rows. In OSS mode
      // listUserWorkspaceMemberships always returns at least the default; in
      // cloud mode this means seed/onboarding broke. Surface as 500 per spec.
      return NextResponse.json(
        {
          error:
            'Account has no workspace membership. Contact your administrator.',
        },
        { status: 500 },
      );
    }

    if (memberships.length === 1) {
      const wsId = memberships[0].id;
      const sessionToken = await createSession(
        user.username,
        SESSION_EXPIRY_MS,
        wsId,
      );
      const response = NextResponse.json({
        ok: true,
        message: 'Logged in',
        sessionToken,
        workspaceId: wsId,
      });
      setSessionCookies(response, sessionToken, wsId);
      return response;
    }

    // >1 memberships — ask the client to pick. NO session is created yet.
    return NextResponse.json(
      {
        requiresWorkspaceSelection: true,
        workspaces: memberships.map((m) => ({
          id: m.id,
          name: m.name,
          role: m.role,
        })),
      },
      { status: 200 },
    );
  } catch (e: any) {
    console.error('[Auth] Login error:', e);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

/**
 * GET /api/auth/login
 * Check if currently logged in.
 *
 * #1619 (audit F-3): previously this returned `authenticated: true` whenever a
 * `session_token` cookie was merely PRESENT, without validating it. Any
 * forged/stale hex cookie passed. Now we validate the token against the
 * session store via getSession (expiry-checked, deletes expired) and report
 * the real state.
 */
export async function GET(req: NextRequest) {
  try {
    const cookieHeader = req.headers.get('cookie');
    const sessionToken = getSessionTokenFromCookie(cookieHeader);

    if (!sessionToken) {
      return NextResponse.json({ authenticated: false });
    }

    const session = await getSession(sessionToken);
    return NextResponse.json({ authenticated: !!session });
  } catch (e: any) {
    console.error('[Auth] Check error:', e);
    return NextResponse.json({ authenticated: false });
  }
}
