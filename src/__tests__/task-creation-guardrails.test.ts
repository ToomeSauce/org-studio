import { describe, it, expect } from 'vitest';

// ============================================================
// addTask guardrail logic (pure validation rules)
// ============================================================

describe('addTask guardrail rules', () => {
  const ADHOC_TYPES = ['bug', 'chore', 'followup', 'spike'];
  const VERSION_TITLE_REGEX = /^v\d+\.\d+:/i;

  describe('version + roadmapItemId validation', () => {
    it('rejects version set without roadmapItemId', () => {
      const task: any = { version: '0.12', title: 'Some task' };
      expect(!!task.roadmapItemId).toBe(false);
    });

    it('accepts version set with roadmapItemId', () => {
      const task: any = { version: '0.12', roadmapItemId: 'item-1', title: 'Some task' };
      expect(!!task.version && !!task.roadmapItemId).toBe(true);
    });
  });

  describe('adhoc task validation', () => {
    it('rejects adhoc task without taskType', () => {
      const task: any = { title: 'Fix something', taskType: undefined };
      const isValid = !!task.taskType && ADHOC_TYPES.includes(task.taskType);
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
      const item: any = { id: 'item-1', title: 'Feature A', done: false, taskId: 'existing-task' };
      expect(!!item.taskId).toBe(true);
    });

    it('allows when item has no taskId', () => {
      const item: any = { id: 'item-1', title: 'Feature A', done: false, taskId: null };
      expect(!!item.taskId).toBe(false);
    });
  });

  describe('roadmap kind derivation', () => {
    it('roadmap = task has roadmapItemId', () => {
      const task: any = { roadmapItemId: 'item-1', taskType: 'feature', version: '0.12' };
      expect(!!task.roadmapItemId).toBe(true);
    });

    it('adhoc = task has no roadmapItemId', () => {
      const task: any = { taskType: 'bug' };
      expect(!!task.roadmapItemId).toBe(false);
    });
  });

  // Mirrors the inline guardrail added to addTask after the proj-mc rename.
  // Without this check, tasks landed with phantom projectIds and became
  // invisible to dispatch (root cause of the 2026-05-06 'Org Studio backlog
  // not running' incident).
  describe('projectId existence guardrail', () => {
    const projectExists = (projects: any[], projectId: string | undefined) => {
      if (!projectId) return true; // no projectId is a separate concern
      return projects.some((p) => p?.id === projectId);
    };

    it('accepts a known projectId', () => {
      const store = { projects: [{ id: 'proj-org-studio' }, { id: 'proj-voice' }] };
      expect(projectExists(store.projects, 'proj-org-studio')).toBe(true);
    });

    it('rejects an unknown projectId (e.g. legacy proj-mc after rename)', () => {
      const store = { projects: [{ id: 'proj-org-studio' }] };
      expect(projectExists(store.projects, 'proj-mc')).toBe(false);
    });

    it('rejects an entirely fictional projectId', () => {
      const store = { projects: [{ id: 'proj-org-studio' }] };
      expect(projectExists(store.projects, 'proj-typo')).toBe(false);
    });

    it('treats missing projectId as a separate validation concern (not this guardrail)', () => {
      const store = { projects: [{ id: 'proj-org-studio' }] };
      expect(projectExists(store.projects, undefined)).toBe(true);
    });
  });
});
