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
          'SELECT user_id, expires_at FROM org_studio_sessions WHERE token = $1',
          [sessionToken]
        );
        if (result.rows.length === 0) return null;

        const session = result.rows[0];
        const expiresAt = typeof session.expires_at === 'string' 
          ? parseInt(session.expires_at, 10) 
          : session.expires_at;
        
        if (expiresAt < Date.now()) {
          // Session expired — delete it
          await client.query('DELETE FROM org_studio_sessions WHERE token = $1', [sessionToken]);
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
          'INSERT INTO org_studio_sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
          [token, userId, expiresAt]
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
        await client.query('DELETE FROM org_studio_sessions WHERE token = $1', [sessionToken]);
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

  // Try API key
  const apiKey = process.env.ORG_STUDIO_API_KEY;
  if (apiKey) {
    const authHeader = req.headers.get('authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (token === apiKey) {
      return null; // Authenticated via API key
    }
    // If API key is configured but doesn't match, reject
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // No auth configured — allow localhost dev mode
  return null;
}

/**
 * Authenticate GET requests (reads)
 */
export async function authenticateGetRequest(req: NextRequest): Promise<NextResponse | null> {
  const apiKey = process.env.ORG_STUDIO_API_KEY;
  if (!apiKey) return null; // No auth configured
  return authenticateRequest(req);
}
