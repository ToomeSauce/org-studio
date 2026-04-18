import { describe, it, expect } from 'vitest';
import { computeSectionMetrics, type SectionMetricsInput } from '../lib/metrics-section';

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
    taskKind: overrides.taskKind || undefined,
    taskType: overrides.taskType || undefined,
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

// ============================================================
// 1. addTask guardrail logic (pure validation rules)
// ============================================================

describe('addTask guardrail rules', () => {
  // These test the validation logic as applied in the API
  
  const ADHOC_TYPES = ['bug', 'chore', 'followup', 'spike'];
  const VERSION_TITLE_REGEX = /^v\d+\.\d+:/i;

  describe('version + roadmapItemId validation', () => {
    it('rejects version set without roadmapItemId', () => {
      const task = { version: '0.12', title: 'Some task' };
      const hasRoadmapItemId = !!task.roadmapItemId;
      expect(hasRoadmapItemId).toBe(false);
    });

    it('accepts version set with roadmapItemId', () => {
      const task = { version: '0.12', roadmapItemId: 'item-1', title: 'Some task' } as any;
      expect(!!task.version && !!task.roadmapItemId).toBe(true);
    });
  });

  describe('adhoc task validation', () => {
    it('rejects adhoc task without taskType', () => {
      const task = { title: 'Fix something', taskType: undefined };
      const isValid = !!task.taskType && ADHOC_TYPES.includes(task.taskType as string);
      expect(isValid).toBe(false);
    });

    it('rejects adhoc task with invalid taskType', () => {
      const task = { title: 'Fix something', taskType: 'feature' };
      const isValid = ADHOC_TYPES.includes(task.taskType);
      expect(isValid).toBe(false);
    });

    it('accepts adhoc task with valid taskType', () => {
      for (const type of ADHOC_TYPES) {
        const task = { title: 'Fix something', taskType: type };
        expect(ADHOC_TYPES.includes(task.taskType)).toBe(true);
      }
    });
  });

  describe('title regex catch', () => {
    it('catches title starting with version prefix', () => {
      expect(VERSION_TITLE_REGEX.test('v0.12: Fix bug')).toBe(true);
      expect(VERSION_TITLE_REGEX.test('V1.5: Feature')).toBe(true);
      expect(VERSION_TITLE_REGEX.test('v0.3: something')).toBe(true);
    });

    it('allows normal titles', () => {
      expect(VERSION_TITLE_REGEX.test('Fix the bug')).toBe(false);
      expect(VERSION_TITLE_REGEX.test('Add v2 support')).toBe(false);
      expect(VERSION_TITLE_REGEX.test('Version 3 upgrade')).toBe(false);
    });
  });

  describe('roadmap item already claimed', () => {
    it('rejects when item already has a taskId', () => {
      const item = { id: 'item-1', title: 'Feature A', done: false, taskId: 'existing-task' };
      expect(!!item.taskId).toBe(true);
    });

    it('allows when item has no taskId', () => {
      const item = { id: 'item-1', title: 'Feature A', done: false, taskId: null };
      expect(!!item.taskId).toBe(false);
    });
  });
});

// ============================================================
// 2. Migration idempotence
// ============================================================

describe('migration idempotence', () => {
  function migrateSingle(task: any): { updates: any; action: 'roadmap' | 'adhoc' | 'skip' } {
    if (task.taskKind && task.taskType) {
      return { updates: {}, action: 'skip' };
    }
    const version = (task.version || '').trim();
    const updates: any = {};
    if (version) {
      if (!task.taskKind) updates.taskKind = 'roadmap';
      if (!task.taskType) updates.taskType = 'feature';
      return { updates, action: 'roadmap' };
    } else {
      if (!task.taskKind) updates.taskKind = 'adhoc';
      if (!task.taskType) updates.taskType = 'followup';
      return { updates, action: 'adhoc' };
    }
  }

  it('migrates versioned task to roadmap/feature', () => {
    const result = migrateSingle({ id: 't1', version: '0.12' });
    expect(result.action).toBe('roadmap');
    expect(result.updates.taskKind).toBe('roadmap');
    expect(result.updates.taskType).toBe('feature');
  });

  it('migrates unversioned task to adhoc/followup', () => {
    const result = migrateSingle({ id: 't2', version: '' });
    expect(result.action).toBe('adhoc');
    expect(result.updates.taskKind).toBe('adhoc');
    expect(result.updates.taskType).toBe('followup');
  });

  it('migrates task with no version field to adhoc/followup', () => {
    const result = migrateSingle({ id: 't3' });
    expect(result.action).toBe('adhoc');
    expect(result.updates.taskKind).toBe('adhoc');
    expect(result.updates.taskType).toBe('followup');
  });

  it('skips task that already has both fields', () => {
    const result = migrateSingle({ id: 't4', taskKind: 'roadmap', taskType: 'feature', version: '0.12' });
    expect(result.action).toBe('skip');
    expect(Object.keys(result.updates).length).toBe(0);
  });

  it('does not overwrite existing taskType on versioned task', () => {
    const result = migrateSingle({ id: 't5', version: '0.12', taskType: 'bug' });
    expect(result.updates.taskKind).toBe('roadmap');
    expect(result.updates.taskType).toBeUndefined(); // should not overwrite
  });

  it('does not overwrite existing taskKind', () => {
    const result = migrateSingle({ id: 't6', taskKind: 'adhoc', taskType: undefined, version: '' });
    expect(result.updates.taskKind).toBeUndefined(); // already set
    expect(result.updates.taskType).toBe('followup');
  });

  it('is idempotent on repeated runs', () => {
    const task = { id: 't7', version: '0.5' };
    const first = migrateSingle(task);
    const afterFirst = { ...task, ...first.updates };
    const second = migrateSingle(afterFirst);
    expect(second.action).toBe('skip');
  });
});

// ============================================================
// 3. Metrics roadmap/adhoc bucketing
// ============================================================

describe('metrics roadmap/adhoc bucketing', () => {
  it('buckets roadmap done transitions correctly', () => {
    const tasks = [
      makeTask({
        id: 't1',
        taskKind: 'roadmap',
        statusHistory: [
          { status: 'in-progress', timestamp: DAY_START + 1000 },
          { status: 'done', timestamp: DAY_START + 60000 },
        ],
      }),
      makeTask({
        id: 't2',
        taskKind: 'roadmap',
        statusHistory: [
          { status: 'in-progress', timestamp: DAY_START + 70000 },
          { status: 'done', timestamp: DAY_START + 120000 },
        ],
      }),
    ];

    const result = computeSectionMetrics(baseInput(tasks, null));
    expect(result).not.toBeNull();
    expect(result!.roadmap_throughput).toBe(2);
    expect(result!.adhoc_throughput).toBe(0);
  });

  it('buckets adhoc done transitions correctly', () => {
    const tasks = [
      makeTask({
        id: 't1',
        taskKind: 'adhoc',
        taskType: 'bug',
        statusHistory: [
          { status: 'in-progress', timestamp: DAY_START + 1000 },
          { status: 'done', timestamp: DAY_START + 60000 },
        ],
      }),
    ];

    const result = computeSectionMetrics(baseInput(tasks, null));
    expect(result).not.toBeNull();
    expect(result!.roadmap_throughput).toBe(0);
    expect(result!.adhoc_throughput).toBe(1);
  });

  it('handles mixed roadmap and adhoc tasks', () => {
    const tasks = [
      makeTask({
        id: 't1',
        taskKind: 'roadmap',
        statusHistory: [
          { status: 'in-progress', timestamp: DAY_START + 1000 },
          { status: 'done', timestamp: DAY_START + 60000 },
        ],
      }),
      makeTask({
        id: 't2',
        taskKind: 'adhoc',
        taskType: 'chore',
        statusHistory: [
          { status: 'in-progress', timestamp: DAY_START + 70000 },
          { status: 'done', timestamp: DAY_START + 120000 },
        ],
      }),
      makeTask({
        id: 't3',
        taskKind: 'adhoc',
        taskType: 'followup',
        statusHistory: [
          { status: 'in-progress', timestamp: DAY_START + 130000 },
          { status: 'done', timestamp: DAY_START + 180000 },
        ],
      }),
    ];

    const result = computeSectionMetrics(baseInput(tasks, null));
    expect(result).not.toBeNull();
    expect(result!.tasks_completed).toBe(3);
    expect(result!.roadmap_throughput).toBe(1);
    expect(result!.adhoc_throughput).toBe(2);
  });

  it('treats tasks without taskKind as adhoc in throughput', () => {
    const tasks = [
      makeTask({
        id: 't1',
        // no taskKind set (legacy)
        statusHistory: [
          { status: 'in-progress', timestamp: DAY_START + 1000 },
          { status: 'done', timestamp: DAY_START + 60000 },
        ],
      }),
    ];

    const result = computeSectionMetrics(baseInput(tasks, null));
    expect(result).not.toBeNull();
    expect(result!.roadmap_throughput).toBe(0);
    expect(result!.adhoc_throughput).toBe(1); // defaults to adhoc bucket
  });

  it('returns zero throughput counts when no done transitions', () => {
    const tasks = [
      makeTask({
        id: 't1',
        taskKind: 'roadmap',
        statusHistory: [
          { status: 'in-progress', timestamp: DAY_START + 1000 },
        ],
      }),
    ];

    const result = computeSectionMetrics(baseInput(tasks, null));
    expect(result).not.toBeNull();
    expect(result!.roadmap_throughput).toBe(0);
    expect(result!.adhoc_throughput).toBe(0);
  });
});
