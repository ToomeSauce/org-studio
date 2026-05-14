/**
 * #1352 slice 5 — Claim-contract regression suite.
 *
 * Covers the pure decision functions extracted into claim-contract.ts so
 * the lease-bounce + escalation + dispatch-block contract is exercised on
 * every push without needing a live Postgres + Next.js + agent runtime.
 *
 * What this REPLACES: the three sandbox scripts
 *   - scripts/sim-dead-claim-1352.mjs      (slice 2 — bounce path)
 *   - scripts/sim-escalation-1352.mjs      (slice 3 — escalation ladder)
 *   - scripts/sim-enforcement-1352.mjs     (slice 4 — dispatch gate + clear)
 * each verify the WIRED-UP flow on real infra (good for one-time sign-off,
 * bad for CI). The route handler in scheduler/route.ts now imports from
 * claim-contract.ts directly, so the same predicates are used both in
 * production and in this suite. If a future refactor changes the route's
 * decision logic without going through the lib, the test will go red.
 *
 * Scope on purpose: the tests do NOT exercise the provider writes,
 * comments, RPC pings, or HTTP framing. Those are IO with their own
 * failure modes (network, DB, gateway) better verified by the existing
 * sandbox scripts on demand. This suite locks down the BEHAVIOR
 * contract: "given this task + this teammate + this clock, the
 * scheduler MUST classify it this way".
 */
import { describe, it, expect } from 'vitest';
import {
  LEASE_DURATION_MS,
  STALE_OTHER_ACTIVITY_WINDOW_MS,
  STALE_COUNT_DECAY_MS,
  STALE_COUNT_INCREMENT_COOLDOWN_MS,
  LEVEL_WARN,
  LEVEL_PING,
  LEVEL_DISABLE,
  isLeaseExpired,
  classifyExpiredLease,
  computeEscalation,
  isDispatchBlocked,
  dispatchBlockReason,
  maxOtherTaskActivity,
  newLeaseStamps,
  shouldExtendLease,
  type TaskLike,
  type TeammateLike,
} from './claim-contract';

const NOW = Date.UTC(2026, 4, 14, 5, 0, 0); // fixed clock so tests are deterministic
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

// Convenience: build a minimal task fixture with sensible defaults.
const task = (overrides: Partial<TaskLike> & { id: string }): TaskLike => ({
  status: 'in-progress',
  ...overrides,
});

describe('#1352 claim-contract — constants match doneWhen', () => {
  // The doneWhen text refers to a "60-min heartbeat lease" + "24h decay";
  // these tests pin the constants so a future tweak doesn't silently
  // drift the contract.
  it('lease lasts 60 minutes', () => {
    expect(LEASE_DURATION_MS).toBe(60 * 60 * 1000);
  });
  it('stale-count decays after 24 hours', () => {
    expect(STALE_COUNT_DECAY_MS).toBe(24 * 60 * 60 * 1000);
  });
  it('per-strike cooldown matches the lease window', () => {
    // Without this match, a single dead task would trip Level 3 in <2 min.
    expect(STALE_COUNT_INCREMENT_COOLDOWN_MS).toBe(LEASE_DURATION_MS);
  });
  it('escalation thresholds are 1, 2, 3', () => {
    expect([LEVEL_WARN, LEVEL_PING, LEVEL_DISABLE]).toEqual([1, 2, 3]);
  });
});

describe('#1352 claim-contract — isLeaseExpired', () => {
  it('returns true when the lease stamp is in the past', () => {
    expect(
      isLeaseExpired(
        task({ id: 't1', claim_lease_expires_at: NOW - 1 }),
        NOW,
      ),
    ).toBe(true);
  });

  it('returns false when the lease stamp is in the future', () => {
    expect(
      isLeaseExpired(
        task({ id: 't1', claim_lease_expires_at: NOW + 10 * MIN }),
        NOW,
      ),
    ).toBe(false);
  });

  it('returns false when the task is not in-progress', () => {
    // doneWhen #3 says we only bounce in-progress tasks. Backlog/done
    // tasks may have legacy stamps from earlier slices and must be
    // ignored.
    expect(
      isLeaseExpired(
        task({ id: 't1', status: 'backlog', claim_lease_expires_at: NOW - HOUR }),
        NOW,
      ),
    ).toBe(false);
    expect(
      isLeaseExpired(
        task({ id: 't1', status: 'done', claim_lease_expires_at: NOW - HOUR }),
        NOW,
      ),
    ).toBe(false);
  });

  it('returns false when the task is loop-paused', () => {
    // Stall path owns paused tasks; the sweep must not double-pause.
    expect(
      isLeaseExpired(
        task({
          id: 't1',
          claim_lease_expires_at: NOW - HOUR,
          loopPausedAt: NOW - 30 * MIN,
        }),
        NOW,
      ),
    ).toBe(false);
  });

  it('returns false when no lease stamp exists (pre-#1352 task)', () => {
    expect(
      isLeaseExpired(task({ id: 't1', claim_lease_expires_at: null }), NOW),
    ).toBe(false);
    expect(isLeaseExpired(task({ id: 't1' }), NOW)).toBe(false);
  });

  it('treats exactly-equal stamps as not yet expired', () => {
    // Boundary: now <= expiry → still valid. Documented as `now > stamp`
    // in the route; the lib uses the same predicate.
    expect(
      isLeaseExpired(task({ id: 't1', claim_lease_expires_at: NOW }), NOW),
    ).toBe(false);
  });
});

describe('#1352 claim-contract — maxOtherTaskActivity', () => {
  // Used by the sweep to decide bounce vs escalate. Order-independent,
  // case-insensitive on assignee, must exclude the task being inspected.
  const tasks: TaskLike[] = [
    task({ id: 'a', assignee: 'mikey', lastActivityAt: NOW - 10 * MIN }),
    task({ id: 'b', assignee: 'Mikey', lastActivityAt: NOW - 30 * MIN }),
    task({ id: 'c', assignee: 'henry', lastActivityAt: NOW - 5 * MIN }),
    task({ id: 'd', assignee: 'mikey' /* no lastActivityAt */ }),
  ];

  it('returns the max lastActivityAt across the assignee, ignoring excludeId', () => {
    expect(maxOtherTaskActivity(tasks, 'mikey', 'a')).toBe(NOW - 30 * MIN);
  });

  it('returns the max regardless of input order', () => {
    const reversed = [...tasks].reverse();
    expect(maxOtherTaskActivity(reversed, 'mikey', 'a')).toBe(NOW - 30 * MIN);
  });

  it('case-insensitive assignee match', () => {
    // Task 'b' has assignee="Mikey" (capital). Searching with lowercased
    // "mikey" must still find it.
    expect(maxOtherTaskActivity(tasks, 'mikey', 'a')).toBe(NOW - 30 * MIN);
  });

  it("returns 0 when there's nothing", () => {
    expect(maxOtherTaskActivity([], 'mikey', 'x')).toBe(0);
    expect(maxOtherTaskActivity(tasks, 'noone', 'x')).toBe(0);
  });

  it("doesn't count the excludeId task itself", () => {
    // Only task 'a' is Mikey's recent one. Excluding it forces the fallback
    // to 'b' (NOW - 30 min).
    expect(maxOtherTaskActivity(tasks, 'mikey', 'a')).toBe(NOW - 30 * MIN);
  });
});

describe('#1352 claim-contract — classifyExpiredLease', () => {
  // The three branches of the sweep loop.
  const recent = NOW - 30 * MIN; // within STALE_OTHER_ACTIVITY_WINDOW_MS
  const old = NOW - 2 * HOUR; // outside

  it("returns 'bounce' when assignee is busy on another task within 60 min", () => {
    const expired = task({
      id: 't1',
      assignee: 'mikey',
      claim_lease_expires_at: NOW - 5 * MIN,
    });
    const allTasks: TaskLike[] = [
      expired,
      task({ id: 't2', assignee: 'mikey', lastActivityAt: recent }),
    ];
    expect(classifyExpiredLease(expired, allTasks, NOW)).toBe('bounce');
  });

  it("returns 'escalate' when assignee is silent everywhere", () => {
    // Only the expired task carries the assignee, and no other tasks
    // have recent lastActivityAt for them.
    const expired = task({
      id: 't1',
      assignee: 'mikey',
      claim_lease_expires_at: NOW - 5 * MIN,
    });
    const allTasks: TaskLike[] = [
      expired,
      task({ id: 't2', assignee: 'mikey', lastActivityAt: old }),
    ];
    expect(classifyExpiredLease(expired, allTasks, NOW)).toBe('escalate');
  });

  it("returns 'no-assignee' when the task has no assignee", () => {
    const expired = task({
      id: 't1',
      assignee: '',
      claim_lease_expires_at: NOW - 5 * MIN,
    });
    expect(classifyExpiredLease(expired, [expired], NOW)).toBe('no-assignee');
  });

  it('treats boundary activity at exactly the 60-min window as escalate (not bounce)', () => {
    // Activity at exactly NOW - 60 min. The predicate is
    // `now - otherActivity < WINDOW`; at WINDOW exactly that's false.
    // Boundary documented: missing-by-a-second is treated as
    // "not active anymore" — escalate path.
    const expired = task({
      id: 't1',
      assignee: 'mikey',
      claim_lease_expires_at: NOW - 5 * MIN,
    });
    const allTasks: TaskLike[] = [
      expired,
      task({
        id: 't2',
        assignee: 'mikey',
        lastActivityAt: NOW - STALE_OTHER_ACTIVITY_WINDOW_MS,
      }),
    ];
    expect(classifyExpiredLease(expired, allTasks, NOW)).toBe('escalate');
  });

  it('ignores other tasks owned by different assignees', () => {
    // Henry being active should not save Mikey's expired claim.
    const expired = task({
      id: 't1',
      assignee: 'mikey',
      claim_lease_expires_at: NOW - 5 * MIN,
    });
    const allTasks: TaskLike[] = [
      expired,
      task({ id: 't2', assignee: 'henry', lastActivityAt: recent }),
    ];
    expect(classifyExpiredLease(expired, allTasks, NOW)).toBe('escalate');
  });
});

describe('#1352 claim-contract — computeEscalation (the ladder)', () => {
  // The decision function the sweep calls when assignee is silent
  // everywhere. Captures cooldown, decay, and level math.

  const tm = (over: Partial<TeammateLike>): TeammateLike => ({
    id: 'tm1',
    name: 'Mikey',
    agentId: 'mikey',
    ...over,
  });

  it("returns 'no-teammate' when the assignee isn't in the roster", () => {
    expect(computeEscalation(undefined, NOW)).toEqual({
      action: 'no-teammate',
      reason: 'no-teammate',
    });
  });

  it('fresh teammate (no count, no lastCountedAt) increments to L1', () => {
    expect(computeEscalation(tm({}), NOW)).toMatchObject({
      action: 'increment',
      newCount: 1,
      level: 1,
      reachedDisable: false,
    });
  });

  it('1→2 within decay window steps to Level 2', () => {
    expect(
      computeEscalation(
        tm({ staleClaimCount: 1, staleClaimCountedAt: NOW - 2 * HOUR }),
        NOW,
      ),
    ).toMatchObject({
      action: 'increment',
      newCount: 2,
      level: 2,
      reachedDisable: false,
    });
  });

  it('2→3 within decay window reaches Level 3 + flags reachedDisable', () => {
    // The two preconditions for slice-3 loop-disable: count was already 2
    // AND last strike was >= cooldown ago (so cooldown gate passes).
    expect(
      computeEscalation(
        tm({ staleClaimCount: 2, staleClaimCountedAt: NOW - 2 * HOUR }),
        NOW,
      ),
    ).toMatchObject({
      action: 'increment',
      newCount: 3,
      level: 3,
      reachedDisable: true,
    });
  });

  it('cooldown blocks repeat increments inside the 60-min window', () => {
    // Within INCREMENT_COOLDOWN_MS of the last strike → no-op. Without
    // this guard a single dead task would walk to L3 in 90 seconds.
    expect(
      computeEscalation(
        tm({ staleClaimCount: 1, staleClaimCountedAt: NOW - 30 * MIN }),
        NOW,
      ),
    ).toEqual({ action: 'cooldown', reason: 'increment-cooldown' });
  });

  it('cooldown boundary at exactly 60 min: allows the increment', () => {
    // Predicate is `now - lastCountedAt < COOLDOWN`. At exactly COOLDOWN
    // that's false, so we proceed and increment.
    expect(
      computeEscalation(
        tm({
          staleClaimCount: 1,
          staleClaimCountedAt: NOW - STALE_COUNT_INCREMENT_COOLDOWN_MS,
        }),
        NOW,
      ),
    ).toMatchObject({ action: 'increment', newCount: 2 });
  });

  it('decay window passed (>24h) resets the count before incrementing', () => {
    // Yesterday's strikes are forgiven. doneWhen #5 explicitly: "24h decay".
    expect(
      computeEscalation(
        tm({
          staleClaimCount: 2,
          staleClaimCountedAt: NOW - (STALE_COUNT_DECAY_MS + HOUR),
        }),
        NOW,
      ),
    ).toMatchObject({
      action: 'increment',
      newCount: 1, // reset to 0 then +1
      level: 1,
      reachedDisable: false,
    });
  });

  it('decay boundary at exactly 24h: count is RESET', () => {
    // Predicate is `now - lastCountedAt < DECAY`. At exactly DECAY,
    // that's false → decayed=0, newCount=1.
    expect(
      computeEscalation(
        tm({
          staleClaimCount: 2,
          staleClaimCountedAt: NOW - STALE_COUNT_DECAY_MS,
        }),
        NOW,
      ),
    ).toMatchObject({ newCount: 1, level: 1 });
  });

  it('count of 4 (already past L3) still reports level 3, reachedDisable=true', () => {
    // Counts above 3 aren't visible to humans but must not break the
    // ladder. Caller may re-stamp loopDisabledAt; harmless.
    expect(
      computeEscalation(
        tm({ staleClaimCount: 3, staleClaimCountedAt: NOW - 2 * HOUR }),
        NOW,
      ),
    ).toMatchObject({ newCount: 4, level: 3, reachedDisable: true });
  });
});

describe('#1352 claim-contract — dispatch enforcement', () => {
  // Slice 4 gate. Tests both that the predicate fires and that the
  // human-readable reason includes the operator's stamped explanation.

  it('blocks dispatch when loopDisabledAt is set', () => {
    expect(isDispatchBlocked({ id: 'tm1', loopDisabledAt: NOW - HOUR })).toBe(
      true,
    );
  });

  it('allows dispatch when loopDisabledAt is missing or 0', () => {
    expect(isDispatchBlocked({ id: 'tm1' })).toBe(false);
    expect(isDispatchBlocked({ id: 'tm1', loopDisabledAt: 0 })).toBe(false);
  });

  it('safely returns false for missing teammate (no roster row yet)', () => {
    // Defensive: dispatch should NOT be blocked just because we don't
    // know about the teammate. A separate dispatch-attempt skip
    // reason handles that case.
    expect(isDispatchBlocked(undefined)).toBe(false);
  });

  it('block reason includes the operator-stamped loopDisableReason verbatim', () => {
    const reason = dispatchBlockReason({
      id: 'tm1',
      loopDisabledAt: NOW,
      loopDisableReason: 'Auto-disabled after 3 stale-claim incidents within 24h',
    });
    expect(reason).toContain('Auto-disabled after 3 stale-claim incidents within 24h');
    expect(reason).toContain('Dispatch loop auto-disabled');
  });

  it('block reason falls back gracefully when no reason was stamped', () => {
    // Should never happen in production (slice 3 always sets a reason),
    // but the fallback prevents an undefined ending up in the badge
    // tooltip on the Team page.
    const reason = dispatchBlockReason({ id: 'tm1', loopDisabledAt: NOW });
    expect(reason).toContain('(no reason recorded)');
  });

  it('returns empty string when not blocked', () => {
    expect(dispatchBlockReason({ id: 'tm1' })).toBe('');
    expect(dispatchBlockReason(undefined)).toBe('');
  });
});

describe('#1352 claim-contract — newLeaseStamps + shouldExtendLease', () => {
  it('stamps a 60-min lease from now', () => {
    const stamps = newLeaseStamps(NOW);
    expect(stamps.claim_started_at).toBe(NOW);
    expect(stamps.claim_lease_expires_at).toBe(NOW + LEASE_DURATION_MS);
  });

  it("doesn't extend if the task isn't in-progress", () => {
    expect(
      shouldExtendLease(
        task({ id: 't', status: 'done', claim_lease_expires_at: NOW + HOUR }),
        NOW - MIN,
        NOW,
      ),
    ).toBe(false);
  });

  it("doesn't extend if no lease was ever stamped", () => {
    expect(
      shouldExtendLease(task({ id: 't', status: 'in-progress' }), NOW - MIN, NOW),
    ).toBe(false);
  });

  it('extends on fresh activity', () => {
    expect(
      shouldExtendLease(
        task({
          id: 't',
          claim_started_at: NOW - 30 * MIN,
          claim_lease_expires_at: NOW + 30 * MIN,
        }),
        NOW - MIN,
        NOW,
      ),
    ).toBe(true);
  });

  it("doesn't extend on activity older than the claim_started_at", () => {
    // Bogus / replayed event: ignore it so we don't shrink the lease.
    expect(
      shouldExtendLease(
        task({
          id: 't',
          claim_started_at: NOW - 10 * MIN,
          claim_lease_expires_at: NOW + 50 * MIN,
        }),
        NOW - HOUR,
        NOW,
      ),
    ).toBe(false);
  });

  it("doesn't extend on activity in the future", () => {
    expect(
      shouldExtendLease(
        task({
          id: 't',
          claim_started_at: NOW - 30 * MIN,
          claim_lease_expires_at: NOW + 30 * MIN,
        }),
        NOW + HOUR,
        NOW,
      ),
    ).toBe(false);
  });
});
