/**
 * #1508 — GET /api/admin/audit. Admin-only read endpoint for the comment
 * audit log that #1506 began persisting.
 *
 * Strategy: mock `pg` with an injectable fake that holds an in-memory
 * `rows[]`, then evaluate WHERE/ORDER BY/LIMIT inside the fake by parsing
 * just the bits we care about (filters surfaced as $-params). This avoids
 * needing a live Postgres while still exercising the real SQL/cursor logic
 * the route emits.
 *
 * Auth path: mock authenticateRequestWithContext via `mockAuth.ctx` to swap
 * between session/apikey/agent-token/noauth. The admin-Bearer path is
 * exercised by setting process.env.ORG_STUDIO_ADMIN_API_KEY and supplying
 * the matching Authorization header (which then flows through whatever
 * authenticateRequestWithContext returns — orthogonal to the Bearer check).
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockAuth = vi.hoisted(() => ({
  ctx: {
    userId: null as string | null,
    method: 'apikey' as 'session' | 'apikey' | 'noauth' | 'agent-token',
    tokenId: undefined as string | undefined,
    tokenScope: undefined as 'read' | 'write' | undefined,
  },
}));

// Shared row store + fake pg.
const db = vi.hoisted(() => ({
  rows: [] as any[],
  lastSql: '' as string,
  lastParams: [] as any[],
  queryError: null as any,
}));

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return {
    ...actual,
    authenticateRequestWithContext: vi.fn(async () => ({ context: { ...mockAuth.ctx } })),
  };
});

vi.mock('@/lib/workspace-auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/workspace-auth')>('@/lib/workspace-auth');
  return {
    ...actual,
    resolveWorkspaceIdForRequest: vi.fn(async () => 'test-ws'),
  };
});

vi.mock('pg', () => {
  class FakeClient {
    async query(sql: string, params: any[] = []) {
      db.lastSql = sql;
      db.lastParams = params;
      if (db.queryError) {
        const e = db.queryError;
        db.queryError = null;
        throw e;
      }
      return { rows: evaluateQuery(sql, params, db.rows) };
    }
    release() {}
  }
  class FakePool {
    async connect() { return new FakeClient(); }
    async end() {}
  }
  return { default: { Pool: FakePool }, Pool: FakePool };
});

/**
 * Minimal SQL evaluator tailored to the audit route's emitted query.
 *
 * The route always emits the same shape:
 *   SELECT ... FROM org_studio_comments c LEFT JOIN org_studio_tasks t ON ...
 *    WHERE <conjunction-of-clauses-using-$N-placeholders>
 *    ORDER BY c.created_at DESC, c.id DESC
 *    LIMIT $K
 *
 * We don't need a real SQL parser — we replay the same predicate logic in JS
 * against `rows`, using the same params the route bound. The trade-off: this
 * shadow-implements the WHERE construction, so if the route changes its
 * filter logic the test must change too. That's intentional — these tests
 * are the spec for the filter semantics.
 */
function evaluateQuery(sql: string, params: any[], rows: any[]) {
  // Detect which filters the route added by scanning the SQL text.
  const has = (snippet: string) => sql.includes(snippet);

  // Param index counter — must match the order the route binds.
  let i = 0;
  const next = () => params[i++];

  // workspace clause always first
  next(); // workspace_id param (we ignore — test rows are all in-workspace by default)

  let filterCommentId: string | undefined;
  let filterAuthor: string | undefined;
  let filterRequestedAuthor: string | undefined;
  let filterApiKeyHash: string | undefined;
  let filterTaskId: string | undefined;
  let filterSince: number | undefined;
  let filterUntil: number | undefined;
  let cursorTs: number | undefined;
  let cursorId: string | undefined;

  if (has('c.id = $')) filterCommentId = next();
  if (has('c.author = $')) filterAuthor = next();
  if (has("'requestedAuthor' = $")) filterRequestedAuthor = next();
  if (has("'apiKeyHash' = $")) filterApiKeyHash = next();
  if (has('c.task_id = $')) filterTaskId = next();
  if (has('c.created_at >= $')) filterSince = next();
  if (has('c.created_at <= $')) filterUntil = next();
  if (has('(c.created_at, c.id) <')) {
    cursorTs = next();
    cursorId = next();
  }
  const limit = next();

  let out = rows.filter((r) => {
    if (filterCommentId && r.id !== filterCommentId) return false;
    if (filterAuthor && r.author !== filterAuthor) return false;
    if (filterRequestedAuthor) {
      const ra = r.data?.audit?.requestedAuthor;
      if (ra !== filterRequestedAuthor) return false;
    }
    if (filterApiKeyHash) {
      const h = r.data?.audit?.apiKeyHash;
      if (h !== filterApiKeyHash) return false;
    }
    if (filterTaskId && r.task_id !== filterTaskId) return false;
    if (filterSince !== undefined && r.created_at < filterSince) return false;
    if (filterUntil !== undefined && r.created_at > filterUntil) return false;
    if (cursorTs !== undefined && cursorId !== undefined) {
      // strict row-wise less-than under DESC ordering
      if (r.created_at > cursorTs) return false;
      if (r.created_at === cursorTs && r.id >= cursorId) return false;
    }
    return true;
  });

  out = out.slice().sort((a, b) => {
    if (a.created_at !== b.created_at) return b.created_at - a.created_at;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });

  return out.slice(0, limit);
}

// ── Test fixtures ──────────────────────────────────────────────────────────

function makeRow(over: Partial<any> = {}): any {
  const id = over.id ?? `c-${Math.random().toString(36).slice(2, 10)}`;
  const author = over.author ?? 'Mikey';
  const requestedAuthor = over.requestedAuthor ?? author;
  return {
    id,
    scope_kind: 'task',
    task_id: over.task_id ?? 't1',
    section_id: null,
    board_project_id: null,
    dm_thread_id: null,
    author,
    content: over.content ?? 'hello',
    created_at: over.created_at ?? 1_700_000_000_000,
    data: over.data !== undefined ? over.data : {
      scope: { kind: 'task', taskId: over.task_id ?? 't1' },
      audit: {
        authMethod: over.authMethod ?? 'apikey',
        userId: over.userId ?? null,
        tokenId: null,
        apiKeyHash: over.apiKeyHash ?? '0123456789abcdef',
        requestIp: '127.0.0.1',
        userAgent: 'curl/7.88',
        requestedAuthor,
        capturedAt: over.created_at ?? 1_700_000_000_000,
      },
    },
  };
}

async function callGET(path: string, init: RequestInit = {}) {
  const { GET } = await import('@/app/api/admin/audit/route');
  const url = `http://test.local${path}`;
  const req = new NextRequest(url, init as any);
  return GET(req);
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  db.rows = [];
  db.lastSql = '';
  db.lastParams = [];
  db.queryError = null;
  mockAuth.ctx = { userId: null, method: 'apikey' as const, tokenId: undefined, tokenScope: undefined };
  process.env.DATABASE_URL = 'postgres://stub/stub';
  delete process.env.ORG_STUDIO_ADMIN_API_KEY;
  delete process.env.ORG_STUDIO_ADMIN_USER_IDS;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

// ── 1. Auth gating ─────────────────────────────────────────────────────────

describe('admin audit — auth gating', () => {
  test('403 when no auth (noauth context)', async () => {
    mockAuth.ctx = { userId: null, method: 'noauth' as const, tokenId: undefined, tokenScope: undefined };
    const res = await callGET('/api/admin/audit');
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('admin_required');
  });

  test('403 when called via global apikey (method=apikey)', async () => {
    mockAuth.ctx = { userId: null, method: 'apikey' as const, tokenId: undefined, tokenScope: undefined };
    const res = await callGET('/api/admin/audit');
    expect(res.status).toBe(403);
  });

  test('403 when called via agent-token', async () => {
    mockAuth.ctx = { userId: 'mikey', method: 'agent-token' as const, tokenId: 'tok-1', tokenScope: 'write' };
    const res = await callGET('/api/admin/audit');
    expect(res.status).toBe(403);
  });

  test('403 when session user is not in allowlist', async () => {
    process.env.ORG_STUDIO_ADMIN_USER_IDS = 'basil,henry';
    mockAuth.ctx = { userId: 'mikey', method: 'session' as const, tokenId: undefined, tokenScope: undefined };
    const res = await callGET('/api/admin/audit');
    expect(res.status).toBe(403);
  });

  test('200 with admin Bearer matching ORG_STUDIO_ADMIN_API_KEY', async () => {
    process.env.ORG_STUDIO_ADMIN_API_KEY = 'admin-secret-xyz';
    // auth method doesn't matter for this path — admin-key check is orthogonal.
    mockAuth.ctx = { userId: null, method: 'apikey' as const, tokenId: undefined, tokenScope: undefined };
    const res = await callGET('/api/admin/audit', {
      headers: { authorization: 'Bearer admin-secret-xyz' },
    });
    expect(res.status).toBe(200);
  });

  test('200 with allowlisted session userId', async () => {
    process.env.ORG_STUDIO_ADMIN_USER_IDS = 'basil,henry';
    mockAuth.ctx = { userId: 'basil', method: 'session' as const, tokenId: undefined, tokenScope: undefined };
    const res = await callGET('/api/admin/audit');
    expect(res.status).toBe(200);
  });

  test('admin Bearer with wrong value still 403', async () => {
    process.env.ORG_STUDIO_ADMIN_API_KEY = 'admin-secret-xyz';
    mockAuth.ctx = { userId: null, method: 'apikey' as const, tokenId: undefined, tokenScope: undefined };
    const res = await callGET('/api/admin/audit', {
      headers: { authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(403);
  });
});

// ── Helper for the admin-authed tests below ────────────────────────────────

function asAdmin() {
  process.env.ORG_STUDIO_ADMIN_API_KEY = 'admin-key';
}
function adminInit(): RequestInit {
  return { headers: { authorization: 'Bearer admin-key' } };
}

// ── 2-7. Filters ───────────────────────────────────────────────────────────

describe('admin audit — filters', () => {
  test('commentId filter returns the single matching comment with full audit', async () => {
    asAdmin();
    db.rows = [
      makeRow({ id: 'a' }),
      makeRow({ id: 'b', author: 'Billy', requestedAuthor: 'Basil' }),
      makeRow({ id: 'c' }),
    ];
    const res = await callGET('/api/admin/audit?commentId=b', adminInit());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.comments[0].id).toBe('b');
    expect(body.comments[0].author).toBe('Billy');
    expect(body.comments[0].requestedAuthor).toBe('Basil');
    expect(body.comments[0].audit).toMatchObject({ apiKeyHash: '0123456789abcdef', authMethod: 'apikey' });
  });

  test('requestedAuthor filter catches spoof attempts pre-canonicalization', async () => {
    asAdmin();
    db.rows = [
      makeRow({ id: '1', author: 'Mikey', requestedAuthor: 'Mikey' }),
      makeRow({ id: '2', author: 'Billy', requestedAuthor: 'Basil' }), // spoof
      makeRow({ id: '3', author: 'Ana', requestedAuthor: 'Ana' }),
    ];
    const res = await callGET('/api/admin/audit?requestedAuthor=Basil', adminInit());
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.comments[0].id).toBe('2');
    expect(body.comments[0].requestedAuthor).toBe('Basil');
    expect(body.comments[0].author).toBe('Billy'); // canonicalized
  });

  test('author filter matches canonical author', async () => {
    asAdmin();
    db.rows = [
      makeRow({ id: '1', author: 'Mikey' }),
      makeRow({ id: '2', author: 'Mikey' }),
      makeRow({ id: '3', author: 'Ana' }),
    ];
    const res = await callGET('/api/admin/audit?author=Mikey', adminInit());
    const body = await res.json();
    expect(body.count).toBe(2);
    expect(body.comments.every((c: any) => c.author === 'Mikey')).toBe(true);
  });

  test('apiKeyHash filter returns only matching comments', async () => {
    asAdmin();
    db.rows = [
      makeRow({ id: '1', apiKeyHash: 'aaaa1111bbbb2222' }),
      makeRow({ id: '2', apiKeyHash: 'cccc3333dddd4444' }),
      makeRow({ id: '3', apiKeyHash: 'aaaa1111bbbb2222' }),
    ];
    const res = await callGET('/api/admin/audit?apiKeyHash=aaaa1111bbbb2222', adminInit());
    const body = await res.json();
    expect(body.count).toBe(2);
    expect(body.comments.map((c: any) => c.id).sort()).toEqual(['1', '3']);
  });

  test('time range (since + until) is combinable', async () => {
    asAdmin();
    db.rows = [
      makeRow({ id: 'old', created_at: 100 }),
      makeRow({ id: 'mid', created_at: 500 }),
      makeRow({ id: 'new', created_at: 900 }),
    ];
    const res = await callGET('/api/admin/audit?since=200&until=800', adminInit());
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.comments[0].id).toBe('mid');
  });

  test('combined filters: taskId + requestedAuthor', async () => {
    asAdmin();
    db.rows = [
      makeRow({ id: '1', task_id: 'tA', requestedAuthor: 'Basil' }),
      makeRow({ id: '2', task_id: 'tB', requestedAuthor: 'Basil' }),
      makeRow({ id: '3', task_id: 'tA', requestedAuthor: 'Mikey' }),
    ];
    const res = await callGET('/api/admin/audit?taskId=tA&requestedAuthor=Basil', adminInit());
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.comments[0].id).toBe('1');
  });
});

// ── 8. Pagination ──────────────────────────────────────────────────────────

describe('admin audit — pagination', () => {
  test('250 rows with limit=100 paginates correctly across 3 pages', async () => {
    asAdmin();
    // Each row gets a distinct created_at + id so ordering is unambiguous.
    db.rows = Array.from({ length: 250 }, (_, idx) =>
      makeRow({ id: `p-${String(idx).padStart(4, '0')}`, created_at: 1_000_000 + idx }),
    );

    // Page 1
    const r1 = await callGET('/api/admin/audit?limit=100', adminInit());
    const b1 = await r1.json();
    expect(b1.count).toBe(100);
    expect(b1.truncated).toBe(true);
    expect(b1.nextCursor).toBeTruthy();
    // newest first
    expect(b1.comments[0].id).toBe('p-0249');
    expect(b1.comments[99].id).toBe('p-0150');

    // Page 2
    const r2 = await callGET(
      `/api/admin/audit?limit=100&cursor=${encodeURIComponent(b1.nextCursor)}`,
      adminInit(),
    );
    const b2 = await r2.json();
    expect(b2.count).toBe(100);
    expect(b2.truncated).toBe(true);
    expect(b2.nextCursor).toBeTruthy();
    expect(b2.comments[0].id).toBe('p-0149');
    expect(b2.comments[99].id).toBe('p-0050');

    // Page 3 (final 50)
    const r3 = await callGET(
      `/api/admin/audit?limit=100&cursor=${encodeURIComponent(b2.nextCursor)}`,
      adminInit(),
    );
    const b3 = await r3.json();
    expect(b3.count).toBe(50);
    expect(b3.truncated).toBe(false);
    expect(b3.nextCursor).toBeNull();
    expect(b3.comments[0].id).toBe('p-0049');
    expect(b3.comments[49].id).toBe('p-0000');
  });
});

// ── 9. Limit > 500 ─────────────────────────────────────────────────────────

describe('admin audit — limit guard', () => {
  test('limit=501 returns 400', async () => {
    asAdmin();
    const res = await callGET('/api/admin/audit?limit=501', adminInit());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_limit');
  });

  test('limit=0 returns 400', async () => {
    asAdmin();
    const res = await callGET('/api/admin/audit?limit=0', adminInit());
    expect(res.status).toBe(400);
  });
});

// ── 10. Pre-#1506 comments without audit ──────────────────────────────────

describe('admin audit — old comments without audit', () => {
  test('rows with data=null return audit:null and requestedAuthor:null', async () => {
    asAdmin();
    db.rows = [
      makeRow({ id: 'old1', data: null }),
      makeRow({ id: 'old2', data: { scope: { kind: 'task', taskId: 't1' } } }), // data present but no audit
      makeRow({ id: 'new1' }),
    ];
    const res = await callGET('/api/admin/audit', adminInit());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(3);
    const old1 = body.comments.find((c: any) => c.id === 'old1');
    const old2 = body.comments.find((c: any) => c.id === 'old2');
    const new1 = body.comments.find((c: any) => c.id === 'new1');
    expect(old1.audit).toBeNull();
    expect(old1.requestedAuthor).toBeNull();
    expect(old2.audit).toBeNull();
    expect(old2.requestedAuthor).toBeNull();
    expect(new1.audit).not.toBeNull();
    expect(new1.requestedAuthor).toBeTruthy();
  });
});

// ── 11. Malformed cursor ──────────────────────────────────────────────────

describe('admin audit — malformed cursor', () => {
  test('non-base64 cursor returns 400', async () => {
    asAdmin();
    const res = await callGET('/api/admin/audit?cursor=not-a-real-cursor!!!', adminInit());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_cursor');
  });

  test('base64-of-wrong-shape cursor returns 400', async () => {
    asAdmin();
    const bad = Buffer.from(JSON.stringify({ not: 'an-array' })).toString('base64');
    const res = await callGET(`/api/admin/audit?cursor=${encodeURIComponent(bad)}`, adminInit());
    expect(res.status).toBe(400);
  });
});
