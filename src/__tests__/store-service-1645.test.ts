/**
 * #1645 — store-service tests.
 *
 * Verifies the shared service layer preserves the side-effects the HTTP
 * route path had, so internal callers (roadmap currentVersion sync) fire
 * identical behavior:
 *
 *  - provider.updateProject() is called (the Postgres provider emits
 *    NOTIFY org_studio_change inside it — delegation IS the NOTIFY guarantee;
 *    provider NOTIFY emission itself is covered by provider-level code).
 *  - workspace guard 403s cross-workspace writes.
 *  - devOwner change reassigns active (non-done) tasks.
 *  - inactive→active state transition re-checks promote and triggers the
 *    devOwner's agent loop (dispatch side-effect).
 *  - triggerAgentLoopService sends the internal Bearer on /api/scheduler and
 *    records an internal-call failure after final retry exhaustion.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────

const updateProjectMock = vi.fn(async () => ({}));
const updateTaskMock = vi.fn(async () => ({}));
const readMock = vi.fn(async () => makeStore());

vi.mock('@/lib/store-provider', () => ({
  getStoreProvider: vi.fn(() => ({
    read: readMock,
    updateProject: updateProjectMock,
    updateTask: updateTaskMock,
  })),
}));

const recordFailureMock = vi.fn();
vi.mock('@/lib/dispatch-ledger', () => ({
  recordInternalCallFailure: (a: any, b: any, c: any, d: any) => recordFailureMock(a, b, c, d),
}));

const promoteMock = vi.fn(async (_projectId?: any, _client?: any) => ({ promoted: false, reason: 'test' }));
vi.mock('@/lib/project-state', () => ({
  promoteProjectToNextVersion: (a: any, b: any) => promoteMock(a, b),
}));

// pg Pool used by the inactive→active promote path
const pgConnectMock = vi.fn(async () => ({ release: vi.fn() }));
vi.mock('pg', () => {
  class FakePool {
    connect = pgConnectMock;
    end = vi.fn(async () => {});
  }
  return { default: { Pool: FakePool }, Pool: FakePool };
});

// ── Fixtures ─────────────────────────────────────────────────────────────

function makeStore(overrides: any = {}) {
  return {
    tasks: [
      { id: 't1', projectId: 'proj-a', assignee: 'Mikey', status: 'backlog' },
      { id: 't2', projectId: 'proj-a', assignee: 'Mikey', status: 'done' },
      { id: 't3', projectId: 'proj-b', assignee: 'Mikey', status: 'backlog' },
    ],
    projects: [
      { id: 'proj-a', name: 'A', devOwner: 'Mikey', state: 'active', workspace_id: 'ws-1' },
      { id: 'proj-x', name: 'X', devOwner: 'Ana', state: 'inactive', workspace_id: 'ws-OTHER' },
    ],
    settings: {
      teammates: [
        { id: 'tm1', name: 'Mikey', agentId: 'mikey' },
        { id: 'tm2', name: 'Ana', agentId: 'ana' },
      ],
    },
    ...overrides,
  } as any;
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue({ ok: true, status: 200 });
  readMock.mockResolvedValue(makeStore());
  process.env.ORG_STUDIO_API_KEY = 'test-key-1645';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ORG_STUDIO_API_KEY;
});

async function loadService() {
  return await import('@/lib/store-service');
}

const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ── updateProjectService ─────────────────────────────────────────────────

describe('updateProjectService (#1645)', () => {
  it('delegates to provider.updateProject (NOTIFY-emitting path) with the exact updates', async () => {
    const { updateProjectService } = await loadService();
    const res = await updateProjectService('ws-1', 'proj-a', { currentVersion: '2.0.0' }, makeStore());
    expect(res.ok).toBe(true);
    expect(updateProjectMock).toHaveBeenCalledTimes(1);
    expect(updateProjectMock).toHaveBeenCalledWith('proj-a', { currentVersion: '2.0.0' });
  });

  it('reads a fresh store snapshot when none is passed (internal-caller path)', async () => {
    const { updateProjectService } = await loadService();
    const res = await updateProjectService('ws-1', 'proj-a', { currentVersion: '3.0.0' });
    expect(res.ok).toBe(true);
    expect(readMock).toHaveBeenCalled();
    expect(updateProjectMock).toHaveBeenCalledWith('proj-a', { currentVersion: '3.0.0' });
  });

  it('403s when the project belongs to another workspace (guard preserved)', async () => {
    const { updateProjectService } = await loadService();
    const res = await updateProjectService('ws-1', 'proj-x', { name: 'nope' }, makeStore());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(403);
    expect(updateProjectMock).not.toHaveBeenCalled();
  });

  it('reassigns active (non-done) tasks on devOwner change, skipping done', async () => {
    const { updateProjectService } = await loadService();
    const res = await updateProjectService('ws-1', 'proj-a', { devOwner: 'Ana' }, makeStore());
    expect(res.ok).toBe(true);
    // t1 (backlog, proj-a) reassigned; t2 (done) skipped; t3 (other project) untouched
    expect(updateTaskMock).toHaveBeenCalledTimes(1);
    expect(updateTaskMock).toHaveBeenCalledWith('t1', { assignee: 'Ana' });
  });

  it('strips legacy autonomy.approvedThrough scalar (#1224 defense-in-depth)', async () => {
    const { updateProjectService } = await loadService();
    const updates: any = { autonomy: { approvedThrough: '9.9.9', other: true } };
    await updateProjectService('ws-1', 'proj-a', updates, makeStore());
    expect('approvedThrough' in updates.autonomy).toBe(false);
    expect(updates.autonomy.other).toBe(true);
  });

  it('inactive→active transition re-checks promote and fires dispatch on moved tasks', async () => {
    process.env.DATABASE_URL = 'postgres://fake';
    try {
      promoteMock.mockResolvedValueOnce({ promoted: true, from: '1.0', to: '1.1', movedTasks: 3 } as any);
      const store = makeStore();
      store.projects.push({ id: 'proj-inactive', name: 'I', devOwner: 'Mikey', state: 'inactive', workspace_id: 'ws-1' });
      readMock.mockResolvedValue(store); // freshStore read inside promote path
      const { updateProjectService } = await loadService();
      const res = await updateProjectService('ws-1', 'proj-inactive', { state: 'active' }, store);
      expect(res.ok).toBe(true);
      await flush(); // fire-and-forget IIFE
      expect(promoteMock).toHaveBeenCalledTimes(1);
      // dispatch side-effect: scheduler trigger fired for the devOwner
      const schedulerCalls = fetchMock.mock.calls.filter((c: any[]) => String(c[0]).includes('/api/scheduler'));
      expect(schedulerCalls.length).toBeGreaterThanOrEqual(1);
      const body = JSON.parse(schedulerCalls[0][1].body);
      expect(body).toEqual({ action: 'trigger', agentId: 'mikey' });
    } finally {
      delete process.env.DATABASE_URL;
    }
  });

  it('does NOT fire dispatch when promote moves zero tasks', async () => {
    process.env.DATABASE_URL = 'postgres://fake';
    try {
      promoteMock.mockResolvedValueOnce({ promoted: true, from: '1.0', to: '1.1', movedTasks: 0 } as any);
      const store = makeStore();
      store.projects.push({ id: 'proj-inactive', name: 'I', devOwner: 'Mikey', state: 'inactive', workspace_id: 'ws-1' });
      readMock.mockResolvedValue(store);
      const { updateProjectService } = await loadService();
      await updateProjectService('ws-1', 'proj-inactive', { state: 'active' }, store);
      await flush();
      const schedulerCalls = fetchMock.mock.calls.filter((c: any[]) => String(c[0]).includes('/api/scheduler'));
      expect(schedulerCalls.length).toBe(0);
    } finally {
      delete process.env.DATABASE_URL;
    }
  });
});

// ── triggerAgentLoopService ──────────────────────────────────────────────

describe('triggerAgentLoopService (#1645)', () => {
  it('sends the internal Bearer on the scheduler trigger', async () => {
    const { triggerAgentLoopService } = await loadService();
    triggerAgentLoopService('Mikey', makeStore());
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/scheduler');
    expect(opts.headers['Authorization']).toBe('Bearer test-key-1645');
    expect(JSON.parse(opts.body)).toEqual({ action: 'trigger', agentId: 'mikey' });
  });

  it('routes the virtual generic worker assignee to scheduler resolution', async () => {
    const { triggerAgentLoopService } = await loadService();
    triggerAgentLoopService('worker', makeStore());
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, opts] = fetchMock.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({ action: 'trigger', agentId: 'worker' });
  });

  it('no-ops when the assignee has no teammate mapping', async () => {
    const { triggerAgentLoopService } = await loadService();
    triggerAgentLoopService('Nobody', makeStore());
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('records an internal-call failure after retries are exhausted', async () => {
    // Note: retries use real 1s/5s delays; simulate by making all attempts
    // fail fast with throw and waiting past the final one is too slow for CI.
    // Instead verify the first failed attempt path records nothing (only the
    // LAST attempt records) by exhausting with fake timers.
    vi.useFakeTimers();
    try {
      fetchMock.mockRejectedValue(new Error('conn refused'));
      const { triggerAgentLoopService } = await loadService();
      triggerAgentLoopService('Mikey', makeStore());
      // 3 attempts with 1s + 5s waits between
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(100);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(recordFailureMock).toHaveBeenCalledWith(
        'store-service:trigger-agent-loop', '/api/scheduler', null, 'fetch-throw',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
