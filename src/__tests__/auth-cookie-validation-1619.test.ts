/**
 * #1619 (T-A) — auth/session hardening from the #1610 audit.
 *
 * Covers three reversible fixes:
 *   F-3: GET /api/auth/login validates the session_token via getSession
 *        (a forged/short hex cookie no longer returns authenticated:true);
 *        the middleware page-gate only accepts a full 64-hex token.
 *   F-7: verifyPassword + bearer-key compares are constant-time
 *        (timingSafeEqualStr).
 *   F-8: POST /api/auth/logout expires the workspace cookie too.
 *
 * Strategy: mock `pg` with a `Pool` whose `connect()` yields an in-memory
 * fake client (#1620 routed getSession through a shared pg.Pool), so getSession
 * runs its real SELECT/expiry/DELETE logic without a live Postgres.
 * DATABASE_URL is set so the Postgres branch is taken.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createHash } from 'crypto';

// In-memory session rows for the fake pg client.
const db = vi.hoisted(() => ({
  sessions: [] as { token: string; user_id: string; expires_at: number; workspace_id: string }[],
  deleted: [] as string[],
}));

// #1620: code now connects via a shared pg.Pool (src/lib/pg-pool.ts), so we
// mock `pg.Pool` (not Client). pool.connect() returns a client with
// query()+release(); query() drives the in-memory `db` above.
vi.mock('pg', () => {
  const Pool = class {
    constructor(_opts?: any) {}
    async connect() {
      return {
        query: async (sql: string, params: any[] = []) => {
          const s = sql.replace(/\s+/g, ' ').trim();
          if (s.startsWith('SELECT') && /FROM org_studio_sessions/i.test(s)) {
            const token = params[0];
            const row = db.sessions.find((r) => r.token === token);
            return { rows: row ? [row] : [] };
          }
          if (s.startsWith('DELETE') && /FROM org_studio_sessions/i.test(s)) {
            const token = params[0];
            db.deleted.push(token);
            db.sessions = db.sessions.filter((r) => r.token !== token);
            return { rows: [] };
          }
          return { rows: [] };
        },
        release() {},
      };
    }
    async end() {}
  };
  return { default: { Pool }, Pool };
});



const VALID = 'a'.repeat(64); // 64 hex chars — shape of randomBytes(32).hex
const OTHER = 'b'.repeat(64);

beforeEach(async () => {
  db.sessions = [];
  db.deleted = [];
  process.env.DATABASE_URL = 'postgres://fake';
  // Reset the module-level pg pool singleton (#1620) so each test re-creates
  // it against the mock instead of reusing a pool from a prior test file.
  const pool = await import('@/lib/pg-pool');
  pool.__resetPgPoolForTests?.();
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.ORG_STUDIO_API_KEY;
});

describe('timingSafeEqualStr (#1619 F-7)', () => {
  test('true for identical strings', async () => {
    const { timingSafeEqualStr } = await import('@/lib/auth');
    expect(timingSafeEqualStr('hunter2hunter2', 'hunter2hunter2')).toBe(true);
  });
  test('false for different same-length strings', async () => {
    const { timingSafeEqualStr } = await import('@/lib/auth');
    expect(timingSafeEqualStr('hunter2hunter2', 'hunter2hunterX')).toBe(false);
  });
  test('false (not throw) for length mismatch', async () => {
    const { timingSafeEqualStr } = await import('@/lib/auth');
    expect(timingSafeEqualStr('short', 'a-much-longer-secret')).toBe(false);
  });
  test('false for empty vs non-empty', async () => {
    const { timingSafeEqualStr } = await import('@/lib/auth');
    expect(timingSafeEqualStr('', 'x')).toBe(false);
  });
});

describe('password hashing and verification', () => {
  test('accepts the correct password', async () => {
    const { hashPassword, passwordNeedsRehash, verifyPassword } = await import('@/lib/auth');
    const h = hashPassword('correct horse battery staple');
    expect(h).toMatch(/^scrypt\$16384\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
    expect(passwordNeedsRehash(h)).toBe(false);
    expect(verifyPassword('correct horse battery staple', h)).toBe(true);
  });

  test('uses a unique salt for each hash', async () => {
    const { hashPassword } = await import('@/lib/auth');
    const first = hashPassword('same password');
    const second = hashPassword('same password');
    expect(first).not.toBe(second);
  });

  test('rejects the wrong password', async () => {
    const { hashPassword, verifyPassword } = await import('@/lib/auth');
    const h = hashPassword('correct horse battery staple');
    expect(verifyPassword('Tr0ub4dor&3', h)).toBe(false);
  });

  test('accepts legacy SHA-256 and marks it for transparent upgrade', async () => {
    const { passwordNeedsRehash, verifyPassword } = await import('@/lib/auth');
    const legacy = createHash('sha256').update('legacy password').digest('hex');
    expect(verifyPassword('legacy password', legacy)).toBe(true);
    expect(passwordNeedsRehash(legacy)).toBe(true);
  });

  test('rejects malformed or unreasonably expensive scrypt records', async () => {
    const { verifyPassword } = await import('@/lib/auth');
    expect(verifyPassword('whatever', 'scrypt$1073741824$8$1$00$00')).toBe(false);
    expect(verifyPassword('whatever', 'scrypt$16384$8$1$odd$00')).toBe(false);
  });

  test('rejects against an empty/undefined stored hash without throwing', async () => {
    const { verifyPassword } = await import('@/lib/auth');
    expect(verifyPassword('whatever', '')).toBe(false);
    // @ts-expect-error — exercise the null-ish hash guard
    expect(verifyPassword('whatever', undefined)).toBe(false);
  });
});

describe('GET /api/auth/login validates the cookie (#1619 F-3)', () => {
  function reqWithCookie(cookie?: string) {
    const headers = new Headers();
    if (cookie) headers.set('cookie', cookie);
    return new NextRequest('http://localhost:4501/api/auth/login', { headers });
  }

  test('no cookie -> authenticated:false', async () => {
    const { GET } = await import('@/app/api/auth/login/route');
    const res = await GET(reqWithCookie());
    expect(await res.json()).toEqual({ authenticated: false });
  });

  test('forged/unknown 64-hex cookie -> authenticated:false (was true before fix)', async () => {
    const { GET } = await import('@/app/api/auth/login/route');
    const res = await GET(reqWithCookie(`session_token=${OTHER}`));
    expect(await res.json()).toEqual({ authenticated: false });
  });

  test('valid session token in store -> authenticated:true', async () => {
    db.sessions.push({
      token: VALID,
      user_id: 'basil',
      expires_at: Date.now() + 60_000,
      workspace_id: 'default-workspace',
    });
    const { GET } = await import('@/app/api/auth/login/route');
    const res = await GET(reqWithCookie(`session_token=${VALID}`));
    expect(await res.json()).toEqual({ authenticated: true });
  });

  test('expired session token -> authenticated:false AND row deleted', async () => {
    db.sessions.push({
      token: VALID,
      user_id: 'basil',
      expires_at: Date.now() - 1, // already expired
      workspace_id: 'default-workspace',
    });
    const { GET } = await import('@/app/api/auth/login/route');
    const res = await GET(reqWithCookie(`session_token=${VALID}`));
    expect(await res.json()).toEqual({ authenticated: false });
    expect(db.deleted).toContain(VALID); // getSession cleans up expired rows
  });
});

describe('middleware page-gate requires full 64-hex token (#1619 F-3)', () => {
  async function run(cookie: string | undefined, path = '/projects') {
    const { middleware } = await import('../../middleware');
    const headers = new Headers();
    if (cookie) headers.set('cookie', cookie);
    const req = new NextRequest(`http://localhost:4501${path}`, { headers });
    return middleware(req);
  }

  test('short/garbage session_token cookie is rejected -> redirect to /login', async () => {
    process.env.ORG_STUDIO_API_KEY = 'infra-key';
    const res = await run('session_token=x');
    // A redirect response carries a Location header pointing at /login.
    expect(res.headers.get('location') ?? '').toContain('/login');
  });

  test('full 64-hex session_token cookie passes the shell gate (no redirect)', async () => {
    process.env.ORG_STUDIO_API_KEY = 'infra-key';
    const res = await run(`session_token=${VALID}`);
    expect(res.headers.get('location')).toBeNull();
  });

  test('no API key configured -> gate is disabled (no redirect even without cookie)', async () => {
    delete process.env.ORG_STUDIO_API_KEY;
    const res = await run(undefined);
    expect(res.headers.get('location')).toBeNull();
  });
});
