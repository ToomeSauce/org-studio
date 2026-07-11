import { describe, expect, it } from 'vitest';
import type { ModelTier } from '@/lib/model-tier';
import { routeTierTask } from '@/lib/workers/route-tier';

describe('routeTierTask (#1692)', () => {
  const tier = <T extends readonly ModelTier[]>(value: T) => value as unknown as ModelTier[];
  const workers = [
    { id: 'worker-cheap', tiers: tier(['trivial', 'standard'] as const) },
    { id: 'worker-premium', tiers: tier(['complex'] as const) },
  ];

  it('routes generic worker task to first matching worker (cheapest by order)', () => {
    const d = routeTierTask(
      { assignee: 'worker', modelTier: 'standard' },
      workers,
    );
    expect(d).toEqual({
      reason: 'routed',
      tier: 'standard',
      workerId: 'worker-cheap',
    });
  });

  it('does not route explicitly assigned tickets', () => {
    const d = routeTierTask(
      { assignee: 'worker-premium', modelTier: 'complex' },
      workers,
    );
    expect(d.reason).toBe('explicit-assignee');
    expect(d.workerId).toBeUndefined();
  });

  it('fails open when modelTier is missing', () => {
    const d = routeTierTask(
      { assignee: 'worker', modelTier: null },
      workers,
    );
    expect(d).toEqual({ reason: 'no-tier', tier: null });
  });

  it('fails open when no worker supports the tier', () => {
    const d = routeTierTask(
      { assignee: 'worker', modelTier: 'complex' },
      [{ id: 'worker-cheap', tiers: tier(['trivial', 'standard'] as const) }],
    );
    expect(d).toEqual({ reason: 'no-worker-match', tier: 'complex' });
  });
});
