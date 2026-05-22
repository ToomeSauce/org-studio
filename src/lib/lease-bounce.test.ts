/**
 * #1493 — lease-bounce write reliability regression suite.
 *
 * Covers the pure(-ish) bounce helper in src/lib/lease-bounce.ts. The
 * helper is the one place where the Level 3 stale-claim bounce actually
 * touches the store; it MUST handle silent write failures, write-and-no-op
 * (the observed #1487 pattern), concurrent state changes, and retries.
 *
 * What this does NOT cover:
 *   - Escalation cooldown / level math (covered by claim-contract.test.ts).
 *   - The system-comment + chat.send sides of the escalation (those have
 *     their own try/catch around them in scheduler/route.ts).
 *   - The /api/store wrapper-level guards (status validation, etc.).
 */

import { describe, it, expect, vi } from 'vitest';
import { bounceLeaseLevel3, type BounceProvider } from './lease-bounce';

// ---------------------------------------------------------------------------
// Tiny in-memory store + provider helpers.
// ---------------------------------------------------------------------------

type Task = {
  id: string;
  status: string;
  assignee: string;
  statusHistory: any[];
  [k: string]: any;
};

function makeProvider(initial: Task[]): BounceProvider & { _tasks: Task[] } {
  const tasks: Task[] = initial.map(t => ({ ...t }));
  return {
    _tasks: tasks,
    read: async () => ({ tasks: tasks.map(t => ({ ...t })) }),
    updateTask: async (id, updates) => {
      const i = tasks.findIndex(t => t.id === id);
      if (i === -1) throw new Error(`Task not found: ${id}`);
      tasks[i] = { ...tasks[i], ...updates };
      return tasks[i];
    },
  };
}

function silentLogger() {
  return { warn: vi.fn(), log: vi.fn() };
}

const NOW = 1779999999999;

// ---------------------------------------------------------------------------
// Happy path: the bounce lands and the read-back verify confirms it.
// ---------------------------------------------------------------------------

describe('bounceLeaseLevel3 — happy path', () => {
  it('writes status=backlog + assignee="" and verifies, returns ok:verified', async () => {
    const provider = makeProvider([
      {
        id: 'task-A',
        status: 'in-progress',
        assignee: 'Thelma',
        statusHistory: [{ status: 'in-progress', timestamp: NOW - 1000, by: 'Thelma' }],
      },
    ]);
    const feed = { add: vi.fn() };
    const log = silentLogger();

    const out = await bounceLeaseLevel3(
      provider,
      { id: 'task-A', ticketNumber: 1487, title: 'foo' },
      'Thelma',
      NOW,
      { feedSink: feed, logger: log },
    );

    expect(out).toEqual({ ok: true, reason: 'verified' });
    expect(provider._tasks[0].status).toBe('backlog');
    expect(provider._tasks[0].assignee).toBe('');
    // Appended a single new statusHistory entry.
    expect(provider._tasks[0].statusHistory).toHaveLength(2);
    expect(provider._tasks[0].statusHistory[1]).toEqual({
      status: 'backlog',
      timestamp: NOW,
      by: 'System (lease-bounce: stale-claim Level 3)',
    });
    expect(provider._tasks[0].claim_started_at).toBeNull();
    expect(provider._tasks[0].claim_lease_expires_at).toBeNull();
    // No activity feed event on success.
    expect(feed.add).not.toHaveBeenCalled();
  });

  it('uses FRESH statusHistory at write time, not the stale sweep snapshot', async () => {
    // The sweep observed only 1 history entry. Between snapshot and bounce,
    // the agent appended a second 'blocked' entry. We must include BOTH the
    // sweep-seen entry AND the new 'blocked' entry AND the bounce entry —
    // i.e. read fresh inside the helper, not from `task` arg.
    const provider = makeProvider([
      {
        id: 'task-B',
        status: 'in-progress',
        assignee: 'Thelma',
        statusHistory: [
          { status: 'in-progress', timestamp: NOW - 5000, by: 'Thelma' },
          { status: 'blocked', timestamp: NOW - 3000, by: 'Thelma' },
          { status: 'in-progress', timestamp: NOW - 2000, by: 'Thelma' },
        ],
      },
    ]);

    const out = await bounceLeaseLevel3(
      provider,
      { id: 'task-B', statusHistory: [/* stale: only 1 entry */] }, // sweep snapshot is wrong
      'Thelma',
      NOW,
      { logger: silentLogger() },
    );

    expect(out.ok).toBe(true);
    // Must have all 4 entries — the 3 fresh ones + 1 bounce entry.
    expect(provider._tasks[0].statusHistory).toHaveLength(4);
    expect(provider._tasks[0].statusHistory[3].by).toMatch(/lease-bounce/);
  });
});

// ---------------------------------------------------------------------------
// Skip paths: task vanished, or agent already moved off in-progress.
// ---------------------------------------------------------------------------

describe('bounceLeaseLevel3 — skip paths', () => {
  it('returns ok:task-vanished when pre-write re-read finds no task', async () => {
    const provider = makeProvider([]); // empty store
    const feed = { add: vi.fn() };
    const out = await bounceLeaseLevel3(
      provider,
      { id: 'gone-task' },
      'Thelma',
      NOW,
      { feedSink: feed, logger: silentLogger() },
    );
    expect(out).toEqual({ ok: true, reason: 'task-vanished' });
    expect(feed.add).not.toHaveBeenCalled();
  });

  it('returns ok:no-longer-in-progress when agent moved task to done already', async () => {
    const provider = makeProvider([
      { id: 'task-C', status: 'done', assignee: 'Thelma', statusHistory: [] },
    ]);
    const feed = { add: vi.fn() };
    const out = await bounceLeaseLevel3(
      provider,
      { id: 'task-C' },
      'Thelma',
      NOW,
      { feedSink: feed, logger: silentLogger() },
    );
    expect(out).toEqual({ ok: true, reason: 'no-longer-in-progress' });
    // Critically: state untouched.
    expect(provider._tasks[0].status).toBe('done');
    expect(feed.add).not.toHaveBeenCalled();
  });

  it('treats post-write task-vanished as success (concurrent delete)', async () => {
    // Provider's updateTask succeeds, but the verify re-read finds nothing.
    let tasks: Task[] = [
      { id: 'task-D', status: 'in-progress', assignee: 'Thelma', statusHistory: [] },
    ];
    const provider: BounceProvider = {
      read: async () => ({ tasks: tasks.map(t => ({ ...t })) }),
      updateTask: async (id, updates) => {
        const i = tasks.findIndex(t => t.id === id);
        tasks[i] = { ...tasks[i], ...updates };
        // Simulate a concurrent delete that lands between write and verify.
        tasks = [];
        return { id };
      },
    };
    const out = await bounceLeaseLevel3(
      provider,
      { id: 'task-D' },
      'Thelma',
      NOW,
      { logger: silentLogger() },
    );
    expect(out).toEqual({ ok: true, reason: 'task-vanished' });
  });
});

// ---------------------------------------------------------------------------
// The #1493 bug pattern: updateTask returns ok but state didn't change.
// Retry once, then surface to activity feed.
// ---------------------------------------------------------------------------

describe('bounceLeaseLevel3 — write-lost (the #1487 bug pattern)', () => {
  function makeWriteLostProvider(failCount: number): BounceProvider & {
    writeAttempts: number;
  } {
    const initial: Task = {
      id: 'task-X',
      status: 'in-progress',
      assignee: 'Thelma',
      statusHistory: [],
    };
    let stored: Task = { ...initial };
    let writeAttempts = 0;
    return {
      get writeAttempts() {
        return writeAttempts;
      },
      read: async () => ({ tasks: [{ ...stored }] }),
      updateTask: async (id: string, updates: Partial<Task>) => {
        writeAttempts++;
        // Returns "success" but doesn't actually persist on the first
        // `failCount` calls — exactly the silent-loss pattern.
        if (writeAttempts <= failCount) {
          return { ...stored, ...updates, id }; // optimistic-merged shape
        }
        stored = { ...stored, ...updates, id };
        return stored;
      },
    } as any;
  }

  it('retries once on verify-mismatch and succeeds on attempt 2', async () => {
    const provider = makeWriteLostProvider(1);
    const feed = { add: vi.fn() };
    const out = await bounceLeaseLevel3(
      provider,
      { id: 'task-X' },
      'Thelma',
      NOW,
      { feedSink: feed, logger: silentLogger() },
    );
    expect(out).toEqual({ ok: true, reason: 'verified' });
    expect((provider as any).writeAttempts).toBe(2);
    expect(feed.add).not.toHaveBeenCalled();
  });

  it('fails after maxAttempts and emits activity-feed event', async () => {
    const provider = makeWriteLostProvider(99); // always loses the write
    const feed = { add: vi.fn() };
    const out = await bounceLeaseLevel3(
      provider,
      { id: 'task-X', ticketNumber: 1487, title: 'stuck thing', projectId: 'proj-x' },
      'Thelma',
      NOW,
      { feedSink: feed, logger: silentLogger() },
    );
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toBe('verify-mismatch');
    expect(out.ok === false && out.attempts).toBe(2);
    expect(out.ok === false && out.observedStatus).toBe('in-progress');
    expect(feed.add).toHaveBeenCalledTimes(1);
    const event = feed.add.mock.calls[0][0];
    expect(event.kind).toBe('lease-bounce-failed');
    expect(event.ticketNumber).toBe(1487);
    expect(event.assignee).toBe('Thelma');
    expect(event.observedStatus).toBe('in-progress');
    expect(event.emoji).toBe('🚨');
    expect(event.label).toContain('#1487');
    expect(event.label).toContain('Thelma');
  });

  it('hard-fail does NOT throw — caller never sees an exception', async () => {
    const provider = makeWriteLostProvider(99);
    // No feed sink at all — still must not throw.
    await expect(
      bounceLeaseLevel3(provider, { id: 'task-X' }, 'Thelma', NOW, {
        logger: silentLogger(),
      }),
    ).resolves.toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// Exception-on-updateTask: retry once on throw, then surface failure.
// ---------------------------------------------------------------------------

describe('bounceLeaseLevel3 — updateTask throws', () => {
  it('retries once on throw and succeeds on attempt 2', async () => {
    let attempt = 0;
    let stored: Task = {
      id: 'task-Y',
      status: 'in-progress',
      assignee: 'Thelma',
      statusHistory: [],
    };
    const provider: BounceProvider = {
      read: async () => ({ tasks: [{ ...stored }] }),
      updateTask: async (id, updates) => {
        attempt++;
        if (attempt === 1) throw new Error('Postgres connection terminated');
        stored = { ...stored, ...updates };
        return stored;
      },
    };
    const feed = { add: vi.fn() };
    const out = await bounceLeaseLevel3(
      provider,
      { id: 'task-Y' },
      'Thelma',
      NOW,
      { feedSink: feed, logger: silentLogger() },
    );
    expect(out).toEqual({ ok: true, reason: 'verified' });
    expect(feed.add).not.toHaveBeenCalled();
  });

  it('emits activity-feed event with error message when both attempts throw', async () => {
    const provider: BounceProvider = {
      read: async () => ({
        tasks: [
          {
            id: 'task-Z',
            status: 'in-progress',
            assignee: 'Thelma',
            statusHistory: [],
          },
        ],
      }),
      updateTask: async () => {
        throw new Error('Postgres connection terminated');
      },
    };
    const feed = { add: vi.fn() };
    const out = await bounceLeaseLevel3(
      provider,
      { id: 'task-Z', ticketNumber: 999 },
      'Thelma',
      NOW,
      { feedSink: feed, logger: silentLogger() },
    );
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toBe('threw');
    expect(out.ok === false && out.error).toContain('connection terminated');
    expect(feed.add).toHaveBeenCalledTimes(1);
    expect(feed.add.mock.calls[0][0].error).toContain('connection terminated');
  });

  it('survives a feed-sink that itself throws', async () => {
    const provider: BounceProvider = {
      read: async () => ({
        tasks: [
          { id: 't', status: 'in-progress', assignee: 'X', statusHistory: [] },
        ],
      }),
      updateTask: async () => {
        throw new Error('boom');
      },
    };
    const feed = {
      add: () => {
        throw new Error('feed sink exploded');
      },
    };
    const out = await bounceLeaseLevel3(
      provider,
      { id: 't' },
      'X',
      NOW,
      { feedSink: feed, logger: silentLogger() },
    );
    expect(out.ok).toBe(false);
    // Critically: no thrown exception out of the helper.
  });
});

// ---------------------------------------------------------------------------
// Bounce update shape — exact fields the dispatch + UI rely on being clear.
// ---------------------------------------------------------------------------

describe('bounceLeaseLevel3 — update payload contract', () => {
  it('clears all claim/dispatch fields that gate the next assignee', async () => {
    const provider = makeProvider([
      {
        id: 'task-K',
        status: 'in-progress',
        assignee: 'Thelma',
        statusHistory: [],
        // Pre-existing stale stamps that MUST be cleared.
        claim_started_at: 12345,
        claim_lease_expires_at: 67890,
        loopCount: 7,
        _lastDispatchedAt: 99999,
      },
    ]);
    const out = await bounceLeaseLevel3(
      provider,
      { id: 'task-K' },
      'Thelma',
      NOW,
      { logger: silentLogger() },
    );
    expect(out.ok).toBe(true);
    const t = provider._tasks[0];
    expect(t.status).toBe('backlog');
    expect(t.assignee).toBe('');
    expect(t.claim_started_at).toBeNull();
    expect(t.claim_lease_expires_at).toBeNull();
    expect(t.loopCount).toBe(0);
    expect(t._lastDispatchedAt).toBeNull();
    expect(t.lastActivityAt).toBe(NOW);
  });
});
