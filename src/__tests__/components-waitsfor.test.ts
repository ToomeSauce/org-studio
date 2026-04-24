import { describe, it, expect } from 'vitest';

/**
 * #1112 PR 2 — unit tests for component-level waitsFor dispatch gating.
 *
 * Replicates the logic from src/app/api/scheduler/route.ts without needing
 * an integration harness. Tests the two helpers introduced in PR 2:
 *   - isComponentVersionComplete
 *   - isTaskGatedByComponentWaitsFor
 */

// --- Replicated helpers (match scheduler/route.ts exactly) ---

function isComponentVersionComplete(
  store: any,
  targetProjectId: string,
  targetComponentId: string,
  targetVersion: string,
): boolean {
  let sawAny = false;
  for (const t of store.tasks || []) {
    if (t.isArchived) continue;
    if (t.projectId !== targetProjectId) continue;
    if (t.sectionId !== targetComponentId) continue;
    if (t.version !== targetVersion) continue;
    sawAny = true;
    if (t.status !== 'done') return false;
  }
  return sawAny;
}

function isTaskGatedByComponentWaitsFor(store: any, task: any): boolean {
  const sectionId = task?.sectionId;
  if (!sectionId) return false;
  const proj = (store.projects || []).find((p: any) => p.id === task.projectId);
  if (!proj) return false;
  const components: any[] = proj.components && proj.components.length
    ? proj.components
    : (proj.sections || []);
  const cmp = components.find((c: any) => c.id === sectionId);
  if (!cmp) return false;
  const waitsFor: any[] = Array.isArray(cmp.waitsFor) ? cmp.waitsFor : [];
  if (waitsFor.length === 0) return false;
  for (const w of waitsFor) {
    const targetProjectId = w.projectId || task.projectId;
    if (!w.componentId || !w.version) continue;
    if (!isComponentVersionComplete(store, targetProjectId, w.componentId, w.version)) {
      return true;
    }
  }
  return false;
}

// --- Fixtures ---

function makeStore() {
  return {
    tasks: [] as any[],
    projects: [] as any[],
  };
}

// --- Tests ---

describe('#1112 PR 2: isComponentVersionComplete', () => {
  it('returns false for empty set (empty ≠ complete)', () => {
    const store = makeStore();
    expect(isComponentVersionComplete(store, 'p1', 'c1', '1.0.0')).toBe(false);
  });

  it('returns false when any task is not done', () => {
    const store = makeStore();
    store.tasks.push(
      { id: 't1', projectId: 'p1', sectionId: 'c1', version: '1.0.0', status: 'done' },
      { id: 't2', projectId: 'p1', sectionId: 'c1', version: '1.0.0', status: 'in-progress' },
    );
    expect(isComponentVersionComplete(store, 'p1', 'c1', '1.0.0')).toBe(false);
  });

  it('returns true when all tasks are done', () => {
    const store = makeStore();
    store.tasks.push(
      { id: 't1', projectId: 'p1', sectionId: 'c1', version: '1.0.0', status: 'done' },
      { id: 't2', projectId: 'p1', sectionId: 'c1', version: '1.0.0', status: 'done' },
    );
    expect(isComponentVersionComplete(store, 'p1', 'c1', '1.0.0')).toBe(true);
  });

  it('ignores archived tasks', () => {
    const store = makeStore();
    store.tasks.push(
      { id: 't1', projectId: 'p1', sectionId: 'c1', version: '1.0.0', status: 'done' },
      { id: 't2', projectId: 'p1', sectionId: 'c1', version: '1.0.0', status: 'backlog', isArchived: true },
    );
    expect(isComponentVersionComplete(store, 'p1', 'c1', '1.0.0')).toBe(true);
  });

  it('is version-scoped (other versions dont count)', () => {
    const store = makeStore();
    store.tasks.push(
      { id: 't1', projectId: 'p1', sectionId: 'c1', version: '1.0.0', status: 'done' },
      { id: 't2', projectId: 'p1', sectionId: 'c1', version: '2.0.0', status: 'backlog' },
    );
    expect(isComponentVersionComplete(store, 'p1', 'c1', '1.0.0')).toBe(true);
    expect(isComponentVersionComplete(store, 'p1', 'c1', '2.0.0')).toBe(false);
  });
});

describe('#1112 PR 2: isTaskGatedByComponentWaitsFor', () => {
  it('returns false for a task with no sectionId', () => {
    const store = makeStore();
    store.projects.push({ id: 'p1' });
    const task = { id: 't-orphan', projectId: 'p1' };
    expect(isTaskGatedByComponentWaitsFor(store, task)).toBe(false);
  });

  it('returns false when the component has no waitsFor', () => {
    const store = makeStore();
    store.projects.push({
      id: 'p1',
      components: [{ id: 'c-dev', name: 'Dev', owner: 'a' }],
    });
    const task = { id: 't-dev', projectId: 'p1', sectionId: 'c-dev' };
    expect(isTaskGatedByComponentWaitsFor(store, task)).toBe(false);
  });

  it('gates when waitsFor is unsatisfied (empty target)', () => {
    const store = makeStore();
    store.projects.push({
      id: 'p1',
      components: [
        { id: 'c-dev', name: 'Dev', owner: 'a' },
        { id: 'c-qa', name: 'QA', owner: 'b', waitsFor: [{ componentId: 'c-dev', version: '1.0.0' }] },
      ],
    });
    const task = { id: 't-qa', projectId: 'p1', sectionId: 'c-qa' };
    expect(isTaskGatedByComponentWaitsFor(store, task)).toBe(true);
  });

  it('gates when waitsFor is partially satisfied', () => {
    const store = makeStore();
    store.projects.push({
      id: 'p1',
      components: [
        { id: 'c-dev', name: 'Dev', owner: 'a' },
        { id: 'c-api', name: 'API', owner: 'a' },
        {
          id: 'c-qa', name: 'QA', owner: 'b',
          waitsFor: [
            { componentId: 'c-dev', version: '1.0.0' },
            { componentId: 'c-api', version: '1.0.0' },
          ],
        },
      ],
    });
    // Dev done, API still open
    store.tasks.push(
      { id: 'tdev', projectId: 'p1', sectionId: 'c-dev', version: '1.0.0', status: 'done' },
      { id: 'tapi', projectId: 'p1', sectionId: 'c-api', version: '1.0.0', status: 'in-progress' },
    );
    const task = { id: 't-qa', projectId: 'p1', sectionId: 'c-qa' };
    expect(isTaskGatedByComponentWaitsFor(store, task)).toBe(true);
  });

  it('does not gate when all waitsFor entries are satisfied', () => {
    const store = makeStore();
    store.projects.push({
      id: 'p1',
      components: [
        { id: 'c-dev', name: 'Dev', owner: 'a' },
        { id: 'c-qa', name: 'QA', owner: 'b', waitsFor: [{ componentId: 'c-dev', version: '1.0.0' }] },
      ],
    });
    store.tasks.push(
      { id: 'tdev', projectId: 'p1', sectionId: 'c-dev', version: '1.0.0', status: 'done' },
    );
    const task = { id: 't-qa', projectId: 'p1', sectionId: 'c-qa' };
    expect(isTaskGatedByComponentWaitsFor(store, task)).toBe(false);
  });

  it('handles cross-project waitsFor via explicit projectId', () => {
    const store = makeStore();
    store.projects.push(
      {
        id: 'p-main',
        components: [
          {
            id: 'c-qa', name: 'QA', owner: 'b',
            waitsFor: [{ componentId: 'c-ext', projectId: 'p-ext', version: '2.0.0' }],
          },
        ],
      },
      {
        id: 'p-ext',
        components: [{ id: 'c-ext', name: 'Ext', owner: 'a' }],
      },
    );

    // Foreign task not done → gated
    store.tasks.push({ id: 'text1', projectId: 'p-ext', sectionId: 'c-ext', version: '2.0.0', status: 'backlog' });
    const task = { id: 't-qa', projectId: 'p-main', sectionId: 'c-qa' };
    expect(isTaskGatedByComponentWaitsFor(store, task)).toBe(true);

    // Finish foreign → no longer gated
    store.tasks[0].status = 'done';
    expect(isTaskGatedByComponentWaitsFor(store, task)).toBe(false);
  });

  it('falls back from components[] to sections[] when components absent', () => {
    const store = makeStore();
    store.projects.push({
      id: 'p1',
      sections: [
        { id: 's-dev', name: 'Dev', owner: 'a' },
        { id: 's-qa', name: 'QA', owner: 'b', waitsFor: [{ componentId: 's-dev', version: '1.0.0' }] },
      ],
    });
    const task = { id: 't-qa', projectId: 'p1', sectionId: 's-qa' };
    expect(isTaskGatedByComponentWaitsFor(store, task)).toBe(true);
  });

  it('ignores malformed waitsFor entries (missing componentId or version)', () => {
    const store = makeStore();
    store.projects.push({
      id: 'p1',
      components: [
        {
          id: 'c-qa', name: 'QA', owner: 'b',
          waitsFor: [
            { version: '1.0.0' }, // missing componentId — ignored
            { componentId: 'c-x' }, // missing version — ignored
          ],
        },
      ],
    });
    const task = { id: 't-qa', projectId: 'p1', sectionId: 'c-qa' };
    expect(isTaskGatedByComponentWaitsFor(store, task)).toBe(false);
  });

  it('prefers components[] over sections[] when both present', () => {
    const store = makeStore();
    store.projects.push({
      id: 'p1',
      components: [
        { id: 'c-qa', name: 'QA', owner: 'b' }, // no waitsFor
      ],
      sections: [
        { id: 'c-qa', name: 'QA (legacy)', owner: 'b', waitsFor: [{ componentId: 'c-other', version: '1.0.0' }] },
      ],
    });
    const task = { id: 't-qa', projectId: 'p1', sectionId: 'c-qa' };
    // components[] wins → no waitsFor → not gated
    expect(isTaskGatedByComponentWaitsFor(store, task)).toBe(false);
  });
});
