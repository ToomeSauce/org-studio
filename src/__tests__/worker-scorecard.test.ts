import { describe, it, expect } from 'vitest';
import { computeMedian, computeTimeToDoneMs, countBounces } from '@/lib/worker-scorecard';

describe('#1661 computeTimeToDoneMs', () => {
  it('returns last done minus first in-progress on normal histories', () => {
    const history = [
      { status: 'planning', timestamp: 1000 },
      { status: 'backlog', timestamp: 2000 },
      { status: 'in-progress', timestamp: 3000 },
      { status: 'done', timestamp: 9000 },
    ];
    expect(computeTimeToDoneMs(history)).toBe(6000);
  });

  it('returns null when in-progress is missing', () => {
    const history = [
      { status: 'backlog', timestamp: 1000 },
      { status: 'done', timestamp: 2000 },
    ];
    expect(computeTimeToDoneMs(history)).toBeNull();
  });

  it('returns null for empty history', () => {
    expect(computeTimeToDoneMs([])).toBeNull();
  });
});

describe('#1661 countBounces', () => {
  it('counts done → in-progress as a bounce', () => {
    const history = [
      { status: 'backlog', timestamp: 1000 },
      { status: 'in-progress', timestamp: 2000 },
      { status: 'done', timestamp: 3000 },
      { status: 'in-progress', timestamp: 4000 },
      { status: 'done', timestamp: 5000 },
    ];
    expect(countBounces(history)).toBe(1);
  });

  it('counts done → backlog as a bounce', () => {
    const history = [
      { status: 'in-progress', timestamp: 1000 },
      { status: 'done', timestamp: 2000 },
      { status: 'backlog', timestamp: 3000 },
      { status: 'in-progress', timestamp: 4000 },
      { status: 'done', timestamp: 5000 },
    ];
    expect(countBounces(history)).toBe(1);
  });

  it('ignores blocked transitions both ways', () => {
    const history = [
      { status: 'in-progress', timestamp: 1000 },
      { status: 'blocked', timestamp: 2000 },
      { status: 'backlog', timestamp: 3000 },
      { status: 'in-progress', timestamp: 4000 },
      { status: 'done', timestamp: 5000 },
      { status: 'blocked', timestamp: 6000 },
      { status: 'planning', timestamp: 7000 },
    ];
    expect(countBounces(history)).toBe(0);
  });

  it('returns 0 for empty history', () => {
    expect(countBounces([])).toBe(0);
  });
});

describe('#1661 computeMedian', () => {
  it('returns median for odd and even length arrays', () => {
    expect(computeMedian([5, 1, 3])).toBe(3);
    expect(computeMedian([1, 4, 2, 3])).toBe(2.5);
  });

  it('returns null for empty arrays', () => {
    expect(computeMedian([])).toBeNull();
  });
});
