/**
 * #1235 — Tests for getOrphanBlockedTasks.
 *
 * Reproduces the bug Basil flagged on 2026-05-06: proj-ops shows "1 blocked"
 * on the dashboard but the task is unreachable because it has no
 * componentId/roadmapItemId/parentId. The helper this exercises is what the
 * dashboard uses to surface those orphans.
 */
import { describe, it, expect } from 'vitest';
import { getOrphanBlockedTasks, type TaskLike } from './component-helpers';

const t = (overrides: Partial<TaskLike> & { id: string; projectId: string; status: string }): TaskLike => ({
  ...overrides,
});

describe('getOrphanBlockedTasks', () => {
  it('surfaces blocked tasks with no anchors at all', () => {
    const tasks: TaskLike[] = [
      t({ id: 'a', projectId: 'p1', status: 'blocked' }), // orphan
    ];
    expect(getOrphanBlockedTasks(tasks, 'p1').map((x) => x.id)).toEqual(['a']);
  });

  it('hides blocked tasks anchored to a component (sectionId)', () => {
    const tasks: TaskLike[] = [
      t({ id: 'a', projectId: 'p1', status: 'blocked', sectionId: 'comp-1' }),
    ];
    expect(getOrphanBlockedTasks(tasks, 'p1')).toEqual([]);
  });

  it('hides blocked tasks anchored to a roadmap item', () => {
    const tasks: TaskLike[] = [
      t({ id: 'a', projectId: 'p1', status: 'blocked', roadmapItemId: 'r-1' }),
    ];
    expect(getOrphanBlockedTasks(tasks, 'p1')).toEqual([]);
  });

  it('hides blocked subtasks (parentId set)', () => {
    const tasks: TaskLike[] = [
      t({ id: 'a', projectId: 'p1', status: 'blocked', parentId: 'parent-1' }),
    ];
    expect(getOrphanBlockedTasks(tasks, 'p1')).toEqual([]);
  });

  it('hides non-blocked tasks even when otherwise orphan', () => {
    const tasks: TaskLike[] = [
      t({ id: 'a', projectId: 'p1', status: 'in-progress' }),
      t({ id: 'b', projectId: 'p1', status: 'backlog' }),
      t({ id: 'c', projectId: 'p1', status: 'review' }),
      t({ id: 'd', projectId: 'p1', status: 'done' }),
    ];
    expect(getOrphanBlockedTasks(tasks, 'p1')).toEqual([]);
  });

  it('scopes to projectId — blocked orphans in other projects are ignored', () => {
    const tasks: TaskLike[] = [
      t({ id: 'a', projectId: 'p1', status: 'blocked' }),
      t({ id: 'b', projectId: 'p2', status: 'blocked' }),
    ];
    expect(getOrphanBlockedTasks(tasks, 'p1').map((x) => x.id)).toEqual(['a']);
    expect(getOrphanBlockedTasks(tasks, 'p2').map((x) => x.id)).toEqual(['b']);
  });

  it('returns multiple orphans in input order, alongside hidden anchored ones', () => {
    const tasks: TaskLike[] = [
      t({ id: 'orph-1', projectId: 'p1', status: 'blocked' }),
      t({ id: 'anchored', projectId: 'p1', status: 'blocked', sectionId: 'c1' }),
      t({ id: 'orph-2', projectId: 'p1', status: 'blocked' }),
      t({ id: 'unrelated', projectId: 'p2', status: 'blocked' }),
    ];
    expect(getOrphanBlockedTasks(tasks, 'p1').map((x) => x.id)).toEqual([
      'orph-1',
      'orph-2',
    ]);
  });

  it('reproduces the proj-ops repro case (Basil 2026-05-06)', () => {
    // Real-world shape: status=blocked, no component/roadmap/parent anchors,
    // assigned to Henry. Dashboard previously rendered it nowhere.
    const tasks: TaskLike[] = [
      t({ id: 'isu370p9mot543vm', projectId: 'proj-ops', status: 'blocked' }),
    ];
    expect(getOrphanBlockedTasks(tasks, 'proj-ops').map((x) => x.id)).toEqual([
      'isu370p9mot543vm',
    ]);
  });

  it('tolerates null/undefined entries defensively', () => {
    const tasks = [
      null as any,
      undefined as any,
      t({ id: 'a', projectId: 'p1', status: 'blocked' }),
    ];
    expect(getOrphanBlockedTasks(tasks, 'p1').map((x) => x.id)).toEqual(['a']);
  });
});
