/**
 * #1535 — single source of truth for task-status transitions.
 *
 * Builds the field patch + side-effect descriptor for ANY status-change
 * write across the codebase. Pure data; performs no I/O. The caller
 * applies the patch through whatever write path it owns (provider
 * updateTask, raw SQL UPDATE in a transaction, etc) and triggers the
 * side effects after the write succeeds.
 *
 * # Background
 *
 * Before this helper existed, three sites in the codebase hand-rolled
 * the same status-change bookkeeping:
 *   1. src/app/api/store/route.ts updateTask (the canonical impl)
 *   2. src/lib/lease-bounce.ts (lease-expiry → backlog)
 *   3. src/lib/project-state.ts promoteProjectToNextVersion
 *      (planning → backlog on version flip)
 *
 * Site 3 silently forgot to append to statusHistory for months. That
 * shipped as the #1531 bug. This helper exists so any new status writer
 * automatically gets all of the bookkeeping, and the invariant test in
 * `src/__tests__/status-transition-invariant.test.ts` enforces that no
 * direct `UPDATE org_studio_tasks SET status` SQL exists outside this
 * file.
 *
 * # What gets bundled together
 *
 * Every status flip MUST do all of these atomically:
 *   - flip typed `status` column
 *   - append a `{status, timestamp, by, model?}` entry to statusHistory
 *   - bump `lastActivityAt`
 *   - reset loop detection (loopCount=0, loopPausedAt=null, loopPauseReason=null)
 *   - manage claim lease (`claim_started_at`, `claim_lease_expires_at`)
 *
 * The historic drift between these was the bug class #1531 closed. This
 * helper makes "forget one" mechanically impossible.
 */

export type TaskStatus =
  | 'planning'
  | 'backlog'
  | 'in-progress'
  | 'qa'
  | 'review'
  | 'done'
  | 'blocked';

export interface StatusTransitionInput {
  /** The current task — read fresh from the store before calling. */
  task: {
    id: string;
    status?: string;
    statusHistory?: Array<Record<string, any>>;
    assignee?: string;
    [k: string]: any;
  };
  /** Target status. */
  newStatus: TaskStatus;
  /** Who/what is performing the transition (`'Mikey'`, `'System'`, `'lease-bounce'`, etc). */
  by: string;
  /** Optional model id, when an agent is moving the task. */
  model?: string | null;
  /** Wall-clock timestamp; defaulted to `Date.now()` for testability. */
  now?: number;
  /**
   * Lease duration when moving INTO `in-progress`. Defaults to 60 min,
   * the Basil-confirmed value used by both the canonical updateTask
   * path and the claim-contract helper.
   */
  leaseWindowMs?: number;
  /**
   * When true, the lease-bounce flavor: clears `assignee` and stamps a
   * `_lastDispatchedAt: null` reset. Lease bounces are the only path
   * that detaches the agent from the task during a status change.
   */
  detachAssignee?: boolean;
}

export interface StatusTransitionOutput {
  /**
   * Field patch the caller should apply. Caller chooses how (provider
   * updateTask, raw SQL UPDATE column names, etc) — the patch uses
   * JS-side field names matching the in-memory Task type, and callers
   * mapping to SQL columns are responsible for that translation.
   *
   * Always includes every field this helper mutates so callers don't
   * have to remember which ones to set.
   */
  updates: Record<string, any>;
  /**
   * Whether the typed status actually changed. False for no-op
   * transitions (`newStatus === task.status`). Callers should usually
   * short-circuit on `!changed`.
   */
  changed: boolean;
  /**
   * Side-effect plan. Pure description — the caller decides when to
   * fire each (typically AFTER the DB write succeeds).
   */
  sideEffects: {
    /**
     * True iff Telegram/notification routing should fire. Matches the
     * legacy rule from route.ts: fires when leaving in-progress, OR
     * entering in-progress/done/blocked.
     */
    notify: boolean;
    /**
     * True iff this transition should trigger the
     * "all-tasks-on-this-version-now-done" check in the caller. Only
     * true when newStatus === 'done' and the task has a version.
     */
    checkVersionCompletion: boolean;
  };
}

/**
 * # Build a status-transition patch.
 *
 * No DB calls; pure function over the input. The caller writes the
 * `updates` through its own path (provider.updateTask, raw SQL with
 * column-name translation, etc) and then fires the side effects from
 * the returned plan.
 *
 * ## Example: through the provider (route.ts updateTask)
 *
 * ```ts
 * const { updates, changed, sideEffects } = buildStatusTransition({
 *   task: t,
 *   newStatus: payload.updates.status,
 *   by: t.assignee,
 *   model: await resolveAgentModel(t.assignee, store),
 * });
 * if (!changed) return; // no-op
 * Object.assign(updates, payload.updates); // caller's other fields
 * await provider.updateTask(t.id, updates);
 * if (sideEffects.notify) notifyTaskStatusChange(merged, updates.status, store);
 * ```
 *
 * ## Example: through raw SQL in a transaction (promoteProjectToNextVersion)
 *
 * ```ts
 * const { updates } = buildStatusTransition({
 *   task: row,
 *   newStatus: 'backlog',
 *   by: 'system-promote',
 * });
 * await client.query(
 *   `UPDATE org_studio_tasks
 *      SET status = $1, version = $2, status_history = COALESCE(status_history,'[]'::jsonb) || $3::jsonb,
 *          last_activity_at = $4, loop_count = 0, loop_paused_at = NULL, loop_pause_reason = NULL,
 *          claim_started_at = NULL, claim_lease_expires_at = NULL
 *    WHERE id = $5`,
 *   [updates.status, version, JSON.stringify(updates.statusHistory!.slice(-1)), updates.lastActivityAt, row.id],
 * );
 * ```
 */
export function buildStatusTransition(
  input: StatusTransitionInput,
): StatusTransitionOutput {
  const {
    task,
    newStatus,
    by,
    model = null,
    now = Date.now(),
    leaseWindowMs = 60 * 60 * 1000,
    detachAssignee = false,
  } = input;

  const fromStatus = task.status;
  const changed = newStatus !== fromStatus;

  if (!changed) {
    return {
      updates: {},
      changed: false,
      sideEffects: { notify: false, checkVersionCompletion: false },
    };
  }

  const historyEntry: Record<string, any> = {
    status: newStatus,
    timestamp: now,
    by,
  };
  if (model !== undefined && model !== null) historyEntry.model = model;

  const updates: Record<string, any> = {
    status: newStatus,
    statusHistory: [...(task.statusHistory || []), historyEntry],
    lastActivityAt: now,
    loopCount: 0,
    loopPausedAt: null,
    loopPauseReason: null,
  };

  // #1352 — lease lifecycle. Moving INTO in-progress → fresh lease.
  // Moving OUT of in-progress → clear. Idempotent on no-op transitions
  // (guarded above by the !changed early return).
  if (newStatus === 'in-progress') {
    updates.claim_started_at = now;
    updates.claim_lease_expires_at = now + leaseWindowMs;
  } else {
    updates.claim_started_at = null;
    updates.claim_lease_expires_at = null;
  }

  if (detachAssignee) {
    updates.assignee = '';
    updates._lastDispatchedAt = null;
  }

  // Notification rule mirrors route.ts: fires when leaving in-progress
  // OR entering in-progress/done/blocked. Anything else is silent.
  const notify =
    fromStatus === 'in-progress' ||
    newStatus === 'in-progress' ||
    newStatus === 'done' ||
    newStatus === 'blocked';

  return {
    updates,
    changed: true,
    sideEffects: {
      notify,
      checkVersionCompletion: newStatus === 'done',
    },
  };
}

/**
 * # Sentinel for invariant-test allowlisting.
 *
 * The invariant test (status-transition-invariant.test.ts) greps `src/**`
 * for `UPDATE org_studio_tasks SET status` and fails if any match isn't
 * tagged with this string nearby. promoteProjectToNextVersion is the one
 * legitimate raw-SQL status writer (it's inside a transaction with other
 * version-flip writes); it tags its UPDATE with `STATUS_TRANSITION_ALLOWED`
 * directly above to opt in.
 */
export const STATUS_TRANSITION_ALLOWED = 'STATUS_TRANSITION_ALLOWED';
