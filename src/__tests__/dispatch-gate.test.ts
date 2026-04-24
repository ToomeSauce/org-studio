/**
 * #1112 PR 4 — dispatch-gate unit tests.
 *
 * Locks in the 4-rule dispatch model and the waiting/idle distinction
 * used by the auto-stop pass.
 */
import { describe, it, expect } from 'vitest';
import {
  isTaskDispatchEligible,
  isTaskWaiting,
  isTaskGatedByWaitsFor,
  isComponentVersionShipped,
} from '@/lib/dispatch-gate';

// ---- builders ----

function mkProject(overrides: any = {}) {
  return {
    id: 'p1',
    state: 'started',
    components: [
      {
        id: 'cmp-main',
        name: 'Main',
        approvedThrough: '0.2.0',
        versions: [
          { version: '0.1.0', status: 'shipped' },
          { version: '0.2.0', status: 'planned' },
          { version: '0.3.0', status: 'planned' },
        ],
      },
    ],
    ...overrides,
  };
}

function mkTask(overrides: any = {}) {
  return {
    id: 't1',
    projectId: 'p1',
    sectionId: 'cmp-main',
    version: '0.2.0',
    status: 'backlog',
    assignee: 'mikey',
    ...overrides,
  };
}

// ---- Rule 1: project must be started ----

describe('isTaskDispatchEligible — Rule 1 (project state)', () => {
  it('eligible when project.state === started', () => {
    const store = { projects: [mkProject()], tasks: [] };
    expect(isTaskDispatchEligible(store, mkTask())).toBe(true);
  });

  it('NOT eligible when project.state === stopped', () => {
    const store = { projects: [mkProject({ state: 'stopped' })], tasks: [] };
    expect(isTaskDispatchEligible(store, mkTask())).toBe(false);
  });

  it('NOT eligible when project is missing', () => {
    const store = { projects: [], tasks: [] };
    expect(isTaskDispatchEligible(store, mkTask())).toBe(false);
  });
});

// ---- Rule 2: task must have sectionId + version ----

describe('isTaskDispatchEligible — Rule 2 (scope)', () => {
  it('NOT eligible when sectionId missing', () => {
    const store = { projects: [mkProject()], tasks: [] };
    expect(isTaskDispatchEligible(store, mkTask({ sectionId: undefined }))).toBe(false);
  });

  it('NOT eligible when version missing', () => {
    const store = { projects: [mkProject()], tasks: [] };
    expect(isTaskDispatchEligible(store, mkTask({ version: undefined }))).toBe(false);
  });
});

// ---- Rule 3: task.version <= component.approvedThrough ----

describe('isTaskDispatchEligible — Rule 3 (approval banner)', () => {
  it('eligible when version <= approvedThrough', () => {
    const store = { projects: [mkProject()], tasks: [] };
    expect(isTaskDispatchEligible(store, mkTask({ version: '0.1.0' }))).toBe(true);
    expect(isTaskDispatchEligible(store, mkTask({ version: '0.2.0' }))).toBe(true);
  });

  it('NOT eligible when version > approvedThrough', () => {
    const store = { projects: [mkProject()], tasks: [] };
    expect(isTaskDispatchEligible(store, mkTask({ version: '0.3.0' }))).toBe(false);
  });

  it('NOT eligible when component has no approvedThrough', () => {
    const proj = mkProject();
    proj.components[0].approvedThrough = undefined;
    const store = { projects: [proj], tasks: [] };
    expect(isTaskDispatchEligible(store, mkTask())).toBe(false);
  });

  it('each component has its own approvedThrough (independent banners)', () => {
    const proj = mkProject({
      components: [
        {
          id: 'cmp-main',
          name: 'Main',
          approvedThrough: '0.2.0',
          versions: [{ version: '0.2.0', status: 'planned' }, { version: '0.3.0', status: 'planned' }],
        },
        {
          id: 'cmp-qa',
          name: 'QA',
          approvedThrough: '0.1.0',
          versions: [{ version: '0.1.0', status: 'planned' }, { version: '0.2.0', status: 'planned' }],
        },
      ],
    });
    const store = { projects: [proj], tasks: [] };
    // Main: 0.3.0 is above its 0.2.0 banner.
    expect(isTaskDispatchEligible(store, mkTask({ sectionId: 'cmp-main', version: '0.3.0' }))).toBe(false);
    // QA: 0.2.0 is above its 0.1.0 banner.
    expect(isTaskDispatchEligible(store, mkTask({ sectionId: 'cmp-qa', version: '0.2.0' }))).toBe(false);
    // QA: 0.1.0 is within its banner.
    expect(isTaskDispatchEligible(store, mkTask({ sectionId: 'cmp-qa', version: '0.1.0' }))).toBe(true);
  });
});

// ---- Rule 4: component-version waitsFor satisfied ----

describe('isTaskDispatchEligible — Rule 4 (waitsFor)', () => {
  it('NOT eligible when waitsFor target is not shipped', () => {
    const proj = mkProject({
      components: [
        {
          id: 'cmp-main',
          name: 'Main',
          approvedThrough: '0.2.0',
          versions: [{ version: '0.2.0', status: 'planned' }],
        },
        {
          id: 'cmp-qa',
          name: 'QA',
          approvedThrough: '0.2.0',
          versions: [
            { version: '0.2.0', status: 'planned', waitsFor: { componentId: 'cmp-main', version: '0.2.0' } },
          ],
        },
      ],
    });
    const store = { projects: [proj], tasks: [] };
    expect(isTaskDispatchEligible(store, mkTask({ sectionId: 'cmp-qa', version: '0.2.0' }))).toBe(false);
  });

  it('eligible when waitsFor target IS shipped', () => {
    const proj = mkProject({
      components: [
        {
          id: 'cmp-main',
          name: 'Main',
          approvedThrough: '0.2.0',
          versions: [{ version: '0.2.0', status: 'shipped' }],
        },
        {
          id: 'cmp-qa',
          name: 'QA',
          approvedThrough: '0.2.0',
          versions: [
            { version: '0.2.0', status: 'planned', waitsFor: { componentId: 'cmp-main', version: '0.2.0' } },
          ],
        },
      ],
    });
    const store = { projects: [proj], tasks: [] };
    expect(isTaskDispatchEligible(store, mkTask({ sectionId: 'cmp-qa', version: '0.2.0' }))).toBe(true);
  });

  it('eligible when component-version has no waitsFor', () => {
    const store = { projects: [mkProject()], tasks: [] };
    expect(isTaskDispatchEligible(store, mkTask({ version: '0.2.0' }))).toBe(true);
  });
});

// ---- isComponentVersionShipped ----

describe('isComponentVersionShipped', () => {
  it('returns true when the version is marked shipped', () => {
    const store = { projects: [mkProject()], tasks: [] };
    expect(isComponentVersionShipped(store, 'p1', 'cmp-main', '0.1.0')).toBe(true);
  });

  it('returns false when the version is planned', () => {
    const store = { projects: [mkProject()], tasks: [] };
    expect(isComponentVersionShipped(store, 'p1', 'cmp-main', '0.2.0')).toBe(false);
  });

  it('returns false when the version does not exist (empty ≠ shipped)', () => {
    const store = { projects: [mkProject()], tasks: [] };
    expect(isComponentVersionShipped(store, 'p1', 'cmp-main', '9.9.9')).toBe(false);
  });
});

// ---- isTaskGatedByWaitsFor: legacy component-level waitsFor (PR 2 fallback) ----

describe('isTaskGatedByWaitsFor — legacy component-level waitsFor (PR 2 shape)', () => {
  it('gates when component has no versions[] but has legacy waitsFor[] unsatisfied', () => {
    const proj = {
      id: 'p1',
      state: 'started',
      // Main has no per-component versions array — PR 6-pending shape.
      versions: [{ version: '0.1.0', status: 'planned' }],
      autonomy: { approvedThrough: '0.1.0' },
      components: [
        { id: 'cmp-main', name: 'Main' },
        {
          id: 'cmp-qa',
          name: 'QA',
          waitsFor: [{ componentId: 'cmp-main', version: '0.1.0' }], // unsatisfied
        },
      ],
    };
    const store = {
      projects: [proj],
      tasks: [],
    };
    const task = { id: 't1', projectId: 'p1', sectionId: 'cmp-qa', version: '0.1.0', status: 'backlog' };
    expect(isTaskGatedByWaitsFor(store as any, task)).toBe(true);
  });
});

// ---- isTaskWaiting (drives auto-stop decision) ----

describe('isTaskWaiting', () => {
  it('blocked tasks are waiting', () => {
    const store = { projects: [mkProject()], tasks: [] };
    expect(isTaskWaiting(store, mkTask({ status: 'blocked' }))).toBe(true);
  });

  it('above-horizon backlog is NOT waiting (user needs to extend approval)', () => {
    const store = { projects: [mkProject()], tasks: [] };
    expect(isTaskWaiting(store, mkTask({ version: '0.3.0' }))).toBe(false);
  });

  it('within-horizon backlog gated by waitsFor IS waiting', () => {
    const proj = mkProject({
      components: [
        {
          id: 'cmp-main',
          name: 'Main',
          approvedThrough: '0.2.0',
          versions: [{ version: '0.2.0', status: 'planned' }],
        },
        {
          id: 'cmp-qa',
          name: 'QA',
          approvedThrough: '0.2.0',
          versions: [
            { version: '0.2.0', status: 'planned', waitsFor: { componentId: 'cmp-main', version: '0.2.0' } },
          ],
        },
      ],
    });
    const store = { projects: [proj], tasks: [] };
    expect(isTaskWaiting(store, mkTask({ sectionId: 'cmp-qa' }))).toBe(true);
  });

  it('within-horizon backlog with satisfied waitsFor is NOT waiting (it\'s dispatchable)', () => {
    const store = { projects: [mkProject()], tasks: [] };
    expect(isTaskWaiting(store, mkTask())).toBe(false);
  });

  it('done tasks are NOT waiting', () => {
    const store = { projects: [mkProject()], tasks: [] };
    expect(isTaskWaiting(store, mkTask({ status: 'done' }))).toBe(false);
  });
});
