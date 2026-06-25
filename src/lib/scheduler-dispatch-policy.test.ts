/**
 * #1633 — push-based dispatch policy regression suite.
 *
 * Covers src/lib/scheduler-dispatch-policy.ts: the pure decision layer the
 * scheduler route delegates to for `enable`, `runNow`, and `sync`. The whole
 * point of #1633 is that these actions NEVER (re)create a heavyweight
 * `Scheduler: <agent>` cron with a full agentTurn LLM payload. These tests
 * encode that invariant so a future refactor can't silently bring the loop
 * tax back.
 */
import { describe, it, expect } from 'vitest';
import {
  planEnable,
  planRunNow,
  planSync,
  isLegacySchedulerCronName,
  LEGACY_SCHEDULER_CRON_PREFIX,
  type LoopLike,
  type CronJobLike,
} from './scheduler-dispatch-policy';

describe('planEnable — #1633 enable never creates a cron', () => {
  it('flips enabled on and clears any stale cronJobId, with no cron creation', () => {
    const plan = planEnable();
    expect(plan.createCron).toBe(false);
    expect(plan.setEnabled).toBe(true);
    expect(plan.clearCronJobId).toBe(true);
  });
});

describe('planRunNow — #1633 manual trigger is a direct one-shot', () => {
  it('always fires a one-shot and never routes through a cron job', () => {
    const plan = planRunNow();
    expect(plan.fireOneShot).toBe(true);
    expect(plan.useCron).toBe(false);
  });
});

describe('isLegacySchedulerCronName', () => {
  it('matches the legacy per-agent scheduler cron name prefix', () => {
    expect(isLegacySchedulerCronName(`${LEGACY_SCHEDULER_CRON_PREFIX}Mikey`)).toBe(true);
    expect(isLegacySchedulerCronName('Scheduler: Ana')).toBe(true);
  });
  it('does NOT match unrelated cron jobs', () => {
    expect(isLegacySchedulerCronName('Garage: Morning Trading')).toBe(false);
    expect(isLegacySchedulerCronName('Email check (market hours)')).toBe(false);
    expect(isLegacySchedulerCronName('Vision Launch: Org Studio')).toBe(false);
  });
  it('is null/undefined/non-string safe', () => {
    expect(isLegacySchedulerCronName(undefined)).toBe(false);
    expect(isLegacySchedulerCronName(null)).toBe(false);
    expect(isLegacySchedulerCronName(123)).toBe(false);
  });
});

function loop(overrides: Partial<LoopLike> = {}): LoopLike {
  return { id: 'loop-1', agentId: 'mikey', enabled: true, cronJobId: null, ...overrides };
}

describe('planSync — #1633 sync is a cleanup pass, never recreates crons', () => {
  it('produces NO steps when no loop has a cronJobId and gateway has no scheduler crons', () => {
    const plan = planSync([loop({ cronJobId: null }), loop({ id: 'loop-2', agentId: 'ana', cronJobId: undefined })], []);
    expect(plan.loopSteps).toHaveLength(0);
    expect(plan.orphanSteps).toHaveLength(0);
    expect(plan.cronRemovals).toBe(0);
    expect(plan.storeClears).toBe(0);
  });

  it('removes a live loop-referenced cron AND clears its stored id', () => {
    const cronJobs: CronJobLike[] = [{ id: 'cron-abc', name: 'Scheduler: Mikey' }];
    const plan = planSync([loop({ cronJobId: 'cron-abc' })], cronJobs);
    expect(plan.loopSteps).toHaveLength(1);
    expect(plan.loopSteps[0].removeCronId).toBe('cron-abc');
    expect(plan.loopSteps[0].clearStoredCronJobId).toBe(true);
    expect(plan.cronRemovals).toBe(1);
    expect(plan.storeClears).toBe(1);
  });

  it('clears a dangling stored cronJobId even when the gateway job is already gone', () => {
    // Loop references a cron the gateway no longer has → nothing to remove,
    // but we still clear the stale store reference so it doesn't linger.
    const plan = planSync([loop({ cronJobId: 'cron-ghost' })], []);
    expect(plan.loopSteps).toHaveLength(1);
    expect(plan.loopSteps[0].removeCronId).toBeNull();
    expect(plan.loopSteps[0].clearStoredCronJobId).toBe(true);
    expect(plan.cronRemovals).toBe(0);
    expect(plan.storeClears).toBe(1);
  });

  it('removes orphaned legacy Scheduler crons no loop references anymore', () => {
    const cronJobs: CronJobLike[] = [
      { id: 'cron-orphan', name: 'Scheduler: GhostAgent' },
      { id: 'cron-unrelated', name: 'Garage: Morning Trading' },
    ];
    const plan = planSync([loop({ cronJobId: null })], cronJobs);
    expect(plan.orphanSteps).toHaveLength(1);
    expect(plan.orphanSteps[0].removeCronId).toBe('cron-orphan');
    expect(plan.cronRemovals).toBe(1);
    // Unrelated crons (Garage/Email/etc.) are never touched.
    expect(plan.orphanSteps.some((s) => s.removeCronId === 'cron-unrelated')).toBe(false);
  });

  it('does NOT double-count a cron that is both referenced and present', () => {
    const cronJobs: CronJobLike[] = [{ id: 'cron-abc', name: 'Scheduler: Mikey' }];
    const plan = planSync([loop({ cronJobId: 'cron-abc' })], cronJobs);
    // Referenced → handled as a loop step, NOT also as an orphan.
    expect(plan.orphanSteps).toHaveLength(0);
    expect(plan.cronRemovals).toBe(1);
  });

  it('handles a mixed fleet: live cron, ghost ref, orphan, and unrelated jobs', () => {
    const loops: LoopLike[] = [
      loop({ id: 'l-mikey', agentId: 'mikey', cronJobId: 'cron-live' }),
      loop({ id: 'l-ana', agentId: 'ana', cronJobId: 'cron-ghost' }),
      loop({ id: 'l-sam', agentId: 'sam', cronJobId: null }),
    ];
    const cronJobs: CronJobLike[] = [
      { id: 'cron-live', name: 'Scheduler: Mikey' },
      { id: 'cron-orphan', name: 'Scheduler: FormerAgent' },
      { id: 'cron-garage', name: 'Garage: Afternoon Trading' },
    ];
    const plan = planSync(loops, cronJobs);
    // loop steps: mikey (live, remove+clear), ana (ghost, clear only)
    expect(plan.loopSteps).toHaveLength(2);
    // orphan: FormerAgent's scheduler cron
    expect(plan.orphanSteps.map((s) => s.removeCronId)).toEqual(['cron-orphan']);
    // removals: cron-live + cron-orphan = 2; clears: mikey + ana = 2
    expect(plan.cronRemovals).toBe(2);
    expect(plan.storeClears).toBe(2);
  });

  it('NEVER references cron creation in its output shape (regression guard)', () => {
    const plan = planSync([loop({ cronJobId: 'cron-abc' })], [{ id: 'cron-abc', name: 'Scheduler: Mikey' }]);
    // The plan only ever describes removals/clears — there is no "create" field.
    expect(Object.keys(plan)).toEqual(['loopSteps', 'orphanSteps', 'cronRemovals', 'storeClears']);
  });
});
