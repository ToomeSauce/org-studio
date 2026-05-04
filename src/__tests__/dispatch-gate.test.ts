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

// ---- #1112 PR 6: legacy component-level waitsFor is removed ----

describe('isTaskGatedByWaitsFor — PR 6: no legacy component-level waitsFor fallback', () => {
  it('does NOT gate on legacy component.waitsFor[] (migration flattened it into per-version waitsFor)', () => {
    const proj = {
      id: 'p1',
      state: 'started',
      components: [
        { id: 'cmp-main', name: 'Main' },
        {
          id: 'cmp-qa',
          name: 'QA',
          // Legacy shape. Post-migration this field doesn't exist in real
          // data; even when stale data still carries it, the predicate
          // ignores it. QA needs a proper per-version waitsFor now.
          waitsFor: [{ componentId: 'cmp-main', version: '0.1.0' }],
        },
      ],
    };
    const store = { projects: [proj], tasks: [] };
    const task = { id: 't1', projectId: 'p1', sectionId: 'cmp-qa', version: '0.1.0', status: 'backlog' };
    // No versions[] on QA → the new predicate returns false (not gated);
    // the real dispatch gate (rule 3, approvedThrough) will filter it out
    // instead because QA has no approvedThrough either.
    expect(isTaskGatedByWaitsFor(store as any, task)).toBe(false);
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

// ----------------------------------------------------------------------
// #1183 — adhoc dispatch lane
// ----------------------------------------------------------------------

import {
  isTaskAdhocDispatchEligible,
  isTaskAnyDispatchEligible,
} from '@/lib/dispatch-gate';

// Adhoc tickets are filed without sectionId/version. The roadmap predicate
// rejects them at its first guard. The adhoc lane checks only project state
// + assignee + adhoc taskType.

function mkAdhoc(overrides: any = {}) {
  return {
    id: 'ad1',
    projectId: 'p1',
    status: 'backlog',
    assignee: 'mikey',
    taskType: 'bug',
    ...overrides,
  };
}

describe('#1183 adhoc dispatch lane', () => {
  it('bug ticket on a started project IS adhoc-eligible', () => {
    const store = { projects: [mkProject()], tasks: [] };
    expect(isTaskAdhocDispatchEligible(store, mkAdhoc())).toBe(true);
  });

  it('chore/spike/followup are also adhoc-eligible', () => {
    const store = { projects: [mkProject()], tasks: [] };
    for (const taskType of ['chore', 'spike', 'followup']) {
      expect(isTaskAdhocDispatchEligible(store, mkAdhoc({ taskType }))).toBe(
        true,
      );
    }
  });

  it('non-adhoc taskType (or missing) is NOT adhoc-eligible', () => {
    const store = { projects: [mkProject()], tasks: [] };
    expect(
      isTaskAdhocDispatchEligible(store, mkAdhoc({ taskType: 'feature' })),
    ).toBe(false);
    expect(
      isTaskAdhocDispatchEligible(store, mkAdhoc({ taskType: undefined })),
    ).toBe(false);
  });

  it('stopped project blocks adhoc dispatch (intentional)', () => {
    const store = { projects: [mkProject({ state: 'stopped' })], tasks: [] };
    expect(isTaskAdhocDispatchEligible(store, mkAdhoc())).toBe(false);
  });

  it('non-backlog status is NOT adhoc-eligible', () => {
    const store = { projects: [mkProject()], tasks: [] };
    expect(
      isTaskAdhocDispatchEligible(store, mkAdhoc({ status: 'in-progress' })),
    ).toBe(false);
    expect(
      isTaskAdhocDispatchEligible(store, mkAdhoc({ status: 'done' })),
    ).toBe(false);
  });

  it('archived/paused adhoc tickets are NOT eligible', () => {
    const store = { projects: [mkProject()], tasks: [] };
    expect(
      isTaskAdhocDispatchEligible(store, mkAdhoc({ isArchived: true })),
    ).toBe(false);
    expect(
      isTaskAdhocDispatchEligible(
        store,
        mkAdhoc({ loopPausedAt: Date.now() }),
      ),
    ).toBe(false);
  });

  it('missing assignee is NOT adhoc-eligible', () => {
    const store = { projects: [mkProject()], tasks: [] };
    expect(
      isTaskAdhocDispatchEligible(store, mkAdhoc({ assignee: undefined })),
    ).toBe(false);
  });

  it('adhoc lane does NOT require sectionId/version', () => {
    const store = { projects: [mkProject()], tasks: [] };
    // Explicitly no sectionId/version on adhoc — still eligible.
    const t = mkAdhoc();
    expect((t as any).sectionId).toBeUndefined();
    expect((t as any).version).toBeUndefined();
    expect(isTaskAdhocDispatchEligible(store, t)).toBe(true);
  });

  it('adhoc + version field is ineligible (#1211)', () => {
    const store = { projects: [mkProject()], tasks: [] };
    const t = mkAdhoc({ taskType: 'bug', version: '0.5.0' });
    expect(isTaskAdhocDispatchEligible(store, t)).toBe(false);
  });

  it('adhoc without version is still eligible (#1211)', () => {
    const store = { projects: [mkProject()], tasks: [] };
    const t = mkAdhoc({ taskType: 'bug' });
    expect((t as any).version).toBeUndefined();
    expect(isTaskAdhocDispatchEligible(store, t)).toBe(true);
  });

  it('umbrella accepts EITHER lane', () => {
    const store = { projects: [mkProject()], tasks: [] };
    // Roadmap-eligible task (versioned, in-horizon)
    expect(isTaskAnyDispatchEligible(store, mkTask())).toBe(true);
    // Adhoc-eligible task (no version, taskType=bug)
    expect(isTaskAnyDispatchEligible(store, mkAdhoc())).toBe(true);
  });

  it('umbrella rejects when neither lane qualifies', () => {
    const store = { projects: [mkProject({ state: 'stopped' })], tasks: [] };
    // Versioned but stopped (rule 1 fail) AND no adhoc taskType
    expect(isTaskAnyDispatchEligible(store, mkTask())).toBe(false);
    // Adhoc but stopped
    expect(isTaskAnyDispatchEligible(store, mkAdhoc())).toBe(false);
  });

  it('roadmap-eligible behavior is unchanged for versioned tickets', () => {
    const store = { projects: [mkProject()], tasks: [] };
    // Sanity: no sectionId on a versioned task still fails roadmap lane.
    expect(
      isTaskDispatchEligible(
        store,
        mkTask({ sectionId: undefined } as any),
      ),
    ).toBe(false);
    // Versioned + within horizon + started — still eligible.
    expect(isTaskDispatchEligible(store, mkTask())).toBe(true);
  });
});

// ----------------------------------------------------------------------
// #1189 — single FIFO dispatch queue
// ----------------------------------------------------------------------

import { getEligibleBacklogFifo } from '@/lib/dispatch-gate';

describe('#1189 getEligibleBacklogFifo — single FIFO queue', () => {
  it('returns versioned + adhoc tickets in createdAt ASC order', () => {
    const store = {
      projects: [mkProject()],
      tasks: [
        // landed second
        { ...mkTask({ id: 't-versioned' }), createdAt: 200 },
        // landed first
        { ...mkAdhoc({ id: 't-bug' }), createdAt: 100 },
        // landed third
        { ...mkAdhoc({ id: 't-chore', taskType: 'chore' }), createdAt: 300 },
      ],
    };
    const out = getEligibleBacklogFifo(store, ['mikey']);
    expect(out.map((t) => t.id)).toEqual(['t-bug', 't-versioned', 't-chore']);
  });

  it('versioned tickets do NOT cut in front of older adhoc tickets', () => {
    // Critical regression test for #1189. Pre-refactor, the scheduler
    // happened to mix lanes via insertion order (often FIFO-ish), but
    // any ranking step above the filter could silently change priority.
    // This test pins the contract.
    const store = {
      projects: [mkProject()],
      tasks: [
        { ...mkAdhoc({ id: 't-old-bug' }), createdAt: 1000 },
        { ...mkTask({ id: 't-new-feature' }), createdAt: 2000 },
      ],
    };
    const out = getEligibleBacklogFifo(store, ['mikey']);
    expect(out[0].id).toBe('t-old-bug');
    expect(out[1].id).toBe('t-new-feature');
  });

  it('falls back to sections[] when components[] is empty (#1192)', () => {
    const project = mkProject({
      components: [],
      sections: [
        {
          id: 'cmp-main',
          name: 'Main',
          approvedThrough: '0.2.0',
          versions: [
            { version: '0.1.0', status: 'shipped' },
            { version: '0.2.0', status: 'planned' },
          ],
        },
      ],
    });
    const store = { projects: [project], tasks: [{ ...mkTask({ id: 't-legacy-sections' }), createdAt: 100 }] };

    expect(isTaskDispatchEligible(store, mkTask())).toBe(true);
    expect(getEligibleBacklogFifo(store, ['mikey']).map((t) => t.id)).toEqual(['t-legacy-sections']);
  });

  it('skips ineligible tasks (other agents, in-progress, archived, paused, inactive project)', () => {
    const store = {
      projects: [
        mkProject({ id: 'p1' }),
        mkProject({ id: 'p2', state: 'inactive' }),
      ],
      tasks: [
        { ...mkTask({ id: 't-mine', createdAt: 100 }) },
        { ...mkTask({ id: 't-theirs', assignee: 'henry', createdAt: 100 }) },
        { ...mkTask({ id: 't-progress', status: 'in-progress', createdAt: 100 }) },
        { ...mkTask({ id: 't-archived', isArchived: true, createdAt: 100 }) },
        { ...mkTask({ id: 't-paused', loopPausedAt: 1, createdAt: 100 }) },
        { ...mkTask({ id: 't-inactive-proj', projectId: 'p2', createdAt: 100 }) },
      ],
    };
    const out = getEligibleBacklogFifo(store, ['mikey']);
    expect(out.map((t) => t.id)).toEqual(['t-mine']);
  });

  it('matches by either agent name OR agent id (case-insensitive)', () => {
    const store = {
      projects: [mkProject()],
      tasks: [
        { ...mkTask({ id: 't-by-name', assignee: 'Mikey' }), createdAt: 100 },
        { ...mkTask({ id: 't-by-id', assignee: 'agent-mikey-id' }), createdAt: 200 },
      ],
    };
    const out = getEligibleBacklogFifo(store, ['mikey', 'agent-mikey-id']);
    expect(out.map((t) => t.id)).toEqual(['t-by-name', 't-by-id']);
  });

  it('treats missing createdAt as 0 (oldest) — predictable, not a crash', () => {
    const store = {
      projects: [mkProject()],
      tasks: [
        { ...mkTask({ id: 't-with' }), createdAt: 100 },
        { ...mkTask({ id: 't-without' }) }, // no createdAt
      ],
    };
    const out = getEligibleBacklogFifo(store, ['mikey']);
    // t-without (createdAt undefined → 0) sorts first, then t-with (100).
    expect(out.map((t) => t.id)).toEqual(['t-without', 't-with']);
  });
});

// ---- #1212: explicit-list approval (no retroactive prior-version approval) ----

describe('#1212 isTaskDispatchEligible — explicit approvedVersions[] set membership', () => {
  function mkProjectExplicit(approvedVersions: string[], versions: any[]): any {
    return {
      id: 'p1',
      state: 'active',
      components: [
        {
          id: 'cmp-main',
          name: 'Main',
          // No approvedThrough — explicit list is canonical.
          approvedVersions,
          versions,
        },
      ],
    };
  }

  it('approvedVersions=[0.9.16] makes v0.9.16 dispatchable but NOT v0.9.9', () => {
    const proj = mkProjectExplicit(
      ['0.9.16'],
      [
        { version: '0.9.9', status: 'shipped' },
        { version: '0.9.10', status: 'shipped' },
        { version: '0.9.11', status: 'shipped' },
        { version: '0.9.12', status: 'shipped' },
        { version: '0.9.13', status: 'planned' },
        { version: '0.9.14', status: 'planned' },
        { version: '0.9.15', status: 'planned' },
        { version: '0.9.16', status: 'planned' },
      ],
    );
    const store = { projects: [proj], tasks: [] };
    expect(isTaskDispatchEligible(store, mkTask({ version: '0.9.16' }))).toBe(true);
    // v0.9.9 is not in approvedVersions[] — must NOT be dispatchable even
    // though it's "before" the max approved version.
    expect(isTaskDispatchEligible(store, mkTask({ version: '0.9.9' }))).toBe(false);
    expect(isTaskDispatchEligible(store, mkTask({ version: '0.9.13' }))).toBe(false);
    expect(isTaskDispatchEligible(store, mkTask({ version: '0.9.15' }))).toBe(false);
  });

  it('approvedVersions=[0.9.16, 0.9.14] makes both dispatchable but NOT v0.9.13 or v0.9.15', () => {
    // 0.9.14 shipped so it doesn't block 0.9.16 via Rule 5 — this test is
    // about approval set membership, not prior-version completion.
    const proj = mkProjectExplicit(
      ['0.9.16', '0.9.14'],
      [
        { version: '0.9.12', status: 'shipped' },
        { version: '0.9.13', status: 'planned' },
        { version: '0.9.14', status: 'shipped' },
        { version: '0.9.15', status: 'planned' },
        { version: '0.9.16', status: 'planned' },
      ],
    );
    const store = { projects: [proj], tasks: [] };
    expect(isTaskDispatchEligible(store, mkTask({ version: '0.9.14' }))).toBe(true);
    expect(isTaskDispatchEligible(store, mkTask({ version: '0.9.16' }))).toBe(true);
    expect(isTaskDispatchEligible(store, mkTask({ version: '0.9.13' }))).toBe(false);
    expect(isTaskDispatchEligible(store, mkTask({ version: '0.9.15' }))).toBe(false);
  });

  it('legacy approvedThrough (no approvedVersions[]) preserves contiguous-prefix behavior', () => {
    // Default mkProject uses approvedThrough='0.2.0' with no approvedVersions[].
    const store = { projects: [mkProject()], tasks: [] };
    expect(isTaskDispatchEligible(store, mkTask({ version: '0.1.0' }))).toBe(true);
    expect(isTaskDispatchEligible(store, mkTask({ version: '0.2.0' }))).toBe(true);
    expect(isTaskDispatchEligible(store, mkTask({ version: '0.3.0' }))).toBe(false);
  });

  it('Rule 5 with explicit list: skipping v0.9.13 (not approved) does NOT block v0.9.16 when v0.9.12 is shipped', () => {
    const proj = mkProjectExplicit(
      ['0.9.16'],
      [
        { version: '0.9.12', status: 'shipped' },
        { version: '0.9.13', status: 'planned' }, // unapproved + unshipped, must NOT block
        { version: '0.9.14', status: 'planned' },
        { version: '0.9.15', status: 'planned' },
        { version: '0.9.16', status: 'planned' },
      ],
    );
    const store = { projects: [proj], tasks: [] };
    expect(isTaskDispatchEligible(store, mkTask({ version: '0.9.16' }))).toBe(true);
  });

  it('Rule 5 with explicit list: a prior APPROVED version that is unshipped DOES block', () => {
    const proj = mkProjectExplicit(
      ['0.9.14', '0.9.16'],
      [
        { version: '0.9.12', status: 'shipped' },
        { version: '0.9.14', status: 'planned' }, // approved + unshipped → blocks 0.9.16
        { version: '0.9.16', status: 'planned' },
      ],
    );
    const store = { projects: [proj], tasks: [] };
    expect(isTaskDispatchEligible(store, mkTask({ version: '0.9.16' }))).toBe(false);
    // 0.9.14 itself is dispatchable (its only approved prior, 0.9.12, is shipped).
    expect(isTaskDispatchEligible(store, mkTask({ version: '0.9.14' }))).toBe(true);
  });
});
