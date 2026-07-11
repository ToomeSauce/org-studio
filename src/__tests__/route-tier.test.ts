import { describe, expect, it } from 'vitest';

import { routeTieredWorker } from '@/lib/workers/route-tier';

describe('routeTieredWorker (#1692)', () => {
  type TierWorker = { id: string; tiers: Array<'trivial' | 'standard' | 'complex'> };
  const workers = [
    { id: 'worker-cheap', tiers: ['trivial', 'standard'] },
    { id: 'worker-frontier', tiers: ['complex'] },
  ] satisfies TierWorker[];

  it('routes generic worker by modelTier to first matching worker (cheapest-first)', () => {
    const routed = routeTieredWorker({ assignee: 'worker', modelTier: 'trivial', workers });
    expect(routed.assignee).toBe('worker-cheap');
    expect(routed.reason).toBe('tier-routed');
    expect(routed.tier).toBe('trivial');
  });

  it('keeps explicit worker assignee unchanged (explicit assignee wins)', () => {
    const routed = routeTieredWorker({ assignee: 'worker-frontier', modelTier: 'trivial', workers });
    expect(routed.assignee).toBe('worker-frontier');
    expect(routed.reason).toBe('non-generic-assignee');
  });

  it('fails open when tier is missing', () => {
    const routed = routeTieredWorker({ assignee: 'worker', modelTier: null, workers });
    expect(routed.assignee).toBe('worker');
    expect(routed.reason).toBe('missing-tier');
  });

  it('fails open when no worker matches tier', () => {
    const routed = routeTieredWorker({
      assignee: 'worker',
      modelTier: 'complex',
      workers: [{ id: 'worker-cheap', tiers: ['trivial'] }],
    });
    expect(routed.assignee).toBe('worker');
    expect(routed.reason).toBe('no-match');
  });

  it('treats assignee matching as case-insensitive for generic worker', () => {
    const routed = routeTieredWorker({ assignee: 'Worker', modelTier: 'complex', workers });
    expect(routed.assignee).toBe('worker-frontier');
    expect(routed.reason).toBe('tier-routed');
  });
});
