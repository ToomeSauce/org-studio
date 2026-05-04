/**
 * Tests for per-section metric computation
 */
import { describe, test, expect } from 'vitest';
import { computeSectionMetrics, SectionMetricsInput } from './metrics-section';

const DAY = '2025-04-15';
const DAY_START = new Date(`${DAY}T00:00:00Z`).getTime();
const DAY_END = DAY_START + 24 * 60 * 60 * 1000;

function makeTask(overrides: any = {}) {
  return {
    id: overrides.id || 'task-1',
    assignee: 'bot',
    sectionId: overrides.sectionId || null,
    statusHistory: overrides.statusHistory || [],
    reviewNotes: overrides.reviewNotes || null,
    testPlan: overrides.testPlan || null,
    loopPausedAt: overrides.loopPausedAt || null,
    ...overrides,
  };
}

function baseInput(tasks: any[], sectionId?: string | null): SectionMetricsInput {
  return {
    agentTasks: tasks,
    agentNameLower: 'bot',
    agentIdLower: 'bot-id',
    dayStart: DAY_START,
    dayEnd: DAY_END,
    sectionId: sectionId === undefined ? null : sectionId,
  };
}

describe('computeSectionMetrics', () => {
  test('returns null when there is zero activity', () => {
    const result = computeSectionMetrics(baseInput([]));
    expect(result).toBeNull();
  });

  test('returns null for a section with no matching tasks', () => {
    const task = makeTask({
      sectionId: 'sec-other',
      statusHistory: [
        { status: 'in-progress', timestamp: DAY_START + 1000 },
        { status: 'done', timestamp: DAY_START + 60000 },
      ],
    });
    const result = computeSectionMetrics(baseInput([task], 'sec-mine'));
    expect(result).toBeNull();
  });

  test('counts tasks completed and started for all tasks (no section filter)', () => {
    const tasks = [
      makeTask({
        id: 't1',
        sectionId: 'sec-a',
        statusHistory: [
          { status: 'in-progress', timestamp: DAY_START + 1000 },
          { status: 'done', timestamp: DAY_START + 60000 },
        ],
      }),
      makeTask({
        id: 't2',
        sectionId: 'sec-b',
        statusHistory: [
          { status: 'in-progress', timestamp: DAY_START + 70000 },
          { status: 'done', timestamp: DAY_START + 120000 },
        ],
      }),
    ];

    const result = computeSectionMetrics(baseInput(tasks, null));
    expect(result).not.toBeNull();
    expect(result!.tasks_completed).toBe(2);
    expect(result!.tasks_started).toBe(2);
  });

  test('filters tasks to specific section', () => {
    const tasks = [
      makeTask({
        id: 't1',
        sectionId: 'sec-a',
        statusHistory: [
          { status: 'in-progress', timestamp: DAY_START + 1000 },
          { status: 'done', timestamp: DAY_START + 60000 },
        ],
      }),
      makeTask({
        id: 't2',
        sectionId: 'sec-b',
        statusHistory: [
          { status: 'in-progress', timestamp: DAY_START + 70000 },
          { status: 'done', timestamp: DAY_START + 120000 },
        ],
      }),
    ];

    const result = computeSectionMetrics(baseInput(tasks, 'sec-a'));
    expect(result).not.toBeNull();
    expect(result!.tasks_completed).toBe(1);
    expect(result!.tasks_started).toBe(1);
  });

  test('detects bounces within a section', () => {
    const task = makeTask({
      sectionId: 'sec-a',
      statusHistory: [
        { status: 'in-progress', timestamp: DAY_START + 1000 },
        { status: 'review', timestamp: DAY_START + 30000 },
        { status: 'in-progress', timestamp: DAY_START + 40000 }, // bounce
        { status: 'done', timestamp: DAY_START + 60000 },
      ],
    });

    const result = computeSectionMetrics(baseInput([task], 'sec-a'));
    expect(result).not.toBeNull();
    expect(result!.bounce_count).toBe(1);
    // Not first-pass since it bounced
    expect(result!.first_pass_rate).toBe(0);
  });

  test('computes duration and throughput', () => {
    const task = makeTask({
      statusHistory: [
        { status: 'in-progress', timestamp: DAY_START + 0 },
        { status: 'done', timestamp: DAY_START + 600000 }, // 10 minutes
      ],
    });

    const result = computeSectionMetrics(baseInput([task], null));
    expect(result).not.toBeNull();
    expect(result!.avg_duration_min).toBe(10);
    expect(result!.median_duration_min).toBe(10);
    expect(result!.throughput).not.toBeNull();
    expect(result!.active_minutes).toBe(10);
  });

  test('ignores tasks outside the day window', () => {
    const task = makeTask({
      statusHistory: [
        { status: 'in-progress', timestamp: DAY_START - 100000 },
        { status: 'done', timestamp: DAY_START - 50000 },
      ],
    });

    const result = computeSectionMetrics(baseInput([task], null));
    expect(result).toBeNull();
  });

  test('counts stalls', () => {
    const task = makeTask({
      sectionId: 'sec-a',
      loopPausedAt: DAY_START + 5000,
      statusHistory: [
        { status: 'in-progress', timestamp: DAY_START + 1000 },
      ],
    });

    const result = computeSectionMetrics(baseInput([task], 'sec-a'));
    expect(result).not.toBeNull();
    expect(result!.stall_count).toBe(1);
  });

  test('computes review_notes_rate and test_plan_rate', () => {
    const tasks = [
      makeTask({
        id: 't1',
        reviewNotes: 'looks good',
        testPlan: 'manual test',
        statusHistory: [
          { status: 'in-progress', timestamp: DAY_START + 1000 },
          { status: 'done', timestamp: DAY_START + 60000 },
        ],
      }),
      makeTask({
        id: 't2',
        statusHistory: [
          { status: 'in-progress', timestamp: DAY_START + 70000 },
          { status: 'done', timestamp: DAY_START + 120000 },
        ],
      }),
    ];

    const result = computeSectionMetrics(baseInput(tasks, null));
    expect(result).not.toBeNull();
    expect(result!.review_notes_rate).toBe(0.5);
    expect(result!.test_plan_rate).toBe(0.5);
  });

  test('first_pass_rate is 1 when no bounces', () => {
    const task = makeTask({
      statusHistory: [
        { status: 'in-progress', timestamp: DAY_START + 1000 },
        { status: 'review', timestamp: DAY_START + 30000 },
        { status: 'done', timestamp: DAY_START + 60000 },
      ],
    });

    const result = computeSectionMetrics(baseInput([task], null));
    expect(result).not.toBeNull();
    expect(result!.first_pass_rate).toBe(1);
  });
});
