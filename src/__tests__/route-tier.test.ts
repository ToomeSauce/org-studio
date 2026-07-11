import { describe, expect, it, vi } from 'vitest';
import {
  diagnosticTier,
  persistTierRoute,
  routeTierTask,
} from '@/lib/workers/route-tier';

const workers = [
  { id: 'worker-cheap', tiers: ['trivial', 'standard'] as const },
  { id: 'worker-frontier', tiers: ['complex'] as const },
].map((worker) => ({ ...worker, tiers: [...worker.tiers] }));

describe('model-tier routing (#1692)', () => {
  it('chooses the first configured worker that supports the tier', () => {
    expect(
      routeTierTask({ assignee: 'worker', modelTier: 'standard' }, workers),
    ).toEqual({ reason: 'routed', tier: 'standard', workerId: 'worker-cheap' });
  });

  it('preserves explicit, missing-tier, and unmatched assignments', () => {
    expect(
      routeTierTask({ assignee: 'worker-frontier', modelTier: 'trivial' }, workers)
        .reason,
    ).toBe('explicit-assignee');
    expect(routeTierTask({ assignee: 'worker', modelTier: null }, workers).reason).toBe(
      'no-tier',
    );
    expect(
      routeTierTask(
        { assignee: 'worker', modelTier: 'complex' },
        [{ id: 'worker-cheap', tiers: ['trivial'] }],
      ).reason,
    ).toBe('no-worker-match');
  });

  it('persists with CAS and returns the refreshed actionable snapshot', async () => {
    const refreshed = {
      tasks: [{ id: 't1', assignee: 'worker-cheap', status: 'backlog' }],
    };
    const compareAndSetAssignee = vi.fn().mockResolvedValue(true);
    const result = await persistTierRoute<typeof refreshed>(
      { id: 't1', assignee: 'worker', modelTier: 'trivial' },
      workers,
      {
        hasEnabledLoop: () => true,
        compareAndSetAssignee,
        refresh: vi.fn().mockResolvedValue(refreshed),
      },
    );

    expect(compareAndSetAssignee).toHaveBeenCalledWith('t1', 'worker', 'worker-cheap');
    expect(result).toMatchObject({ reason: 'routed', workerId: 'worker-cheap' });
    expect(result.snapshot).toBe(refreshed);
    expect(result.snapshot?.tasks[0].assignee).toBe('worker-cheap');
  });

  it.each([
    ['CAS loss', false, 'cas-lost'],
    ['CAS error', new Error('db unavailable'), 'cas-error'],
  ])('fails open on %s without exposing a routed snapshot', async (_label, outcome, reason) => {
    const compareAndSetAssignee =
      outcome instanceof Error
        ? vi.fn().mockRejectedValue(outcome)
        : vi.fn().mockResolvedValue(outcome);
    const refresh = vi.fn();
    const result = await persistTierRoute(
      { id: 't1', assignee: 'worker', modelTier: 'trivial' },
      workers,
      { hasEnabledLoop: () => true, compareAndSetAssignee, refresh },
    );

    expect(result.reason).toBe(reason);
    expect(result.snapshot).toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('does not claim work for a configured worker without an enabled loop', async () => {
    const compareAndSetAssignee = vi.fn();
    const result = await persistTierRoute(
      { id: 't1', assignee: 'worker', modelTier: 'complex' },
      workers,
      {
        hasEnabledLoop: () => false,
        compareAndSetAssignee,
        refresh: vi.fn(),
      },
    );
    expect(result.reason).toBe('worker-unavailable');
    expect(compareAndSetAssignee).not.toHaveBeenCalled();
  });

  it('surfaces the active task tier in dispatch diagnostics', () => {
    expect(
      diagnosticTier(
        [
          { assignee: 'worker-cheap', status: 'backlog', modelTier: 'trivial', sortOrder: 2 },
          { assignee: 'worker-cheap', status: 'in-progress', modelTier: 'standard', sortOrder: 8 },
        ],
        ['worker-cheap'],
      ),
    ).toBe('standard');
  });
});
