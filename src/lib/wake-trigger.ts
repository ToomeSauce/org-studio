/**
 * #1494 — pure predicate for "should this updateTask invocation wake the
 * assignee's session?"
 *
 * Extracted from src/app/api/store/route.ts (updateTask handler) so the
 * full coverage matrix of status transitions vs assignee changes can be
 * exercised in vitest without standing up Postgres / RPC / fetch.
 *
 * Background — the #1487 incident (2026-05-21):
 *   Billy moved Thelma's blocked task to in-progress at 06:47 EDT per
 *   Basil directive. The status field flipped and the lease clock started,
 *   but the wake event only fires on backlog→backlog-with-assignee or on
 *   in-progress reassignment to a NEW assignee. blocked→in-progress with
 *   the SAME assignee fell through the gap. 60 min later the lease
 *   expired with zero activity → Level 3 bounce fired against a correctly
 *   yielded agent that simply had never been notified she was unblocked.
 *
 * This file: the trigger contract, written as a small pure function with
 * one input shape and one output (assignee-to-wake-or-null). The route
 * handler delegates to this for every updateTask call. New triggers go
 * here, not in scattered if-blocks in the route.
 */

export interface WakeTriggerInput {
  /** The task as it exists in the store BEFORE this update is applied. */
  prevTask: {
    status?: string;
    assignee?: string;
  };
  /** The patch being applied via updateTask. Only the fields the caller
   *  is changing should be set; missing keys mean "leave alone". */
  updates: {
    status?: string;
    assignee?: string;
  };
}

/**
 * Resolves which assignee (if any) should get a scheduler wake event as
 * a result of this updateTask call. Returns the assignee NAME (matching
 * the existing `triggerAgentLoop(name, store)` contract) or null when no
 * wake should fire.
 *
 * Trigger cases (each must be hit exactly once, in priority order):
 *
 *   T1. backlog claim — task moved INTO backlog (or already in backlog
 *       and assignee being set/changed) with an assignee. The scheduler
 *       picks up backlog tasks for assigned agents.
 *
 *   T2. in-progress reassignment — task already in-progress, assignee
 *       being changed to a new (truthy) person. Wake the NEW assignee.
 *
 *   T3. unblock to in-progress (#1494) — task transitioning FROM any
 *       non-in-progress status TO in-progress with an assignee. Covers
 *       blocked→in-progress, done→reopen, planning→in-progress, etc.
 *       This is the gap that caused #1487.
 *
 * Anti-cases (each must explicitly NOT fire):
 *
 *   A1. Pure activity write on an already-in-progress task (no status
 *       change, no assignee change) — the existing scheduler tick handles
 *       ongoing dispatch; spamming the wake would multiply work.
 *   A2. Move TO blocked / done / planning — those don't dispatch work.
 *   A3. Unassign (assignee set to '' or undefined) on any transition —
 *       there's nobody to wake.
 */
export function resolveWakeTrigger({ prevTask, updates }: WakeTriggerInput): string | null {
  // The post-update effective values. updates.X === undefined means "no
  // change"; updates.X === '' means "explicitly clear" (distinct from
  // missing). We mirror the route handler's shallow-merge semantics.
  const nextStatus = 'status' in updates ? updates.status : prevTask.status;
  const nextAssignee = 'assignee' in updates ? updates.assignee : prevTask.assignee;

  // A3 — no assignee to wake.
  if (!nextAssignee) return null;

  // T1 — backlog claim. Fires when the (post-update) task is in backlog
  // AND either (a) the status is being set to backlog this update, or
  // (b) the assignee is being set/changed this update. Mirrors the
  // pre-#1494 first branch in updateTask exactly.
  if (
    nextStatus === 'backlog' &&
    (updates.status === 'backlog' || updates.assignee)
  ) {
    return nextAssignee;
  }

  // T2 — in-progress reassignment to a different person.
  if (
    nextStatus === 'in-progress' &&
    updates.assignee &&
    updates.assignee !== prevTask.assignee
  ) {
    return nextAssignee;
  }

  // T3 — #1494 unblock wake. Transition INTO in-progress from anywhere
  // else (blocked, done, planning, qa, etc.). The T2 branch above already
  // handled the (in-progress → in-progress, new assignee) case, so we
  // only get here when the status field is actually flipping.
  if (
    updates.status === 'in-progress' &&
    prevTask.status !== 'in-progress'
  ) {
    return nextAssignee;
  }

  return null;
}
