/**
 * Level 3 lease auto-bounce with read-back verification (#1493).
 *
 * Background — the pre-#1493 path was a single try/`updateTask`/catch with
 * no verification. On at least one observed occurrence (#1487, 2026-05-21
 * 07:48 EDT) the Level 3 system comment landed but the corresponding task
 * write didn't, leaving the task stuck `in-progress` with stale claim
 * fields and zero forensics. The catch swallowed whatever happened.
 *
 * This helper centralizes the bounce write with:
 *   1. Pre-write re-read so the statusHistory we append to is fresh.
 *   2. Skip-if-no-longer-in-progress (the agent may have moved already).
 *   3. The `updateTask` write.
 *   4. Post-write read-back verify (status===backlog, assignee==='').
 *   5. One retry on verify mismatch OR exception.
 *   6. Optional activity-feed sink for hard-failure surfacing.
 *
 * Pure-ish: all IO is injected via `provider` + `feedSink`, all timing via
 * `now`. No `Date.now()`, no `process.env`, no globals. Easy to unit-test.
 */
import { buildStatusTransition } from "./task-status";


export type BounceProvider = {
  read: () => Promise<{ tasks: any[] }>;
  updateTask: (taskId: string, updates: Record<string, any>) => Promise<any>;
};

export type BounceActivityFeed = {
  add: (event: Record<string, any>) => void;
};

export type BounceTaskSnapshot = {
  id: string;
  title?: string;
  ticketNumber?: number;
  projectId?: string;
  statusHistory?: any[];
};

export type BounceOutcome =
  | { ok: true; reason: 'verified' | 'no-longer-in-progress' | 'task-vanished' }
  | {
      ok: false;
      reason: 'verify-mismatch' | 'threw';
      attempts: number;
      observedStatus?: string;
      observedAssignee?: string;
      error?: string;
    };

const LEASE_BOUNCE_HISTORY_BY =
  'System (lease-bounce: stale-claim Level 3)';

/**
 * Perform the Level 3 auto-bounce write with verification + retry.
 *
 * Always best-effort: never throws. Caller should not gate the rest of the
 * escalation on this result.
 */
export async function bounceLeaseLevel3(
  provider: BounceProvider,
  taskSnapshot: BounceTaskSnapshot,
  assigneeName: string,
  now: number,
  opts: {
    feedSink?: BounceActivityFeed | null;
    logger?: { warn: (msg: string) => void; log: (msg: string) => void };
    maxAttempts?: number;
  } = {},
): Promise<BounceOutcome> {
  const log = opts.logger ?? {
    // eslint-disable-next-line no-console
    warn: (m) => console.warn(m),
    // eslint-disable-next-line no-console
    log: (m) => console.log(m),
  };
  const maxAttempts = opts.maxAttempts ?? 2;
  const tag = `[lease-bounce #1493]`;

  let lastErr: any = null;
  let lastObservedStatus: string | undefined;
  let lastObservedAssignee: string | undefined;
  let lastReason: 'verify-mismatch' | 'threw' = 'threw';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // 1. Re-read fresh.
      const freshStore = await provider.read();
      const freshTask = freshStore.tasks.find((t: any) => t.id === taskSnapshot.id);
      if (!freshTask) {
        log.warn(
          `${tag} attempt=${attempt} task=${taskSnapshot.id} status=GONE ` +
          `— nothing to bounce. Giving up.`,
        );
        return { ok: true, reason: 'task-vanished' };
      }
      lastObservedStatus = freshTask.status;
      lastObservedAssignee = freshTask.assignee;

      if (freshTask.status !== 'in-progress') {
        log.warn(
          `${tag} attempt=${attempt} task=${taskSnapshot.id} ` +
          `status=${freshTask.status} (no longer in-progress) — skip bounce, ` +
          `agent already moved off this task.`,
        );
        return { ok: true, reason: 'no-longer-in-progress' };
      }

      // 2. Build update via the single source of truth (#1535).
      //    Pass `detachAssignee: true` to get the lease-bounce flavor:
      //    clears assignee and stamps _lastDispatchedAt=null. Lease bounce
      //    is the only status writer that detaches the agent during the
      //    transition.
      const { updates } = buildStatusTransition({
        task: freshTask,
        newStatus: 'backlog',
        by: LEASE_BOUNCE_HISTORY_BY,
        now,
        detachAssignee: true,
      });

      // 3. Write.
      await provider.updateTask(taskSnapshot.id, updates);

      // 4. Read-back verify.
      const verifyStore = await provider.read();
      const verifyTask = verifyStore.tasks.find((t: any) => t.id === taskSnapshot.id);
      if (!verifyTask) {
        log.warn(
          `${tag} attempt=${attempt} task=${taskSnapshot.id} ` +
          `post-write read returned no task. Treating as success (concurrent delete).`,
        );
        return { ok: true, reason: 'task-vanished' };
      }
      const aOk = !verifyTask.assignee || verifyTask.assignee === '';
      if (verifyTask.status === 'backlog' && aOk) {
        log.log(
          `${tag} attempt=${attempt} task=${taskSnapshot.id} ` +
          `status: in-progress → backlog, assignee: ${assigneeName} → (cleared). ` +
          `Lease bounce verified landed.`,
        );
        return { ok: true, reason: 'verified' };
      }

      // Write returned ok but state didn't move — the #1493 bug pattern.
      lastReason = 'verify-mismatch';
      lastErr = new Error(
        `post-write verify mismatch: expected status=backlog assignee='', ` +
        `observed status=${verifyTask.status} ` +
        `assignee=${JSON.stringify(verifyTask.assignee)}`,
      );
      lastObservedStatus = verifyTask.status;
      lastObservedAssignee = verifyTask.assignee;
      log.warn(
        `${tag} attempt=${attempt} task=${taskSnapshot.id} ⚠️ WRITE-LOST: ` +
        `provider.updateTask returned without throwing but state did NOT change. ` +
        `Expected status=backlog assignee=''. Observed status=${verifyTask.status} ` +
        `assignee=${JSON.stringify(verifyTask.assignee)}. ` +
        (attempt < maxAttempts ? 'Retrying.' : 'Giving up.'),
      );
    } catch (err: any) {
      lastReason = 'threw';
      lastErr = err;
      log.warn(
        `${tag} attempt=${attempt} task=${taskSnapshot.id} ` +
        `provider.updateTask threw: ${err?.message || err}. ` +
        (attempt < maxAttempts ? 'Retrying.' : 'Giving up.'),
      );
    }
  }

  // Hard-fail after retry — surface to activity feed.
  if (opts.feedSink && typeof opts.feedSink.add === 'function') {
    try {
      opts.feedSink.add({
        kind: 'lease-bounce-failed',
        taskId: taskSnapshot.id,
        ticketNumber: taskSnapshot.ticketNumber,
        title: taskSnapshot.title,
        assignee: assigneeName,
        projectId: taskSnapshot.projectId,
        observedStatus: lastObservedStatus,
        observedAssignee: lastObservedAssignee,
        error: lastErr?.message || String(lastErr || 'unknown'),
        emoji: '🚨',
        label:
          `Lease-bounce write LOST for #${taskSnapshot.ticketNumber || '?'} ` +
          `(${assigneeName}) — task remains ${lastObservedStatus || 'in-progress'}. ` +
          `Manual: move to backlog + clear assignee. See journal for details.`,
      });
    } catch {} // best-effort
  }

  log.warn(
    `${tag} FINAL: task=${taskSnapshot.id} ticket=#${taskSnapshot.ticketNumber || '?'} ` +
    `assignee=${assigneeName} — bounce did not land after ${maxAttempts} attempts. ` +
    `System comment + loop-disable already applied; only the task-state write failed. ` +
    `Activity feed event ${opts.feedSink ? 'emitted' : 'NOT emitted (no sink)'}.`,
  );

  return {
    ok: false,
    reason: lastReason,
    attempts: maxAttempts,
    observedStatus: lastObservedStatus,
    observedAssignee: lastObservedAssignee,
    error: lastErr?.message || String(lastErr || 'unknown'),
  };
}
