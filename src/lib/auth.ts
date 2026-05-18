import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Simple session-based authentication for Org Studio.
 * 
 * Supports three authentication methods (in order of preference):
 * 1. Session cookie (for browser access)
 * 2. Bearer API key token (for programmatic access)
 * 3. No auth (localhost dev mode, when ORG_STUDIO_API_KEY is not set)
 * 
 * Sessions can be persisted to Postgres (if DATABASE_URL set) or disk.
 */

const SESSIONS_FILE = join(process.cwd(), 'data', 'sessions.json');

// In-memory cache backed by file persistence (for non-Postgres)
let sessions = new Map<string, { userId: string; expiresAt: number }>();
let sessionsLoaded = false;

/** Load sessions from disk into memory (once, for non-Postgres mode) */
function loadSessions(): void {
  if (sessionsLoaded) return;
  sessionsLoaded = true;
  try {
    if (existsSync(SESSIONS_FILE)) {
      const raw = readFileSync(SESSIONS_FILE, 'utf-8');
      const entries: [string, { userId: string; expiresAt: number }][] = JSON.parse(raw);
      const now = Date.now();
      // Only load non-expired sessions
      for (const [token, session] of entries) {
        if (session.expiresAt > now) {
          sessions.set(token, session);
        }
      }
    }
  } catch (e) {
    console.warn('[auth] Failed to load sessions from disk:', e);
    // Start fresh — not fatal
  }
}

/** Persist sessions to disk (debounced — fire-and-forget) */
let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persistSessions(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      const entries = Array.from(sessions.entries());
      writeFileSync(SESSIONS_FILE, JSON.stringify(entries), 'utf-8');
    } catch (e) {
      console.warn('[auth] Failed to persist sessions:', e);
    }
  }, 200); // debounce 200ms
}

export interface AuthUser {
  id: string;
  username: string;
  passwordHash: string;
}

/**
 * Hash a password (simple SHA-256)
 */
export function hashPassword(password: string): string {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(password).digest('hex');
}

/**
 * Verify a password against a hash
 */
export function verifyPassword(password: string, hash: string): boolean {
  return hashPassword(password) === hash;
}

/**
 * Create a session token
 */
export function createSessionToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Get a session (async to support Postgres)
 */
export async function getSession(sessionToken: string): Promise<{ userId: string } | null> {
  // Try Postgres first (if DATABASE_URL is set)
  if (process.env.DATABASE_URL) {
    try {
      const pg = await import('pg');
      const client = new pg.Client(process.env.DATABASE_URL);
      await client.connect();
      try {
        const result = await client.query(
          'SELECT user_id, expires_at FROM org_studio_sessions WHERE token = $1 AND workspace_id = $2',
          [sessionToken, 'default-workspace'] // TODO(v0.17-multi-workspace): sessions are workspace-scoped
        );
        if (result.rows.length === 0) return null;

        const session = result.rows[0];
        const expiresAt = typeof session.expires_at === 'string' 
          ? parseInt(session.expires_at, 10) 
          : session.expires_at;
        
        if (expiresAt < Date.now()) {
          // Session expired — delete it
          await client.query('DELETE FROM org_studio_sessions WHERE token = $1 AND workspace_id = $2', [sessionToken, 'default-workspace']);
          return null;
        }

        return { userId: session.user_id };
      } finally {
        await client.end();
      }
    } catch (pgErr: any) {
      console.error('[getSession] Postgres error:', pgErr.message);
      // Fall through to file-based
    }
  }

  // Fall back to file-based sessions
  loadSessions();
  const session = sessions.get(sessionToken);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(sessionToken);
    persistSessions();
    return null;
  }
  return { userId: session.userId };
}

/**
 * Create a session (async to support Postgres)
 */
export async function createSession(
  userId: string,
  expiresIn: number = 24 * 60 * 60 * 1000
): Promise<string> {
  const token = createSessionToken();
  const expiresAt = Date.now() + expiresIn;

  // Try Postgres first
  if (process.env.DATABASE_URL) {
    try {
      const pg = await import('pg');
      const client = new pg.Client(process.env.DATABASE_URL);
      await client.connect();
      try {
        await client.query(
          'INSERT INTO org_studio_sessions (token, user_id, expires_at, workspace_id) VALUES ($1, $2, $3, $4)',
          [token, userId, expiresAt, 'default-workspace'] // TODO(v0.17-multi-workspace): sessions are workspace-scoped
        );
        return token;
      } finally {
        await client.end();
      }
    } catch (pgErr: any) {
      console.error('[createSession] Postgres error:', pgErr.message);
      // Fall through to file-based
    }
  }

  // Fall back to file-based
  loadSessions();
  sessions.set(token, { userId, expiresAt });
  persistSessions();
  return token;
}

/**
 * Destroy a session (async to support Postgres)
 */
export async function destroySession(sessionToken: string): Promise<void> {
  // Try Postgres first
  if (process.env.DATABASE_URL) {
    try {
      const pg = await import('pg');
      const client = new pg.Client(process.env.DATABASE_URL);
      await client.connect();
      try {
        await client.query('DELETE FROM org_studio_sessions WHERE token = $1 AND workspace_id = $2', [sessionToken, 'default-workspace']);
        return;
      } finally {
        await client.end();
      }
    } catch (pgErr: any) {
      console.error('[destroySession] Postgres error:', pgErr.message);
      // Fall through to file-based
    }
  }

  // Fall back to file-based
  loadSessions();
  sessions.delete(sessionToken);
  persistSessions();
}

/**
 * Extract session token from cookies
 */
export function getSessionTokenFromCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/session_token=([a-f0-9]+)/);
  return match ? match[1] : null;
}

// ── User ID Resolution ─────────────────────────────────────────────────
// Browser sessions created before the login fix store auto-generated ids
// (user-{timestamp}) which don't match workspace membership user_ids
// (teammate usernames like 'basil'). This resolver maps them back.

let _userIdMap: Map<string, string> | null = null;
let _userIdMapTs = 0;
const USER_ID_MAP_TTL = 60_000; // 1 minute

export async function resolveSessionUserId(rawUserId: string): Promise<string> {
  // Only resolve auto-generated ids; usernames pass through
  if (!rawUserId.startsWith('user-')) return rawUserId;

  if (!_userIdMap || Date.now() - _userIdMapTs > USER_ID_MAP_TTL) {
    try {
      const { getStoreProvider } = await import('@/lib/store-provider');
      const store = await getStoreProvider().read();
      const users = store.settings?.users || [];
      _userIdMap = new Map();
      for (const u of users as any[]) {
        if (u.id && u.username) {
          _userIdMap.set(u.id, u.username);
        }
      }
      _userIdMapTs = Date.now();
    } catch {
      return rawUserId;
    }
  }
  return _userIdMap.get(rawUserId) || rawUserId;
}

/** Bust user ID resolution cache (call after user settings change) */
export function invalidateUserIdCache(): void {
  _userIdMap = null;
  _userIdMapTs = 0;
}

/** Result of authenticateRequestWithContext — includes userId and auth method.
 *
 * NOTE: `userId` is intentionally `string | null`. For apikey and noauth, there
 * is no real human owner — the global API key is shared infrastructure, and
 * loopback dev mode has no logged-in user. Earlier versions hardcoded
 * `userId: 'basil'` for both, which caused #1217 Bug B (comment authors
 * silently rewritten to 'Basil' for any agent posting via Bearer token without
 * an explicit `comment.author`). Callers that need a UI-display fallback may
 * use `userId ?? 'basil'`, but ownership/attribution writes must NEVER do this.
 *
 * #1383: per-agent tokens (method === 'agent-token') DO carry a real userId
 * (the token's owner) and a scope ('read' | 'write'). Write endpoints should
 * use requireWriteScope(ctx) to reject read-only tokens.
 */
export interface AuthContext {
  userId: string | null;
  method: 'session' | 'apikey' | 'noauth' | 'agent-token';
  /** Only set when method === 'agent-token' (#1383). */
  tokenScope?: 'read' | 'write';
  /** Only set when method === 'agent-token' (#1383). For audit logging. */
  tokenId?: string;
}

/**
 * Guard for write endpoints: if the caller authenticated via a read-only
 * per-agent token, return a 403. All other auth methods pass through (the
 * global apikey is admin, sessions are full-scope, noauth is dev-mode).
 * Returns null on pass, NextResponse on reject.
 */
export function requireWriteScope(ctx: AuthContext): NextResponse | null {
  if (ctx.method === 'agent-token' && ctx.tokenScope === 'read') {
    return NextResponse.json(
      { error: 'insufficient_scope', message: 'This token has read-only scope. Mint a write-scope token for this endpoint.' },
      { status: 403 },
    );
  }
  return null;
}

/**
 * Authenticate a request using:
 * 1. Session cookie (browser)
 * 2. Bearer API key token (programmatic)
 * 3. No auth if ORG_STUDIO_API_KEY is not configured
 *
 * @returns `null` if authenticated, or a 401 NextResponse if not
 */
export async function authenticateRequest(req: NextRequest): Promise<NextResponse | null> {
  // Try session cookie first
  const cookieHeader = req.headers.get('cookie');
  const sessionToken = getSessionTokenFromCookie(cookieHeader);
  
  if (sessionToken) {
    const session = await getSession(sessionToken);
    if (session) {
      return null; // Authenticated via session cookie
    }
  }

  // Try API key (global admin) OR per-agent token (#1383, behind flag)
  const apiKey = process.env.ORG_STUDIO_API_KEY;
  const authHeader = req.headers.get('authorization') || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (apiKey || bearer) {
    if (bearer && apiKey && bearer === apiKey) {
      return null; // Authenticated via global API key
    }

    // #1383: per-agent token path (behind ENABLE_PER_AGENT_TOKENS flag).
    if (bearer) {
      try {
        const { perAgentTokensEnabled, verifyApiToken } = await import('@/lib/api-tokens');
        if (perAgentTokensEnabled()) {
          const record = await verifyApiToken(bearer);
          if (record) return null; // Authenticated via per-agent token
        }
      } catch (e) {
        console.warn('[auth] per-agent token verify failed:', (e as Error)?.message);
      }
    }

    if (apiKey) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  // No auth configured — allow localhost dev mode
  return null;
}

/**
 * Authenticate a request and return full auth context (userId + method).
 * Used by workspace enforcement to know WHO is making the request.
 *
 * @returns { error: NextResponse } on 401, or { context: AuthContext } on success
 */
export async function authenticateRequestWithContext(
  req: NextRequest,
): Promise<{ context: AuthContext; error?: never } | { context?: never; error: NextResponse }> {
  // Try session cookie first
  const cookieHeader = req.headers.get('cookie');
  const sessionToken = getSessionTokenFromCookie(cookieHeader);

  if (sessionToken) {
    const session = await getSession(sessionToken);
    if (session) {
      // Resolve legacy auto-generated ids (user-*) back to username
      // so session userId matches workspace membership user_id
      const userId = await resolveSessionUserId(session.userId);
      return { context: { userId, method: 'session' } };
    }
  }

  // Try API key (global admin) OR per-agent token (#1383, behind flag)
  const apiKey = process.env.ORG_STUDIO_API_KEY;
  const authHeader = req.headers.get('authorization') || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (apiKey || bearer) {
    if (bearer && apiKey && bearer === apiKey) {
      // Global API key has no human owner — userId is null. Callers that need
      // a workspace-membership fallback should use `?? 'basil'` themselves.
      // See #1217 Bug B for why hardcoding 'basil' here was wrong.
      return { context: { userId: null, method: 'apikey' } };
    }

    // #1383: try per-agent token. Only when the feature flag is on, to avoid
    // an extra DB roundtrip + to keep the auth surface unchanged during the
    // pre-launch period. When off, this branch is a no-op and we fall through
    // to the 401 below.
    if (bearer) {
      try {
        const { perAgentTokensEnabled, verifyApiToken } = await import('@/lib/api-tokens');
        if (perAgentTokensEnabled()) {
          const record = await verifyApiToken(bearer);
          if (record) {
            return {
              context: {
                userId: record.userId,
                method: 'agent-token',
                tokenScope: record.scope,
                tokenId: record.id,
              },
            };
          }
        }
      } catch (e) {
        // Token verify failure shouldn't 500 — just fall through to the 401.
        console.warn('[auth] per-agent token verify failed:', (e as Error)?.message);
      }
    }

    if (apiKey) {
      return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    }
  }

  // No auth configured — allow localhost dev mode. No real user; null userId.
  return { context: { userId: null, method: 'noauth' } };
}

/**
 * Authenticate GET requests (reads)
 */
export async function authenticateGetRequest(req: NextRequest): Promise<NextResponse | null> {
  const apiKey = process.env.ORG_STUDIO_API_KEY;
  if (!apiKey) return null; // No auth configured
  return authenticateRequest(req);
}
