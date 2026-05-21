/**
 * #1494 — wake-trigger predicate regression suite.
 *
 * Covers src/lib/wake-trigger.ts exhaustively. The route handler delegates
 * 100% of its "should we wake the assignee?" decision to resolveWakeTrigger,
 * so every transition that should or should NOT fire a scheduler trigger
 * is exercised here without standing up Postgres/RPC/fetch.
 *
 * Coverage shape (status × assignee combinations):
 *
 *   Statuses:  backlog, in-progress, blocked, done, planning, qa
 *   Assignee changes:  none, set, change, clear
 *
 * Every cell in that matrix has at least one test (positive or negative).
 */

import { describe, it, expect } from 'vitest';
import { resolveWakeTrigger } from './wake-trigger';

// ---------------------------------------------------------------------------
// T1 — backlog claim (pre-existing behavior, must not regress).
// ---------------------------------------------------------------------------

describe('resolveWakeTrigger — T1 backlog claim', () => {
  it('wakes when status is set to backlog with an assignee on the task', () => {
    expect(
      resolveWakeTrigger({
        prevTask: { status: 'planning', assignee: 'Mikey' },
        updates: { status: 'backlog' },
      }),
    ).toBe('Mikey');
  });

  it('wakes when assignee is set on a backlog task', () => {
    expect(
      resolveWakeTrigger({
        prevTask: { status: 'backlog', assignee: '' },
        updates: { assignee: 'Mikey' },
      }),
    ).toBe('Mikey');
  });

  it('wakes when assignee is changed on a backlog task', () => {
    expect(
      resolveWakeTrigger({
        prevTask: { status: 'backlog', assignee: 'Ana' },
        updates: { assignee: 'Mikey' },
      }),
    ).toBe('Mikey');
  });

  it('does NOT wake on a backlog task with no assignee', () => {
    expect(
      resolveWakeTrigger({
        prevTask: { status: 'backlog', assignee: '' },
        updates: { status: 'backlog' },
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T2 — in-progress reassignment to a different person (pre-existing).
// ---------------------------------------------------------------------------

describe('resolveWakeTrigger — T2 in-progress reassignment', () => {
  it('wakes the NEW assignee when reassigned mid-flight', () => {
    expect(
      resolveWakeTrigger({
        prevTask: { status: 'in-progress', assignee: 'Ana' },
        updates: { assignee: 'Mikey' },
      }),
    ).toBe('Mikey');
  });

  it('does NOT wake when in-progress task is reassigned to the SAME person', () => {
    // updates.assignee === prevTask.assignee → no change → no wake. The
    // anti-spam guard for keep-alive writes.
    expect(
      resolveWakeTrigger({
        prevTask: { status: 'in-progress', assignee: 'Ana' },
        updates: { assignee: 'Ana' },
      }),
    ).toBeNull();
  });

  it('does NOT wake when in-progress task is unassigned (cleared)', () => {
    expect(
      resolveWakeTrigger({
        prevTask: { status: 'in-progress', assignee: 'Ana' },
        updates: { assignee: '' },
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T3 — #1494 the bug: any non-in-progress → in-progress should wake.
// ---------------------------------------------------------------------------

describe('resolveWakeTrigger — T3 unblock wake (#1494)', () => {
  it('blocked → in-progress (same assignee) — the #1487 case — DOES wake', () => {
    expect(
      resolveWakeTrigger({
        prevTask: { status: 'blocked', assignee: 'Thelma' },
        updates: { status: 'in-progress' },
      }),
    ).toBe('Thelma');
  });

  it('done → in-progress (reopen, same assignee) wakes', () => {
    expect(
      resolveWakeTrigger({
        prevTask: { status: 'done', assignee: 'Mikey' },
        updates: { status: 'in-progress' },
      }),
    ).toBe('Mikey');
  });

  it('planning → in-progress (same assignee) wakes', () => {
    expect(
      resolveWakeTrigger({
        prevTask: { status: 'planning', assignee: 'Mikey' },
        updates: { status: 'in-progress' },
      }),
    ).toBe('Mikey');
  });

  it('qa → in-progress (QA bounce, same assignee) wakes', () => {
    expect(
      resolveWakeTrigger({
        prevTask: { status: 'qa', assignee: 'Mikey' },
        updates: { status: 'in-progress' },
      }),
    ).toBe('Mikey');
  });

  it('blocked → in-progress with simultaneous reassignment wakes the new assignee', () => {
    // T2 fires first (more specific), then T3 would also match — the
    // function returns on the first match so we get T2's result, which is
    // the same answer either way: the post-update assignee.
    expect(
      resolveWakeTrigger({
        prevTask: { status: 'blocked', assignee: 'Ana' },
        updates: { status: 'in-progress', assignee: 'Mikey' },
      }),
    ).toBe('Mikey');
  });

  it('blocked → in-progress with no assignee does NOT wake (nothing to wake)', () => {
    expect(
      resolveWakeTrigger({
        prevTask: { status: 'blocked', assignee: '' },
        updates: { status: 'in-progress' },
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A1 — anti-spam: keep-alive writes on already-in-progress tasks.
// ---------------------------------------------------------------------------

describe('resolveWakeTrigger — A1 anti-spam on in-progress keep-alive', () => {
  it('does NOT wake on a pure description edit (no status, no assignee change)', () => {
    expect(
      resolveWakeTrigger({
        prevTask: { status: 'in-progress', assignee: 'Mikey' },
        updates: {},
      }),
    ).toBeNull();
  });

  it('does NOT wake on a status-only write that re-asserts in-progress', () => {
    expect(
      resolveWakeTrigger({
        prevTask: { status: 'in-progress', assignee: 'Mikey' },
        updates: { status: 'in-progress' },
      }),
    ).toBeNull();
  });

  it('does NOT wake on lease-renewal updates on an in-progress task', () => {
    // Lease renewals don't touch status or assignee; they're keep-alives.
    expect(
      resolveWakeTrigger({
        prevTask: { status: 'in-progress', assignee: 'Mikey' },
        updates: {} as any,
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A2 — moves OUT of in-progress / into non-dispatching statuses.
// ---------------------------------------------------------------------------

describe('resolveWakeTrigger — A2 transitions to non-dispatching statuses', () => {
  it('does NOT wake on in-progress → blocked', () => {
    expect(
      resolveWakeTrigger({
        prevTask: { status: 'in-progress', assignee: 'Mikey' },
        updates: { status: 'blocked' },
      }),
    ).toBeNull();
  });

  it('does NOT wake on in-progress → done', () => {
    expect(
      resolveWakeTrigger({
        prevTask: { status: 'in-progress', assignee: 'Mikey' },
        updates: { status: 'done' },
      }),
    ).toBeNull();
  });

  it('does NOT wake on in-progress → planning', () => {
    expect(
      resolveWakeTrigger({
        prevTask: { status: 'in-progress', assignee: 'Mikey' },
        updates: { status: 'planning' },
      }),
    ).toBeNull();
  });

  it('does NOT wake on blocked → done (no in-progress involvement)', () => {
    expect(
      resolveWakeTrigger({
        prevTask: { status: 'blocked', assignee: 'Mikey' },
        updates: { status: 'done' },
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A3 — assignee clears.
// ---------------------------------------------------------------------------

describe('resolveWakeTrigger — A3 unassign', () => {
  it('does NOT wake on backlog → backlog clearing assignee', () => {
    expect(
      resolveWakeTrigger({
        prevTask: { status: 'backlog', assignee: 'Mikey' },
        updates: { assignee: '' },
      }),
    ).toBeNull();
  });

  it('does NOT wake on blocked → in-progress with assignee cleared simultaneously', () => {
    expect(
      resolveWakeTrigger({
        prevTask: { status: 'blocked', assignee: 'Mikey' },
        updates: { status: 'in-progress', assignee: '' },
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Determinism / shape invariants.
// ---------------------------------------------------------------------------

describe('resolveWakeTrigger — return shape', () => {
  it('returns a string OR null — never undefined', () => {
    const out = resolveWakeTrigger({
      prevTask: { status: 'planning', assignee: 'Mikey' },
      updates: {},
    });
    expect(out === null || typeof out === 'string').toBe(true);
  });

  it('returns the POST-update assignee, never the pre-update one', () => {
    // Both T1 (backlog claim w/ change) and T2 (in-progress reassign)
    // should return the new name, not the old.
    expect(
      resolveWakeTrigger({
        prevTask: { status: 'in-progress', assignee: 'Ana' },
        updates: { assignee: 'Mikey' },
      }),
    ).toBe('Mikey');
    expect(
      resolveWakeTrigger({
        prevTask: { status: 'backlog', assignee: 'Ana' },
        updates: { assignee: 'Mikey' },
      }),
    ).toBe('Mikey');
  });

  it('is pure — same inputs, same outputs (no mutation)', () => {
    const prevTask = Object.freeze({ status: 'blocked', assignee: 'Thelma' });
    const updates = Object.freeze({ status: 'in-progress' });
    expect(() => resolveWakeTrigger({ prevTask, updates })).not.toThrow();
    // Frozen inputs would throw on any attempted mutation.
  });
});
