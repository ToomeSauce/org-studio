/**
 * #1536 — listComments scope shorthand + error message clarity.
 *
 * The 2026-05-23 incident was: agents calling
 *   { action: 'listComments', taskId: '...' }
 * got back `{"error":"Missing scope"}` and read that as an *auth* scope
 * problem (à la #1506/#1508 audit-fix territory). It is in fact a
 * *comment-scope* shape mismatch — the action expects
 *   { scope: { kind: 'task', taskId: '...' } }
 *
 * Fix: accept `payload.taskId` as shorthand and auto-promote to the full
 * scope shape; if neither is present, return a clear error that explains
 * the actual expected shape instead of the misleading "Missing scope".
 *
 * These tests use the same mock harness as comment-audit.test.ts but are
 * isolated to keep the focus narrow.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Same mock setup pattern as comment-audit.test.ts.
const mockAuth = vi.hoisted(() => ({
  ctx: {
    userId: null as string | null,
    method: 'apikey' as 'session' | 'apikey' | 'noauth' | 'agent-token',
    tokenId: undefined as string | undefined,
    tokenScope: undefined as string | undefined,
  },
  authMiddlewareImpl: vi.fn(),
}));

const mockProvider = vi.hoisted(() => {
  const comments: any[] = [];
  return {
    comments,
    listCommentsImpl: vi.fn(async (scope: any, opts?: any) => {
      // Return only comments whose scope matches; that's enough to verify
      // the route is forwarding the resolved scope correctly.
      return comments.filter(
        (c) => c.scope?.kind === scope.kind && c.scope?.taskId === scope.taskId,
      );
    }),
  };
});

vi.mock('@/lib/auth-middleware', () => ({
  withAuth: (handler: any) => async (req: NextRequest) => {
    const ctx = { ...mockAuth.ctx };
    return handler(req, { ctx });
  },
  resolveAuthContext: vi.fn(async () => mockAuth.ctx),
}));

vi.mock('@/lib/workspace-resolver', () => ({
  resolveWorkspaceFromRequest: vi.fn(async () => ({ id: 'default-workspace', name: 'default' })),
  getDefaultWorkspaceId: vi.fn(async () => 'default-workspace'),
}));

vi.mock('@/lib/store-provider', async () => {
  const actual: any = await vi.importActual('@/lib/store-provider');
  return {
    ...actual,
    getStoreProvider: vi.fn(() => ({
      listComments: mockProvider.listCommentsImpl,
      read: vi.fn(async () => ({ tasks: [], projects: [], settings: {} })),
    })),
    getStoreProviderAllWorkspaces: vi.fn(() => ({
      listComments: mockProvider.listCommentsImpl,
      read: vi.fn(async () => ({ tasks: [], projects: [], settings: {} })),
    })),
  };
});

vi.mock('pg', () => ({
  Pool: class { async connect() { return { query: async () => ({ rows: [] }), release() {} }; } },
}));

async function postListComments(body: any): Promise<any> {
  const mod: any = await import('@/app/api/store/route');
  const req = new NextRequest('http://localhost:4501/api/store', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer fake-key' },
    body: JSON.stringify(body),
  });
  const res: Response = await mod.POST(req);
  return { status: res.status, body: await res.json() };
}

describe('#1536 — listComments scope shorthand', () => {
  beforeEach(() => {
    mockProvider.comments.length = 0;
    mockProvider.listCommentsImpl.mockClear();
    mockAuth.ctx = { userId: null, method: 'apikey', tokenId: undefined, tokenScope: undefined };
  });

  test('explicit full scope still works (backward-compat)', async () => {
    mockProvider.comments.push({
      id: 'c1', author: 'Ana', content: 'hello',
      scope: { kind: 'task', taskId: 'tA' },
    });
    const { status, body } = await postListComments({
      action: 'listComments',
      scope: { kind: 'task', taskId: 'tA' },
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.comments).toHaveLength(1);
    expect(mockProvider.listCommentsImpl).toHaveBeenCalledOnce();
    // Provider was called with the EXPLICIT scope, byte-identical.
    expect(mockProvider.listCommentsImpl.mock.calls[0][0]).toEqual({ kind: 'task', taskId: 'tA' });
  });

  test('shorthand `taskId` at top level is auto-promoted to {kind: task, taskId}', async () => {
    mockProvider.comments.push({
      id: 'c2', author: 'Mikey', content: 'shorthand works',
      scope: { kind: 'task', taskId: 'tB' },
    });
    const { status, body } = await postListComments({
      action: 'listComments',
      taskId: 'tB',
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.comments).toHaveLength(1);
    // Provider received the PROMOTED scope, not the raw shorthand.
    expect(mockProvider.listCommentsImpl.mock.calls[0][0]).toEqual({ kind: 'task', taskId: 'tB' });
  });

  test('explicit scope wins over shorthand when both present', async () => {
    mockProvider.comments.push({
      id: 'c3', author: 'Mikey', content: 'explicit wins',
      scope: { kind: 'task', taskId: 'tEXPLICIT' },
    });
    const { status } = await postListComments({
      action: 'listComments',
      taskId: 'tSHORTHAND',
      scope: { kind: 'task', taskId: 'tEXPLICIT' },
    });
    expect(status).toBe(200);
    expect(mockProvider.listCommentsImpl.mock.calls[0][0]).toEqual({ kind: 'task', taskId: 'tEXPLICIT' });
  });

  test('missing both scope and taskId returns 400 with actionable hint', async () => {
    const { status, body } = await postListComments({ action: 'listComments' });
    expect(status).toBe(400);
    expect(body.error).toBe('Missing scope');
    // The hint is the actual fix for the agent-confusion bug — it must
    // explicitly say "comment scope, not auth scope" so future readers
    // don't repeat the #1506/#1508 misdiagnosis.
    expect(body.hint).toBeDefined();
    expect(body.hint).toMatch(/comment scope.*not.*auth scope/i);
    expect(body.hint).toMatch(/scope.*kind.*task.*taskId/);
    // Mentions the #1536 shorthand so devs know they can simplify.
    expect(body.hint).toMatch(/taskId.*top level|top.level.*taskId|shorthand/i);
    // Provider must NOT be called when we bail with the error.
    expect(mockProvider.listCommentsImpl).not.toHaveBeenCalled();
  });
});
