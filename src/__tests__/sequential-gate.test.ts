/**
 * #1126 PR 2 — sequential dispatch gate unit tests.
 *
 * Locks in the new "prior versions must ship before next dispatches" rule
 * and the legacy `role: 'qa'` carve-out used during the PR2→PR4 migration
 * window. Carve-out is removed in PR 6.
 */
import { describe, it, expect } from 'vitest';
import {
  priorVersionsComplete,
  isTaskDispatchEligible,
  isTaskWaiting,
} from '@/lib/dispatch-gate';

// ---- builders ----

function mkStore(overrides: any = {}) {
  return {
    projects: [
      {
        id: 'p1',
        state: 'started',
        components: [
          {
            id: 'cmp-main',
            name: 'Main',
            owner: 'Mikey',
            approvedThrough: '0.3.0',
            versions: [
              { version: '0.1.0', status: 'shipped', sort_order: 1 },
              { version: '0.2.0', status: 'planned', sort_order: 2 },
              { version: '0.3.0', status: 'planned', sort_order: 3 },
            ],
          },
        ],
        ...overrides.projectOverrides,
      },
    ],
    tasks: [],
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
    assignee: 'Mikey',
    ...overrides,
  };
}

// ---- priorVersionsComplete ----

describe('priorVersionsComplete (#1126 PR 2)', () => {
  it('returns true for the first version (no priors to check)', () => {
    expect(priorVersionsComplete(mkStore(), 'p1', 'cmp-main', '0.1.0')).toBe(true);
  });

  it('returns true when all prior versions are shipped', () => {
    expect(priorVersionsComplete(mkStore(), 'p1', 'cmp-main', '0.2.0')).toBe(true);
  });

  it('returns false when a prior version is not shipped', () => {
    // 0.3.0's prior 0.2.0 is still planned → not complete
    expect(priorVersionsComplete(mkStore(), 'p1', 'cmp-main', '0.3.0')).toBe(false);
  });

  it('treats "done" as a tolerant alias for "shipped"', () => {
    const store = mkStore({
      projectOverrides: {
        components: [
          {
            id: 'cmp-main',
            name: 'Main',
            owner: 'Mikey',
            approvedThrough: '0.3.0',
            versions: [
              { version: '0.1.0', status: 'done', sort_order: 1 },
              { version: '0.2.0', status: 'shipped', sort_order: 2 },
              { version: '0.3.0', status: 'planned', sort_order: 3 },
            ],
          },
        ],
      },
    });
    expect(priorVersionsComplete(store, 'p1', 'cmp-main', '0.3.0')).toBe(true);
  });

  it('uses sort_order over semver when both differ', () => {
    // semver order would say 0.10.0 > 0.2.0 > 0.1.0; we use sort_order to
    // express user intent (e.g. inserted-after-the-fact hotfix).
    const store = mkStore({
      projectOverrides: {
        components: [
          {
            id: 'cmp-main',
            name: 'Main',
            owner: 'Mikey',
            approvedThrough: '0.10.0',
            versions: [
              { version: '0.10.0', status: 'planned', sort_order: 1 }, // first by sort_order
              { version: '0.1.0',  status: 'shipped', sort_order: 2 },
              { version: '0.2.0',  status: 'planned', sort_order: 3 }, // queried target
            ],
          },
        ],
      },
    });
    // Target 0.2.0 has priors [0.10.0(planned), 0.1.0(shipped)] in sort_order — fails because 0.10.0 not shipped.
    expect(priorVersionsComplete(store, 'p1', 'cmp-main', '0.2.0')).toBe(false);
  });

  it('falls back to semver when sort_order is absent', () => {
    const store = mkStore({
      projectOverrides: {
        components: [
          {
            id: 'cmp-main',
            name: 'Main',
            owner: 'Mikey',
            approvedThrough: '1.0.0',
            versions: [
              { version: '0.2.0', status: 'shipped' },
              { version: '0.1.0', status: 'shipped' },
              { version: '1.0.0', status: 'planned' },
            ],
          },
        ],
      },
    });
    expect(priorVersionsComplete(store, 'p1', 'cmp-main', '1.0.0')).toBe(true);
  });

  it('returns true when component has no versions[]', () => {
    const store = mkStore({
      projectOverrides: {
        components: [{ id: 'cmp-main', name: 'Main', owner: 'Mikey' }],
      },
    });
    expect(priorVersionsComplete(store, 'p1', 'cmp-main', '0.1.0')).toBe(true);
  });

  it('returns true for unknown target version (out of scope for this predicate)', () => {
    expect(priorVersionsComplete(mkStore(), 'p1', 'cmp-main', '99.0.0')).toBe(true);
  });

  it('returns true for unknown project (no priors to check)', () => {
    expect(priorVersionsComplete(mkStore(), 'p-missing', 'cmp-main', '0.1.0')).toBe(true);
  });
});

// ---- isTaskDispatchEligible: sequential gate integration ----

describe('isTaskDispatchEligible — sequential gate (#1126 PR 2)', () => {
  it('blocks a task on v0.3.0 when v0.2.0 has not shipped', () => {
    const store = mkStore();
    const task = mkTask({ version: '0.3.0' });
    expect(isTaskDispatchEligible(store, task)).toBe(false);
  });

  it('allows a task on v0.2.0 when v0.1.0 has shipped (the only prior)', () => {
    const store = mkStore();
    const task = mkTask({ version: '0.2.0' });
    expect(isTaskDispatchEligible(store, task)).toBe(true);
  });

  it('allows the first version (no priors)', () => {
    const store = mkStore({
      projectOverrides: {
        components: [
          {
            id: 'cmp-main',
            name: 'Main',
            owner: 'Mikey',
            approvedThrough: '0.1.0',
            versions: [
              { version: '0.1.0', status: 'planned', sort_order: 1 },
              { version: '0.2.0', status: 'planned', sort_order: 2 },
            ],
          },
        ],
      },
    });
    const task = mkTask({ version: '0.1.0' });
    expect(isTaskDispatchEligible(store, task)).toBe(true);
  });

  it('legacy role:qa sections bypass the sequential gate (PR2→PR4 carve-out)', () => {
    // Thrivor-shaped: QA section with planned-prior versions should still
    // dispatch. PR 6 will rip this carve-out.
    const store = {
      projects: [
        {
          id: 'thrivor',
          state: 'started',
          components: [
            {
              id: 'sec-main',
              name: 'Main',
              owner: 'Basil',
              approvedThrough: '0.908.1',
              versions: [
                { version: '0.1.0', status: 'shipped', sort_order: 1 },
                { version: '0.2.0', status: 'shipped', sort_order: 2 },
                { version: '0.908.1', status: 'shipped', sort_order: 3 },
              ],
            },
            {
              id: 'sec-qa',
              name: 'QA',
              role: 'qa',
              owner: 'Billy',
              approvedThrough: '0.908.1',
              versions: [
                { version: '0.1.0',   status: 'shipped', sort_order: 1 },
                { version: '0.2.0',   status: 'planned', sort_order: 2 }, // unfinished prior
                { version: '0.908.1', status: 'planned', sort_order: 3 }, // target
              ],
            },
          ],
        },
      ],
      tasks: [],
    };
    const qaTask = {
      id: 'q1',
      projectId: 'thrivor',
      sectionId: 'sec-qa',
      version: '0.908.1',
      status: 'backlog',
      assignee: 'Billy',
    };
    expect(isTaskDispatchEligible(store, qaTask)).toBe(true);
  });

  it('non-qa role still gets the sequential gate applied', () => {
    const store = mkStore({
      projectOverrides: {
        components: [
          {
            id: 'cmp-main',
            name: 'Main',
            role: 'dev', // arbitrary non-qa role
            owner: 'Mikey',
            approvedThrough: '0.3.0',
            versions: [
              { version: '0.1.0', status: 'shipped', sort_order: 1 },
              { version: '0.2.0', status: 'planned', sort_order: 2 },
              { version: '0.3.0', status: 'planned', sort_order: 3 },
            ],
          },
        ],
      },
    });
    const task = mkTask({ version: '0.3.0' });
    expect(isTaskDispatchEligible(store, task)).toBe(false);
  });
});

// ---- isTaskWaiting: sequential gate ----

describe('isTaskWaiting — sequential gate (#1126 PR 2)', () => {
  it('marks a task as waiting (not idle) when blocked by a prior unshipped version', () => {
    const store = mkStore();
    const task = mkTask({ version: '0.3.0' });
    expect(isTaskWaiting(store, task)).toBe(true);
  });

  it('does not mark above-horizon tasks as waiting (still idle)', () => {
    // Above the approval banner — no human-resolvable wait, just unapproved.
    const store = mkStore();
    const task = mkTask({ version: '0.3.0' });
    // shrink banner so 0.3.0 is above horizon
    store.projects[0].components[0].approvedThrough = '0.2.0';
    expect(isTaskWaiting(store, task)).toBe(false);
  });

  it('legacy role:qa task is not waiting on a prior-unshipped version (carve-out)', () => {
    const store = {
      projects: [
        {
          id: 'thrivor',
          state: 'started',
          components: [
            {
              id: 'sec-qa',
              name: 'QA',
              role: 'qa',
              approvedThrough: '0.3.0',
              versions: [
                { version: '0.1.0', status: 'shipped', sort_order: 1 },
                { version: '0.2.0', status: 'planned', sort_order: 2 },
                { version: '0.3.0', status: 'planned', sort_order: 3 },
              ],
            },
          ],
        },
      ],
      tasks: [],
    };
    const qaTask = { id: 'q', projectId: 'thrivor', sectionId: 'sec-qa', version: '0.3.0', status: 'backlog' };
    expect(isTaskWaiting(store, qaTask)).toBe(false);
  });
});
