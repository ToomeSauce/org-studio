import { describe, it, expect } from 'vitest';
import {
  computeMedian,
  computeTierModelScorecard,
  computeTierRecommendations,
  computeTimeToDoneMs,
  countBounces,
  type TierAttemptInput,
  type TierModelMetrics,
  type TierTaskInput,
} from '@/lib/worker-scorecard';

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

const WORKERS = [
  { id: 'worker-cheap', model: 'gpt-mini', tiers: ['trivial', 'standard'] as const },
  { id: 'worker-strong', model: 'gpt-strong', tiers: ['trivial', 'standard', 'complex'] as const },
].map((worker) => ({ ...worker, tiers: [...worker.tiers] }));

function doneTask(
  ticketNumber: number,
  tier: 'trivial' | 'standard' | 'complex',
  by: string,
  history?: TierTaskInput['statusHistory'],
): TierTaskInput {
  return {
    ticketNumber,
    modelTier: tier,
    status: 'done',
    statusHistory: history || [
      { status: 'backlog', timestamp: 100 },
      { status: 'done', timestamp: 1_000, by },
    ],
  };
}

function attempt(
  ticketNumber: number,
  dispatchId: string,
  workerId: string,
  model: string,
  dispatchedAt: number,
  costUsd: number | null,
): TierAttemptInput {
  return { ticketNumber, dispatchId, workerId, model, dispatchedAt, calledAt: dispatchedAt, costUsd };
}

describe('#1694 tier × initial-model scorecard', () => {
  it('attributes retry cost to the initial route and emits a tested demotion advisory', () => {
    const tasks: TierTaskInput[] = [
      doneTask(1, 'trivial', 'worker-cheap'),
      doneTask(2, 'trivial', 'Worker (Cheap)'),
      doneTask(3, 'trivial', 'worker-strong'),
      doneTask(4, 'trivial', 'worker-strong', [
        { status: 'backlog', timestamp: 100 },
        { status: 'done', timestamp: 300, by: 'worker-cheap' },
        { status: 'in-progress', timestamp: 400 },
        { status: 'done', timestamp: 1_000, by: 'worker-strong' },
      ]),
      doneTask(5, 'trivial', 'worker-strong'),
    ];
    const attempts: TierAttemptInput[] = [
      attempt(1, 'a1', 'worker-cheap', 'gpt-mini', 200, 0.1),
      attempt(2, 'a2', 'worker-cheap', 'gpt-mini', 200, 0.1),
      attempt(3, 'a3', 'worker-cheap', 'gpt-mini', 200, 0.1),
      attempt(3, 'a3-retry', 'worker-strong', 'gpt-strong', 500, 0.4),
      attempt(4, 'a4', 'worker-cheap', 'gpt-mini', 200, 0.1),
      attempt(4, 'a4-retry', 'worker-strong', 'gpt-strong', 500, 0.4),
      attempt(5, 'a5', 'worker-cheap', 'gpt-mini', 200, 0.1),
      attempt(5, 'a5-retry', 'worker-strong', 'gpt-strong', 500, 0.4),
    ];

    const result = computeTierModelScorecard(attempts, tasks, WORKERS);

    expect(result.tierModel).toEqual([
      {
        tier: 'trivial',
        model: 'gpt-mini',
        workerIds: ['worker-cheap'],
        tickets: 5,
        ticketsDone: 5,
        firstPassTickets: 2,
        firstPassRate: 0.4,
        bounceCount: 1,
        attemptsToDone: 1.6,
        costTotalUsd: 1.7,
        costPerDoneTicketUsd: 0.34,
      },
    ]);
    expect(result.recommendations).toEqual([
      expect.objectContaining({
        tier: 'trivial',
        model: 'gpt-mini',
        nextModel: 'gpt-strong',
        nextWorkerId: 'worker-strong',
        tickets: 5,
        firstPassRate: 0.4,
      }),
    ]);
  });

  it('excludes stale post-done dispatches and does not call a manual closeout first-pass', () => {
    const task = doneTask(9, 'standard', 'Mikey');
    const result = computeTierModelScorecard(
      [
        attempt(9, 'before-done', 'worker-cheap', 'gpt-mini', 500, 0.2),
        attempt(9, 'stale-after-done', 'worker-strong', 'gpt-strong', 1_500, 9),
      ],
      [task],
      WORKERS,
    );

    expect(result.tierModel[0]).toMatchObject({
      attemptsToDone: 1,
      firstPassTickets: 0,
      costTotalUsd: 0.2,
      costPerDoneTicketUsd: 0.2,
    });
  });

  it('returns unknown cost rather than a misleading partial total when any done attempt is unmetered', () => {
    const result = computeTierModelScorecard(
      [
        attempt(11, 'metered', 'worker-cheap', 'gpt-mini', 200, 0.1),
        attempt(11, 'unmetered-retry', 'worker-strong', 'gpt-strong', 500, null),
      ],
      [doneTask(11, 'standard', 'worker-strong')],
      WORKERS,
    );

    expect(result.tierModel[0]).toMatchObject({
      attemptsToDone: 2,
      costTotalUsd: null,
      costPerDoneTicketUsd: null,
    });
  });

  it('deduplicates multiple metering rows for one dispatch into one attempt', () => {
    const task = doneTask(10, 'standard', 'worker-cheap');
    const result = computeTierModelScorecard(
      [
        attempt(10, 'same-dispatch', 'worker-cheap', 'gpt-mini', 200, 0.1),
        { ...attempt(10, 'same-dispatch', 'worker-cheap', 'gpt-mini', 200, 0.2), calledAt: 250 },
      ],
      [task],
      WORKERS,
    );

    expect(result.tierModel[0]).toMatchObject({
      attemptsToDone: 1,
      firstPassRate: 1,
      costTotalUsd: 0.3,
    });
  });
});

describe('#1694 recommendation guardrails', () => {
  const cell = (overrides: Partial<TierModelMetrics> = {}): TierModelMetrics => ({
    tier: 'trivial',
    model: 'gpt-mini',
    workerIds: ['worker-cheap'],
    tickets: 5,
    ticketsDone: 5,
    firstPassTickets: 2,
    firstPassRate: 0.4,
    bounceCount: 0,
    attemptsToDone: 1.6,
    costTotalUsd: 1,
    costPerDoneTicketUsd: 0.2,
    ...overrides,
  });

  it('requires at least five done tickets and strictly less than 60% first-pass', () => {
    expect(computeTierRecommendations([cell({ ticketsDone: 4 })], WORKERS)).toEqual([]);
    expect(computeTierRecommendations([cell({ firstPassRate: 0.6 })], WORKERS)).toEqual([]);
    expect(computeTierRecommendations([cell({ ticketsDone: 5, firstPassRate: 0.5999 })], WORKERS)).toHaveLength(1);
  });

  it('never recommends beyond the strongest configured worker', () => {
    expect(computeTierRecommendations([
      cell({ model: 'gpt-strong', workerIds: ['worker-strong'] }),
    ], WORKERS)).toEqual([]);
  });
});
