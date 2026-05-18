/**
 * #1386 Phase 2 — Parameterized write-scope sweep test.
 *
 * For every mutating endpoint behind authentication, verify that a request
 * authenticated via a read-only per-agent token gets a 403 insufficient_scope.
 *
 * Strategy: mock `@/lib/auth` so authenticateRequestWithContext returns a
 * fixed read-scope context, then dynamically import each route module and
 * invoke its handler with a minimal NextRequest. We assert ONLY on the 403
 * insufficient_scope shape — we do NOT care whether the route's downstream
 * code would succeed if scope passed.
 *
 * The `requireWriteScope` helper is the REAL implementation (we import the
 * real `@/lib/auth` for that single export); only `authenticateRequest` /
 * `authenticateRequestWithContext` are mocked.
 */

import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ── Mock @/lib/auth so any route module that calls authenticateRequest or
//    authenticateRequestWithContext gets a read-scope agent-token context.
//    requireWriteScope is the REAL implementation. ──────────────────────
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  const readCtx = {
    userId: 'mikey',
    method: 'agent-token' as const,
    tokenScope: 'read' as const,
    tokenId: 'tok_test_read',
  };
  return {
    ...actual,
    authenticateRequest: vi.fn(async () => null),
    authenticateRequestWithContext: vi.fn(async () => ({ context: readCtx })),
    authenticateGetRequest: vi.fn(async () => null),
    requireWriteScope: actual.requireWriteScope, // real implementation
  };
});

// Also stub workspace resolution so /api/store doesn't error before reaching scope.
vi.mock('@/lib/workspace-context', () => ({
  resolveRequestWorkspace: vi.fn(async () => ({ workspaceId: null, sourceColumn: null })),
  resolveWorkspaceContext: vi.fn(async () => ({ workspaceId: null })),
}));

// Stub a few heavy DB libs that route modules import at top-level so import
// itself doesn't blow up in a test environment without a DATABASE_URL.
vi.mock('pg', () => {
  return {
    Pool: class { async connect() { return { query: async () => ({ rows: [] }), release() {} }; } },
    Client: class { async connect() {} async query() { return { rows: [] }; } async end() {} },
  };
});

// next/headers requires being inside a request scope at runtime; stub it.
vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (_: string) => null,
  }),
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
}));

interface Case {
  name: string;
  path: string;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  params?: Record<string, string>;
  body?: any;
  url?: string;
}

const CASES: Case[] = [
  { name: 'store POST',                   path: '@/app/api/store/route',                                                          method: 'POST',   body: { action: 'noop' } },
  { name: 'roadmap project POST',         path: '@/app/api/roadmap/[projectId]/route',                                            method: 'POST',   params: { projectId: 'p1' }, body: { action: 'upsertVersion' } },
  { name: 'roadmap items PATCH',          path: '@/app/api/roadmap/[projectId]/versions/[version]/items/route',                   method: 'PATCH',  params: { projectId: 'p1', version: '1.0.0' }, body: {} },
  { name: 'roadmap item ticket POST',     path: '@/app/api/roadmap/[projectId]/versions/[version]/items/[itemId]/ticket/route',   method: 'POST',   params: { projectId: 'p1', version: '1.0.0', itemId: 'i1' }, body: { assignee: 'mikey' } },
  { name: 'roadmap reconcile POST',       path: '@/app/api/roadmap/reconcile/route',                                              method: 'POST',   body: {} },
  { name: 'vision doc PUT',               path: '@/app/api/vision/[id]/doc/route',                                                method: 'PUT',    params: { id: 'v1' }, body: { content: '' } },
  { name: 'kudos POST',                   path: '@/app/api/kudos/route',                                                          method: 'POST',   body: { action: 'noop' } },
  { name: 'signals POST',                 path: '@/app/api/signals/route',                                                        method: 'POST',   body: { action: 'noop' } },
  { name: 'notify comment POST',          path: '@/app/api/notify/comment/route',                                                 method: 'POST',   body: {} },
  { name: 'activity-status POST',         path: '@/app/api/activity-status/route',                                                method: 'POST',   body: { agent: 'mikey', status: 'working' } },
  { name: 'activity-status DELETE',       path: '@/app/api/activity-status/route',                                                method: 'DELETE', body: { agent: 'mikey' } },
  { name: 'scheduler POST',               path: '@/app/api/scheduler/route',                                                      method: 'POST',   body: {} },
  { name: 'scheduler pause-watchdog POST',path: '@/app/api/scheduler/pause-watchdog/route',                                       method: 'POST',   body: {} },
  { name: 'metrics agent POST',           path: '@/app/api/metrics/[agentId]/route',                                              method: 'POST',   params: { agentId: 'mikey' }, body: { date: '2026-05-18', metrics: {} } },
  { name: 'metrics weekly-digest POST',   path: '@/app/api/metrics/weekly-digest/route',                                          method: 'POST',   body: {} },
  { name: 'backups POST',                 path: '@/app/api/backups/route',                                                        method: 'POST',   body: {} },
  { name: 'outbox drain POST',            path: '@/app/api/outbox/drain/route',                                                   method: 'POST',   body: {} },
  { name: 'gateway POST',                 path: '@/app/api/gateway/route',                                                        method: 'POST',   body: { method: 'noop', params: {} } },
  { name: 'workspaces POST',              path: '@/app/api/workspaces/route',                                                     method: 'POST',   body: { action: 'noop' } },
  { name: 'skill-install-ping POST',      path: '@/app/api/skill-install-ping/route',                                             method: 'POST',   body: { agentId: 'mikey' } },
  { name: 'agent bootstrap-ping POST',    path: '@/app/api/agent/bootstrap-ping/route',                                           method: 'POST',   body: { agentId: 'mikey', files: {} } },
  { name: 'auth users POST',              path: '@/app/api/auth/users/route',                                                     method: 'POST',   body: { username: 'x', password: 'y' } },
  // Vision approve/reject/launch/propose/complete/callback are 410 stubs — covered separately, not in scope sweep.
];

function makeReq(c: Case): NextRequest {
  const url = c.url || `http://localhost:4501${c.path.replace('@/app', '').replace('/route', '')}`;
  const init: any = {
    method: c.method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer fake-read-scope-token' },
  };
  if (c.body !== undefined && c.method !== 'GET') {
    init.body = JSON.stringify(c.body);
  }
  return new NextRequest(url, init);
}

describe('#1386 write-scope sweep', () => {
  beforeAll(() => {
    // Ensure scope check actually evaluates — these env vars otherwise short-circuit.
    process.env.ORG_STUDIO_API_KEY = 'test-admin-key';
  });
  afterAll(() => {
    delete process.env.ORG_STUDIO_API_KEY;
  });

  for (const c of CASES) {
    test(`${c.name} → 403 insufficient_scope on read-only token`, async () => {
      const mod: any = await import(c.path);
      const handler = mod[c.method];
      expect(handler, `${c.path} should export ${c.method}`).toBeTypeOf('function');

      const req = makeReq(c);
      const params = c.params
        ? Promise.resolve(c.params)
        : Promise.resolve({});
      const res: Response = await handler(req, { params });

      expect(res.status, `${c.name} should be 403 (got ${res.status})`).toBe(403);
      const json: any = await res.json();
      expect(json.error).toBe('insufficient_scope');
    });
  }
});

// ── Positive test: write-scope passes through ───────────────────────────
describe('#1386 write-scope sweep — positive', () => {
  test('write-scope token at /api/store does NOT 403 on scope', async () => {
    // Re-mock auth for THIS test only to return write-scope context.
    vi.resetModules();
    vi.doMock('@/lib/auth', async () => {
      const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
      const writeCtx = {
        userId: 'mikey',
        method: 'agent-token' as const,
        tokenScope: 'write' as const,
        tokenId: 'tok_test_write',
      };
      return {
        ...actual,
        authenticateRequest: vi.fn(async () => null),
        authenticateRequestWithContext: vi.fn(async () => ({ context: writeCtx })),
        authenticateGetRequest: vi.fn(async () => null),
        requireWriteScope: actual.requireWriteScope,
      };
    });
    vi.doMock('@/lib/workspace-context', () => ({
      resolveRequestWorkspace: vi.fn(async () => ({ workspaceId: null, sourceColumn: null })),
      resolveWorkspaceContext: vi.fn(async () => ({ workspaceId: null })),
    }));
    vi.doMock('pg', () => ({
      Pool: class { async connect() { return { query: async () => ({ rows: [] }), release() {} }; } },
      Client: class { async connect() {} async query() { return { rows: [] }; } async end() {} },
    }));

    const mod: any = await import('@/app/api/store/route');
    const req = new NextRequest('http://localhost:4501/api/store', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer fake-write-scope' },
      body: JSON.stringify({ action: 'noop-unknown-action' }),
    });
    const res: Response = await mod.POST(req);
    // Scope check passes (no 403 insufficient_scope). The route may still 400
    // on unknown action; that's fine — we just don't want a scope rejection.
    if (res.status === 403) {
      const json = await res.json();
      expect(json.error).not.toBe('insufficient_scope');
    } else {
      expect(res.status).not.toBe(403);
    }
  });
});
