/**
 * #1352 — Pure decision logic for the claim-contract sweep + escalation
 * ladder + dispatch enforcement.
 *
 * Extracted from src/app/api/scheduler/route.ts so the contract is
 * unit-testable without a live Postgres + Next.js process. The route
 * file imports these helpers and continues to own all IO (provider
 * writes, addComment, RPC). This module is intentionally pure: no
 * Date.now() calls, no provider calls, no logging — everything that
 * varies between calls comes in as a parameter.
 *
 * Why split this out now:
 *   - The 3 sandbox scripts (sim-dead-claim, sim-escalation,
 *     sim-enforcement) prove the wired-up flow on a live DB. But every
 *     run requires a running mc-dashboard service + Postgres + a real
 *     teammate row. That's fine for one-time verification; useless for
 *     CI on every push.
 *   - The route handler is a 1.1k-line file with HTTP framing,
 *     dispatch attempts, sweeps, and the trigger flow all interleaved.
 *     Pulling pure decisions out makes the route easier to read AND
 *     gives us regression coverage that can run in <1s with no
 *     external deps.
 *
 * Constants here MUST match the constants in scheduler/route.ts.
 * They are duplicated rather than imported because the route file is
 * server-only and vitest specs run in plain Node — importing the
 * route handler would pull in NextRequest and the entire Next.js
 * runtime. The constants are also intentionally exported so tests
 * can assert on them.
 */

// ---- Timing constants (mirror scheduler/route.ts) ----
export const LEASE_DURATION_MS = 60 * 60 * 1000; // 60 min
export const STALE_OTHER_ACTIVITY_WINDOW_MS = 60 * 60 * 1000; // 60 min
export const STALE_COUNT_DECAY_MS = 24 * 60 * 60 * 1000; // 24 h
export const STALE_COUNT_INCREMENT_COOLDOWN_MS = 60 * 60 * 1000; // 60 min
export const LEVEL_WARN = 1;
export const LEVEL_PING = 2;
export const LEVEL_DISABLE = 3;

// ---- Shapes ----
// Loosely typed to keep this module decoupled from store.ts (the real
// Task / Teammate types have ~40 unrelated fields). Tests construct
// minimal fixtures.
export interface TaskLike {
  id: string;
  status?: string;
  assignee?: string;
  claim_started_at?: number | null;
  claim_lease_expires_at?: number | null;
  lastActivityAt?: number;
  loopPausedAt?: number | null;
}

export interface TeammateLike {
  id?: string;
  agentId?: string;
  name?: string;
  staleClaimCount?: number;
  staleClaimCountedAt?: number;
  loopDisabledAt?: number;
  loopDisableReason?: string;
}

// ---- 1. Lease expiry classification ----

/**
 * Returns true if the task is a candidate for the lease sweep:
 *   - In-progress (claim is live)
 *   - Not loop-paused (the stall path owns paused tasks; we don't double-dip)
 *   - Has a claim_lease_expires_at stamp (pre-#1352 tasks don't)
 *   - That stamp is in the past relative to `now`
 */
export function isLeaseExpired(task: TaskLike, now: number): boolean {
  if (task.status !== 'in-progress') return false;
  if (task.loopPausedAt) return false;
  if (!task.claim_lease_expires_at) return false;
  return now > task.claim_lease_expires_at;
}

/**
 * Returns the most recent lastActivityAt across all OTHER tasks owned
 * by `assigneeLower` (i.e. excluding `excludeTaskId`). 0 if none.
 *
 * Pure: takes the task list, no provider access.
 */
export function maxOtherTaskActivity(
  tasks: TaskLike[],
  assigneeLower: string,
  excludeTaskId: string,
): number {
  let max = 0;
  for (const t of tasks) {
    if (t.id === excludeTaskId) continue;
    if ((t.assignee || '').toLowerCase() !== assigneeLower) continue;
    const ts = t.lastActivityAt || 0;
    if (ts > max) max = ts;
  }
  return max;
}

/**
 * Classifies an expired-lease task into one of three actions.
 *
 *   - 'bounce'           — assignee is busy on OTHER tasks within 60 min
 *                          (slice 2 behavior: return this task to backlog)
 *   - 'escalate'         — assignee is dead everywhere (slice 3 ladder)
 *   - 'no-assignee'      — task has no assignee; just bounce (slice 2)
 *
 * Caller is responsible for actually performing the IO; this just
 * picks the path.
 */
export function classifyExpiredLease(
  task: TaskLike,
  allTasks: TaskLike[],
  now: number,
): 'bounce' | 'escalate' | 'no-assignee' {
  const assigneeLower = (task.assignee || '').toLowerCase();
  if (!assigneeLower) return 'no-assignee';
  const otherActivity = maxOtherTaskActivity(allTasks, assigneeLower, task.id);
  const activeElsewhere =
    otherActivity > 0 && now - otherActivity < STALE_OTHER_ACTIVITY_WINDOW_MS;
  return activeElsewhere ? 'bounce' : 'escalate';
}

// ---- 2. Escalation-level computation ----

export type EscalationDecision =
  | { action: 'cooldown'; reason: 'increment-cooldown' }
  | { action: 'no-teammate'; reason: 'no-teammate' }
  | { action: 'increment'; newCount: number; level: 1 | 2 | 3; reachedDisable: boolean };

/**
 * Given the current state of an assignee's stale-claim counter,
 * returns what the next increment should do.
 *
 *   - 'cooldown'    — last strike was within INCREMENT_COOLDOWN_MS;
 *                     do nothing.
 *   - 'no-teammate' — no teammate row matched the assignee. Caller
 *                     should log and skip (we can't escalate someone
 *                     we don't know about).
 *   - 'increment'   — compute new count, decay-aware:
 *                       * if last strike >24h ago, count resets to 0
 *                         before incrementing (decay window passed)
 *                       * otherwise add 1 to existing count
 *                     Level is min(newCount, 3) — count of 5 still
 *                     means "Level 3" for downstream behavior.
 *                     reachedDisable=true iff newCount >= LEVEL_DISABLE,
 *                     signaling the caller to stamp loopDisabledAt.
 */
export function computeEscalation(
  teammate: TeammateLike | undefined,
  now: number,
): EscalationDecision {
  if (!teammate) return { action: 'no-teammate', reason: 'no-teammate' };

  const lastCountedAt = teammate.staleClaimCountedAt || 0;
  if (lastCountedAt && now - lastCountedAt < STALE_COUNT_INCREMENT_COOLDOWN_MS) {
    return { action: 'cooldown', reason: 'increment-cooldown' };
  }

  // Decay: if last strike was >24h ago, drop the count back to 0 before
  // incrementing. (Note: if lastCountedAt is 0/missing, decayed=0 too —
  // a fresh teammate increments from 0→1.)
  const decayed =
    lastCountedAt && now - lastCountedAt < STALE_COUNT_DECAY_MS
      ? teammate.staleClaimCount || 0
      : 0;
  const newCount = decayed + 1;

  // Level cap at 3 — counts >3 keep escalating in DB but the UX surface
  // is "Level 3" because there's no Level 4 behavior.
  const level: 1 | 2 | 3 =
    newCount >= LEVEL_DISABLE ? 3 : newCount === LEVEL_PING ? 2 : 1;

  return {
    action: 'increment',
    newCount,
    level,
    reachedDisable: newCount >= LEVEL_DISABLE,
  };
}

// ---- 2b. Escalation idempotency guard (#1355) ----

/**
 * Returns true if the task is still a valid escalation target.
 *
 * Call this AFTER re-reading the task from the store (provider.getTask
 * or provider.read().tasks.find()). If the task was deleted, bounced,
 * or moved out of in-progress between the sweep scan and the escalation
 * write, this returns false and the caller MUST skip the entire
 * escalation for this tick — no stamping, no comment, no chat.send.
 *
 * Logging the skip is the caller's responsibility (observability).
 *
 * This is the #1355 idempotency guard: "If the task no longer exists
 * or is no longer in-progress, skip."
 */
export function shouldEscalateAgainst(task: TaskLike | null | undefined): boolean {
  if (!task) return false;
  if (task.status !== 'in-progress') return false;
  // If the task had its lease cleared (e.g. by a concurrent bounce), don't double-dip.
  if (!task.claim_lease_expires_at) return false;
  return true;
}

// ---- 3. Dispatch enforcement ----

/**
 * Returns true if dispatch should be blocked for an assignee.
 *
 * This is the function /api/scheduler trigger calls (after the
 * 'no enabled loop' check). It's a simple flag read, but isolated
 * here so tests can prove the contract without spinning up a route
 * handler: "loopDisabledAt set → blocked; missing or 0 → allowed".
 */
export function isDispatchBlocked(teammate: TeammateLike | undefined): boolean {
  if (!teammate) return false;
  return !!teammate.loopDisabledAt;
}

/**
 * Returns the human-readable skip reason for a dispatch block. Used
 * by both the route handler (in the trigger response) and the Team
 * page (in the badge tooltip).
 */
export function dispatchBlockReason(teammate: TeammateLike | undefined): string {
  if (!teammate?.loopDisabledAt) return '';
  return (
    `Dispatch loop auto-disabled by stale-claim escalation: ` +
    `${teammate.loopDisableReason || '(no reason recorded)'}`
  );
}

// ---- 4. Lease stamping ----

/**
 * Computes the lease window stamps for a task transitioning into
 * in-progress. Pure — caller writes the result through the provider.
 *
 * The lease lasts LEASE_DURATION_MS from the claim start. Activity
 * (comment, status change, store update) extends the lease via a
 * separate path (extendLease in route.ts) — this helper only handles
 * the initial stamp on entry.
 */
export function newLeaseStamps(now: number): {
  claim_started_at: number;
  claim_lease_expires_at: number;
} {
  return {
    claim_started_at: now,
    claim_lease_expires_at: now + LEASE_DURATION_MS,
  };
}

/**
 * Returns true if `lastActivityAt` (or any other timestamp callers
 * pass in) is recent enough to extend the lease. Centralizing this
 * keeps the activity-vs-stale check consistent across paths.
 */
export function shouldExtendLease(
  task: TaskLike,
  lastActivityAt: number,
  now: number,
): boolean {
  if (task.status !== 'in-progress') return false;
  if (!task.claim_lease_expires_at) return false;
  // Don't extend if the activity is older than the existing lease end —
  // that would be a regression. Caller probably passed in stale data.
  if (lastActivityAt < (task.claim_started_at || 0)) return false;
  // Don't extend past the cap of `now + LEASE_DURATION_MS` — that's the
  // contract. Caller computes the new expiry as `now + LEASE_DURATION_MS`,
  // not `lastActivityAt + LEASE_DURATION_MS`.
  return lastActivityAt <= now;
}
