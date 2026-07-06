/**
 * #1646 — promote/launch refusals must surface in the UI, not silently no-op.
 *
 * Two layers under test:
 *  1. shouldSurfacePromoteRefusal — the decision logic the approval-checkbox
 *     UI uses (RoadmapWithApprovalHorizon.persistApprovedVersions).
 *  2. The store route's updateComponent handler — now AWAITS the promote and
 *     returns `{ ok, promote }` so the client has something to decide on.
 *     This asserts the refusal reason propagates from
 *     promoteProjectToNextVersion through the API response (the ticket's
 *     doneWhen: refusal reason propagates to a visible UI state; the UI
 *     side is covered by layer 1 + the alert wiring).
 */
import { describe, test, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { shouldSurfacePromoteRefusal } from '@/lib/promote-refusal';

// ── Layer 1: decision logic ─────────────────────────────────────────────

describe('shouldSurfacePromoteRefusal (#1646)', () => {
  it('surfaces `project inactive` when an approval was added (the incident)', () => {
    const d = shouldSurfacePromoteRefusal(
      [], ['2026.09.01'],
      { promoted: false, reason: 'project inactive' },
    );
    expect(d.surface).toBe(true);
    expect(d.message).toContain('project inactive');
  });

  it('surfaces metric-gate refusals', () => {
    const d = shouldSurfacePromoteRefusal(
      ['1.0'], ['1.0', '1.1'],
      { promoted: false, reason: 'current version metric not met' },
    );
    expect(d.surface).toBe(true);
    expect(d.message).toContain('metric not met');
  });

  it('surfaces draft-item refusals', () => {
    const d = shouldSurfacePromoteRefusal(
      [], ['1.1'],
      { promoted: false, reason: '3 items without taskId' },
    );
    expect(d.surface).toBe(true);
  });

  it('stays quiet on benign `no next planned version` (approving ahead is normal)', () => {
    const d = shouldSurfacePromoteRefusal(
      [], ['3.0'],
      { promoted: false, reason: 'no next planned version' },
    );
    expect(d.surface).toBe(false);
  });

  it('stays quiet when the promote succeeded', () => {
    const d = shouldSurfacePromoteRefusal(
      [], ['1.1'],
      { promoted: true, to: '1.1', movedTasks: 4 },
    );
    expect(d.surface).toBe(false);
  });

  it('stays quiet when approvals were only REMOVED (retraction)', () => {
    const d = shouldSurfacePromoteRefusal(
      ['1.0', '1.1'], ['1.0'],
      { promoted: false, reason: 'project inactive' },
    );
    expect(d.surface).toBe(false);
  });

  it('stays quiet when no promote outcome is present (horizon unchanged)', () => {
    const d = shouldSurfacePromoteRefusal([], ['1.1'], undefined);
    expect(d.surface).toBe(false);
  });

  it('treats reorder-only change as no addition', () => {
    const d = shouldSurfacePromoteRefusal(
      ['1.0', '1.1'], ['1.1', '1.0'],
      { promoted: false, reason: 'project inactive' },
    );
    expect(d.surface).toBe(false);
  });
});

// ── Layer 2: route returns the promote outcome ──────────────────────────

const mockPromote = vi.hoisted(() => ({
  impl: vi.fn(async (_projectId?: any, _client?: any) => ({
    promoted: false, from: null, to: null, movedTasks: 0, reason: 'project inactive',
  })),
}));

vi.mock('@/lib/project-state', () => ({
  promoteProjectToNextVersion: (a: any, b: any) => mockPromote.impl(a, b),
}));

const mockStore = vi.hoisted(() => ({
  project: {
    id: 'proj-1646',
    name: 'Test',
    devOwner: 'Mikey',
    state: 'inactive',
    workspace_id: 'test-ws',
    components: [
      { id: 'cmp-main', name: 'Main', approvedVersions: [] as string[] },
    ],
  } as any,
}));

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return {
    ...actual,
    authenticateRequest: vi.fn(async () => null),
    authenticateRequestWithContext: vi.fn(async () => ({
      context: { userId: null, method: 'apikey', tokenScope: 'write' },
    })),
    authenticateGetRequest: vi.fn(async () => null),
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

vi.mock('@/lib/store-provider', () => ({
  getStoreProvider: () => ({
    read: async () => ({
      projects: [mockStore.project],
      tasks: [],
      settings: { teammates: [{ name: 'Mikey', agentId: 'mikey' }] },
    }),
    updateProject: vi.fn(async () => ({})),
    updateTask: vi.fn(async () => ({})),
    updateSettings: vi.fn(async () => ({})),
  }),
  getStoreProviderAllWorkspaces: () => ({
    read: async () => ({ projects: [], tasks: [], settings: {} }),
  }),
}));

vi.mock('pg', () => {
  class FakePool {
    async connect() {
      return { query: async () => ({ rows: [] }), release() {} };
    }
    async end() {}
  }
  return { default: { Pool: FakePool }, Pool: FakePool };
});
vi.mock('@/lib/notification-router', () => ({ routeCommentNotifications: vi.fn(async () => ({ notified: [] })) }));
vi.mock('@/lib/mention-notifier', () => ({ parseMentions: () => [] }));
vi.mock('@/lib/telegram-guard', () => ({ isTelegramCommsEnabled: () => false }));

async function postStore(body: any): Promise<{ status: number; json: any }> {
  const mod: any = await import('@/app/api/store/route');
  const req = new NextRequest('http://localhost:4501/api/store', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await mod.POST(req);
  return { status: res.status, json: await res.json() };
}

describe('updateComponent returns promote outcome (#1646)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgres://fake';
    mockStore.project.components = [
      { id: 'cmp-main', name: 'Main', approvedVersions: [] },
    ];
  });

  test('refusal reason propagates into the API response', async () => {
    mockPromote.impl.mockResolvedValueOnce({
      promoted: false, from: null, to: null, movedTasks: 0, reason: 'project inactive',
    });
    const { status, json } = await postStore({
      action: 'updateComponent',
      projectId: 'proj-1646',
      componentId: 'cmp-main',
      updates: { approvedVersions: ['2026.09.01'] },
    });
    expect(status).toBe(200);
    expect(json.ok).toBe(true); // approval itself persisted
    expect(json.promote).toBeDefined();
    expect(json.promote.promoted).toBe(false);
    expect(json.promote.reason).toBe('project inactive');
  });

  test('successful promote is reported too', async () => {
    mockPromote.impl.mockResolvedValueOnce({
      promoted: true, from: '1.0', to: '1.1', movedTasks: 4, reason: undefined,
    } as any);
    const { json } = await postStore({
      action: 'updateComponent',
      projectId: 'proj-1646',
      componentId: 'cmp-main',
      updates: { approvedVersions: ['1.1'] },
    });
    expect(json.ok).toBe(true);
    expect(json.promote.promoted).toBe(true);
    expect(json.promote.to).toBe('1.1');
  });

  test('promote throw is reported as a reason, not a 500', async () => {
    mockPromote.impl.mockRejectedValueOnce(new Error('pg down'));
    const { status, json } = await postStore({
      action: 'updateComponent',
      projectId: 'proj-1646',
      componentId: 'cmp-main',
      updates: { approvedVersions: ['1.1'] },
    });
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.promote.promoted).toBe(false);
    expect(json.promote.reason).toContain('promote check failed');
  });

  test('non-approval component update does not run promote', async () => {
    const { json } = await postStore({
      action: 'updateComponent',
      projectId: 'proj-1646',
      componentId: 'cmp-main',
      updates: { owner: 'Ana' },
    });
    expect(json.ok).toBe(true);
    expect(json.promote).toBeUndefined();
    expect(mockPromote.impl).not.toHaveBeenCalled();
  });

  test('end-to-end decision: route outcome + helper => surfaced message', async () => {
    mockPromote.impl.mockResolvedValueOnce({
      promoted: false, from: null, to: null, movedTasks: 0, reason: 'project inactive',
    });
    const { json } = await postStore({
      action: 'updateComponent',
      projectId: 'proj-1646',
      componentId: 'cmp-main',
      updates: { approvedVersions: ['2026.09.01'] },
    });
    const decision = shouldSurfacePromoteRefusal([], ['2026.09.01'], json.promote);
    expect(decision.surface).toBe(true);
    expect(decision.message).toBe('Approved, but launch did not start: project inactive');
  });
});
