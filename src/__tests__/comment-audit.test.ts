/**
 * #1506 — comment-author audit logging.
 *
 * Background: the 2026-05-21 incident showed a spoofed "Basil" comment caused
 * a bad PR merge. We now capture authentication-side metadata on every
 * comment write (authMethod, userId, tokenId, short apiKey hash, requestIp,
 * userAgent, requestedAuthor BEFORE canonicalization, capturedAt) so we can
 * answer "who actually called the API?" after the fact.
 *
 * Security contract:
 *   - auditMeta is persisted server-side only (Postgres: in the comment row's
 *     `data` JSONB bag under `data.audit`; FileStoreProvider: inline on the
 *     comment object — it's a dev-only store, so no exposure risk).
 *   - auditMeta is NEVER returned to clients via /api/store responses
 *     (addComment, listComments, or the GET snapshot). The route layer runs
 *     a defense-in-depth `stripAuditMeta` over every comment going out.
 *
 * These tests exercise the addComment + listComments POST handlers with
 * mocked auth + workspace + provider so we don't need a real DB or Next
 * server. The mocks are intentionally minimal — we only assert on the
 * audit-related behavior.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mock state — must be defined before vi.mock() factories run ──
const mockAuth = vi.hoisted(() => ({
  ctx: {
    userId: null as string | null,
    method: 'apikey' as 'session' | 'apikey' | 'noauth' | 'agent-token',
    tokenId: undefined as string | undefined,
    tokenScope: undefined as 'read' | 'write' | undefined,
  },
}));

const mockProvider = vi.hoisted(() => ({
  comments: [] as any[],
  addCommentImpl: vi.fn(async (_scope: any, comment: any) => {
    mockProvider.comments.push(comment);
    return comment;
  }),
  listCommentsImpl: vi.fn(async () => {
    // Simulate Postgres listComments: explicit field map, no `data` field
    // surfaced (the real provider does the same). This is what the route
    // layer then runs through stripAuditMeta as defense-in-depth.
    return mockProvider.comments.map((c) => ({
      id: c.id,
      author: c.author,
      content: c.content,
      createdAt: c.createdAt,
      type: c.type,
      scope: c.scope,
    }));
  }),
  updateTask: vi.fn(async () => {}),
}));

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return {
    ...actual,
    authenticateRequest: vi.fn(async () => null),
    authenticateRequestWithContext: vi.fn(async () => ({ context: { ...mockAuth.ctx } })),
    authenticateGetRequest: vi.fn(async () => null),
    requireWriteScope: actual.requireWriteScope,
  };
});

vi.mock('@/lib/workspace-auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/workspace-auth')>('@/lib/workspace-auth');
  return {
    ...actual,
    resolveWorkspaceContext: vi.fn(async () => ({
      context: { id: 'test-ws', name: 'Test Workspace' },
    })),
    filterByWorkspace: (arr: any[]) => arr,
    stampWorkspace: (obj: any) => obj,
    belongsToWorkspace: () => true,
  };
});

vi.mock('@/lib/store-provider', async () => {
  return {
    getStoreProvider: () => ({
      read: async () => ({
        projects: [],
        tasks: [{ id: 'k1sdreobmpfpuoph', title: 'Audit Test', projectId: 'p1', workspaceId: 'test-ws' }],
        settings: { teammates: [
          { name: 'Basil', isHuman: true, agentId: 'basil' },
          { name: 'Mikey', agentId: 'mikey' },
        ] },
        activeWorkspace: 'test-ws',
      }),
      addComment: mockProvider.addCommentImpl,
      listComments: mockProvider.listCommentsImpl,
      updateTask: mockProvider.updateTask,
    }),
    getStoreProviderAllWorkspaces: () => ({ read: async () => ({ projects: [], tasks: [], settings: {} }) }),
  };
});

// Heavy modules pulled in by the route — stub to no-ops so import doesn't blow up.
vi.mock('pg', () => ({
  Pool: class { async connect() { return { query: async () => ({ rows: [] }), release() {} }; } },
}));
vi.mock('@/lib/notification-router', () => ({ routeCommentNotifications: vi.fn(async () => ({ notified: [] })) }));
vi.mock('@/lib/mention-notifier', () => ({ parseMentions: () => [] }));
vi.mock('@/lib/telegram-guard', () => ({ isTelegramCommsEnabled: () => false }));

async function postAddComment(body: any, headers: Record<string, string> = {}): Promise<any> {
  const mod: any = await import('@/app/api/store/route');
  const req = new NextRequest('http://localhost:4501/api/store', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const res: Response = await mod.POST(req);
  return { status: res.status, body: await res.json() };
}

async function postListComments(headers: Record<string, string> = {}): Promise<any> {
  const mod: any = await import('@/app/api/store/route');
  const req = new NextRequest('http://localhost:4501/api/store', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ action: 'listComments', scope: { kind: 'task', taskId: 'k1sdreobmpfpuoph' } }),
  });
  const res: Response = await mod.POST(req);
  return { status: res.status, body: await res.json() };
}

describe('#1506 — comment audit metadata', () => {
  beforeEach(() => {
    mockProvider.comments = [];
    mockProvider.addCommentImpl.mockClear();
    mockProvider.updateTask.mockClear();
  });

  describe('apikey writes', () => {
    beforeEach(() => {
      mockAuth.ctx = { userId: null, method: 'apikey', tokenId: undefined, tokenScope: undefined };
    });

    test('captures authMethod=apikey + apiKeyHash (16 hex chars) + userId=null', async () => {
      const { status } = await postAddComment(
        {
          action: 'addComment',
          scope: { kind: 'task', taskId: 'k1sdreobmpfpuoph' },
          comment: { author: 'Mikey', content: 'apikey audit test' },
        },
        { authorization: 'Bearer my-fake-api-key-1234567890' },
      );
      expect(status).toBe(200);
      expect(mockProvider.addCommentImpl).toHaveBeenCalledOnce();
      const persisted = mockProvider.comments[0];
      expect(persisted.auditMeta).toBeDefined();
      expect(persisted.auditMeta.authMethod).toBe('apikey');
      expect(persisted.auditMeta.userId).toBeNull();
      expect(persisted.auditMeta.tokenId).toBeNull();
      expect(persisted.auditMeta.apiKeyHash).toMatch(/^[0-9a-f]{16}$/);
      expect(persisted.auditMeta.requestedAuthor).toBe('Mikey');
      expect(typeof persisted.auditMeta.capturedAt).toBe('number');
    });

    test('captures requestIp from x-forwarded-for + userAgent header', async () => {
      await postAddComment(
        {
          action: 'addComment',
          scope: { kind: 'task', taskId: 'k1sdreobmpfpuoph' },
          comment: { author: 'Mikey', content: 'with headers' },
        },
        {
          authorization: 'Bearer k',
          'x-forwarded-for': '203.0.113.5, 10.0.0.1',
          'user-agent': 'curl/8.0',
        },
      );
      const persisted = mockProvider.comments[0];
      expect(persisted.auditMeta.requestIp).toBe('203.0.113.5');
      expect(persisted.auditMeta.userAgent).toBe('curl/8.0');
    });
  });

  describe('session writes', () => {
    beforeEach(() => {
      mockAuth.ctx = { userId: 'basil', method: 'session', tokenId: undefined, tokenScope: undefined };
    });

    test("captures authMethod=session + userId='basil'; no apiKeyHash", async () => {
      await postAddComment({
        action: 'addComment',
        scope: { kind: 'task', taskId: 'k1sdreobmpfpuoph' },
        comment: { author: 'Basil', content: 'session test' },
      });
      const persisted = mockProvider.comments[0];
      expect(persisted.auditMeta.authMethod).toBe('session');
      expect(persisted.auditMeta.userId).toBe('basil');
      expect(persisted.auditMeta.apiKeyHash).toBeNull();
    });

    test("requestedAuthor preserved when canonicalizer rewrites 'You' → 'Basil'", async () => {
      // session auth + author='You' → resolveCommentAuthor rewrites to the
      // session user's teammate name ('Basil'); the audit row must still
      // retain the raw client-supplied 'You'.
      await postAddComment({
        action: 'addComment',
        scope: { kind: 'task', taskId: 'k1sdreobmpfpuoph' },
        comment: { author: 'You', content: 'rewrite test' },
      });
      const persisted = mockProvider.comments[0];
      expect(persisted.auditMeta.requestedAuthor).toBe('You');
      // canonical author landed on the comment itself (resolved to Basil via session userId)
      expect(persisted.author).toBe('Basil');
    });
  });

  describe('agent-token writes', () => {
    beforeEach(() => {
      mockAuth.ctx = {
        userId: 'mikey',
        method: 'agent-token',
        tokenId: 'tok_test_write_42',
        tokenScope: 'write',
      };
    });

    test("captures authMethod=agent-token + tokenId + userId=<token owner>", async () => {
      await postAddComment(
        {
          action: 'addComment',
          scope: { kind: 'task', taskId: 'k1sdreobmpfpuoph' },
          comment: { author: 'Mikey', content: 'agent token test' },
        },
        { authorization: 'Bearer per-agent-token-string' },
      );
      const persisted = mockProvider.comments[0];
      expect(persisted.auditMeta.authMethod).toBe('agent-token');
      expect(persisted.auditMeta.userId).toBe('mikey');
      expect(persisted.auditMeta.tokenId).toBe('tok_test_write_42');
      // apiKeyHash is only computed when method=apikey (per-agent tokens have
      // a stable tokenId already — no need to hash the secret separately).
      expect(persisted.auditMeta.apiKeyHash).toBeNull();
    });
  });

  describe('client response shape — defense-in-depth strip', () => {
    beforeEach(() => {
      mockAuth.ctx = { userId: null, method: 'apikey', tokenId: undefined, tokenScope: undefined };
    });

    test('addComment response does NOT include auditMeta on the returned comment', async () => {
      const { body } = await postAddComment(
        {
          action: 'addComment',
          scope: { kind: 'task', taskId: 'k1sdreobmpfpuoph' },
          comment: { author: 'Mikey', content: 'no leak please' },
        },
        { authorization: 'Bearer k' },
      );
      expect(body.ok).toBe(true);
      expect(body.comment).toBeDefined();
      expect('auditMeta' in body.comment).toBe(false);
      // And the persisted version DOES include it (audit trail intact).
      expect(mockProvider.comments[0].auditMeta).toBeDefined();
    });

    test('listComments response strips auditMeta from every returned comment', async () => {
      await postAddComment(
        {
          action: 'addComment',
          scope: { kind: 'task', taskId: 'k1sdreobmpfpuoph' },
          comment: { author: 'Mikey', content: 'one' },
        },
        { authorization: 'Bearer k' },
      );
      // Inject a synthetic auditMeta into the list response so we can prove
      // the strip path actually runs (real Postgres listComments doesn't emit
      // it, but defense-in-depth should handle any future provider that does).
      mockProvider.listCommentsImpl.mockImplementationOnce(async () =>
        mockProvider.comments.map((c) => ({
          id: c.id,
          author: c.author,
          content: c.content,
          createdAt: c.createdAt,
          type: c.type,
          scope: c.scope,
          auditMeta: { authMethod: 'apikey', userId: null }, // simulate leak
          data: { scope: c.scope, audit: { apiKeyHash: 'abcd1234' } },
        })) as any,
      );
      const { body } = await postListComments({ authorization: 'Bearer k' });
      expect(body.ok).toBe(true);
      expect(body.comments.length).toBeGreaterThan(0);
      for (const c of body.comments) {
        expect('auditMeta' in c).toBe(false);
        if (c.data) {
          expect('audit' in c.data).toBe(false);
        }
      }
    });
  });
});
