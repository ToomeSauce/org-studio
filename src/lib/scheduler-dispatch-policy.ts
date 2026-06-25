/**
 * Push-based dispatch policy (#1633).
 *
 * Background — the LLM "loop tax":
 *   Org Studio used to enable an agent's work loop by creating a recurring
 *   Gateway cron job named `Scheduler: <agent>`. Each job carried a full
 *   `agentTurn` payload (the entire work-loop prompt) and fired every
 *   `intervalMinutes` regardless of whether the agent had any actionable
 *   work. That is a heavyweight autonomous LLM loop running on a timer — the
 *   "tax" Basil flagged on 2026-06-25 (it was waking agents — and pegging the
 *   host — even with an empty backlog).
 *
 * The replacement model:
 *   Dispatch is **event-driven**. When a task lands in an agent's backlog the
 *   store route calls `/api/scheduler { action: 'trigger', agentId }`, which
 *   runs `fireOneShot` and pushes a focused dispatch message to the agent's
 *   main session. This path keys off the loop's `enabled` flag — NOT its
 *   `cronJobId` — so it works with zero recurring cron jobs. Manual dispatch
 *   (`runNow`) fires the same one-shot directly.
 *
 * This module is the **pure decision layer** for the three lifecycle actions
 * that used to touch cron (`enable`, `runNow`, `sync`). Keeping the logic here
 * (and unit-tested) means the route handler and the test suite can't silently
 * drift, and the "never recreate a heavy Scheduler cron" invariant is encoded
 * in one place.
 *
 * Invariants encoded here:
 *   - `enable` never creates a cron job. It only flips the loop on so the
 *     event-driven `trigger` path will dispatch.
 *   - `runNow` always fires a direct one-shot. It never depends on a cron job
 *     existing.
 *   - `sync` is a **cleanup** pass: it REMOVES any lingering `Scheduler:`
 *     cron jobs and clears their stored `cronJobId`. It never (re)creates one,
 *     so a sync can't silently resurrect the heavy loop.
 */

/** Minimal shape of an AgentLoop this policy reasons about. */
export interface LoopLike {
  id: string;
  agentId: string;
  enabled: boolean;
  /** Gateway cron job id, if a legacy heavy Scheduler cron was ever attached. */
  cronJobId?: string | null;
}

/** Prefix used for the legacy per-agent scheduler cron job names. */
export const LEGACY_SCHEDULER_CRON_PREFIX = 'Scheduler: ';

/**
 * Does a Gateway cron job name look like a legacy per-agent scheduler loop?
 * Used by `sync` to find heavy crons to remove even when the store lost the
 * `cronJobId` reference (so they can't be silently re-orphaned).
 */
export function isLegacySchedulerCronName(name: unknown): boolean {
  return typeof name === 'string' && name.startsWith(LEGACY_SCHEDULER_CRON_PREFIX);
}

/**
 * Decision for `enable`: push-based dispatch needs no cron. We only ensure the
 * loop is marked enabled so the event-driven `trigger` path will fire.
 */
export function planEnable(): { createCron: false; setEnabled: true; clearCronJobId: true } {
  return { createCron: false, setEnabled: true, clearCronJobId: true };
}

/**
 * Decision for `runNow`: always fire a direct one-shot. No cron.run hop, so a
 * manual trigger works whether or not any cron job exists.
 */
export function planRunNow(): { fireOneShot: true; useCron: false } {
  return { fireOneShot: true, useCron: false };
}

/** Per-loop reconciliation step produced by `planSync`. */
export interface LoopSyncStep {
  loopId: string;
  agentId: string;
  /** Gateway cron job id to delete, or null when there's nothing live to remove. */
  removeCronId: string | null;
  /** Whether the loop's stored `cronJobId` should be nulled out. */
  clearStoredCronJobId: boolean;
}

/** A Gateway cron job we discovered that isn't referenced by any loop. */
export interface OrphanCronStep {
  removeCronId: string;
  name: string;
}

export interface SyncPlan {
  /** Per-loop steps (only loops that need a change are included). */
  loopSteps: LoopSyncStep[];
  /**
   * Legacy `Scheduler:` cron jobs found on the Gateway that no loop points at
   * anymore (e.g. the store row was wiped). These are removed too so a stale
   * heavy loop can't keep firing invisibly.
   */
  orphanSteps: OrphanCronStep[];
  /** Total number of cron jobs that will be removed. */
  cronRemovals: number;
  /** Total number of loops whose stored cronJobId will be cleared. */
  storeClears: number;
}

/** A Gateway cron job as returned by `cron.list` (only the fields we read). */
export interface CronJobLike {
  id: string;
  name?: string;
}

/**
 * Decision for `sync`: a cleanup pass that tears down the legacy heavy
 * Scheduler crons and never recreates them.
 *
 * For every loop:
 *   - If it has a stored `cronJobId`, schedule the stored reference to be
 *     cleared, and — if that job still exists on the Gateway — schedule the
 *     job for removal.
 *
 * Separately, any `Scheduler:`-named cron on the Gateway that isn't referenced
 * by a loop's `cronJobId` is treated as an orphan and removed too.
 *
 * Note: there is intentionally NO branch that creates a cron. Push dispatch is
 * driven by `enabled` + the event `trigger`, so `sync` is purely subtractive.
 */
export function planSync(loops: LoopLike[], cronJobs: CronJobLike[] = []): SyncPlan {
  const existingCronIds = new Set(cronJobs.map((j) => j.id));
  const referencedCronIds = new Set<string>();

  const loopSteps: LoopSyncStep[] = [];
  for (const loop of loops) {
    const cronJobId = loop.cronJobId || null;
    if (!cronJobId) continue; // nothing attached → nothing to clean up
    referencedCronIds.add(cronJobId);
    const liveOnGateway = existingCronIds.has(cronJobId);
    loopSteps.push({
      loopId: loop.id,
      agentId: loop.agentId,
      removeCronId: liveOnGateway ? cronJobId : null,
      clearStoredCronJobId: true,
    });
  }

  // Orphaned legacy Scheduler crons: live on the Gateway, named like a per-agent
  // scheduler loop, but no loop references them. Remove so they stop firing.
  const orphanSteps: OrphanCronStep[] = [];
  for (const job of cronJobs) {
    if (referencedCronIds.has(job.id)) continue;
    if (!isLegacySchedulerCronName(job.name)) continue;
    orphanSteps.push({ removeCronId: job.id, name: job.name as string });
  }

  const cronRemovals =
    loopSteps.filter((s) => s.removeCronId).length + orphanSteps.length;
  const storeClears = loopSteps.filter((s) => s.clearStoredCronJobId).length;

  return { loopSteps, orphanSteps, cronRemovals, storeClears };
}
