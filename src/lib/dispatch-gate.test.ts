/**
 * #1571 — transitive-blocker filtering in getEligibleBacklogFifo.
 *
 * Repro that motivated this: umbrella ticket #1565 was set status=blocked.
 * Sub-tickets #1566–#1570 were filed with blockedBy=[#1565] and
 * status=backlog. The dispatcher kept firing one of them at the assignee
 * because getEligibleBacklogFifo never consulted blockedBy.
 *
 * These tests pin the new behaviour:
 *   - parent in `blocked`, child blockedBy=[parent] → child NOT eligible
 *   - parent in `done`,    child blockedBy=[parent] → child IS eligible
 *   - blockedBy=[]                                  → eligible (vacuous)
 *   - dangling blockedBy ref                        → eligible (treat cleared)
 *   - blockedBy stored as task-id string (prod data) → resolved correctly
 *   - mixed blockers, one not done                  → NOT eligible
 */

import { describe, test, expect } from 'vitest';
import { getEligibleBacklogFifo, areBlockersCleared } from '@/lib/dispatch-gate';

// StoreLike / ProjectLike / TaskLike are internal (non-exported) to
// dispatch-gate. Derive the exact param types from the public functions so
// fixtures typecheck without re-declaring those shapes here.
type Store = Parameters<typeof getEligibleBacklogFifo>[0];
type Task = NonNullable<Store['tasks']>[number];
type Project = NonNullable<Store['projects']>[number];

// Minimal active project; adhoc (bug) tasks only need a started project.
const PROJECT = { id: 'proj-os', state: 'active' } as unknown as Project;

type T = Record<string, any>;

function bugTask(over: T): Task {
  return {
    id: over.id ?? 'auto',
    taskType: 'bug',
    status: 'backlog',
    assignee: 'mikey',
    projectId: 'proj-os',
    createdAt: 1,
    sortOrder: 1,
    ...over,
  } as Task;
}

function storeWith(tasks: Task[]): Store {
  return { projects: [PROJECT], tasks };
}

const MATCHERS = ['mikey'];

describe('getEligibleBacklogFifo — transitive blockedBy gate (#1571)', () => {
  test('child is NOT eligible when its blocker is in `blocked`', () => {
    const parent = bugTask({ id: 'umbrella', ticketNumber: 1565, status: 'blocked' });
    const child = bugTask({ id: 'child', ticketNumber: 1569, blockedBy: [1565] });
    const out = getEligibleBacklogFifo(storeWith([parent, child]), MATCHERS);
    expect(out.map((t) => t.id)).not.toContain('child');
  });

  test('child IS eligible when its blocker is `done`', () => {
    const parent = bugTask({ id: 'umbrella', ticketNumber: 1565, status: 'done' });
    const child = bugTask({ id: 'child', ticketNumber: 1569, blockedBy: [1565] });
    const out = getEligibleBacklogFifo(storeWith([parent, child]), MATCHERS);
    expect(out.map((t) => t.id)).toContain('child');
  });

  test('candidate with empty blockedBy is eligible', () => {
    const t = bugTask({ id: 'free', ticketNumber: 1571, blockedBy: [] });
    const out = getEligibleBacklogFifo(storeWith([t]), MATCHERS);
    expect(out.map((x) => x.id)).toContain('free');
  });

  test('candidate with no blockedBy field is eligible', () => {
    const t = bugTask({ id: 'free2', ticketNumber: 1572 });
    const out = getEligibleBacklogFifo(storeWith([t]), MATCHERS);
    expect(out.map((x) => x.id)).toContain('free2');
  });

  test('dangling blockedBy ref is treated as cleared (eligible)', () => {
    const child = bugTask({ id: 'orphan', ticketNumber: 1573, blockedBy: [99999] });
    const out = getEligibleBacklogFifo(storeWith([child]), MATCHERS);
    expect(out.map((t) => t.id)).toContain('orphan');
  });

  test('blockedBy stored as a task-id STRING (real prod shape) gates correctly', () => {
    // #1569/#1570 in prod stored blockedBy=['s44aqbgnmpvne3rp'] (the umbrella
    // task id), not the ticketNumber. The resolver must catch this.
    const parent = bugTask({ id: 's44aqbgnmpvne3rp', ticketNumber: 1565, status: 'blocked' });
    const child = bugTask({ id: 'child-byid', ticketNumber: 1570, blockedBy: ['s44aqbgnmpvne3rp'] });

    expect(areBlockersCleared(storeWith([parent, child]), child)).toBe(false);
    const out = getEligibleBacklogFifo(storeWith([parent, child]), MATCHERS);
    expect(out.map((t) => t.id)).not.toContain('child-byid');

    // ...and once the parent ships, the same child becomes eligible.
    parent.status = 'done';
    const out2 = getEligibleBacklogFifo(storeWith([parent, child]), MATCHERS);
    expect(out2.map((t) => t.id)).toContain('child-byid');
  });

  test('multiple blockers: NOT eligible until ALL are done', () => {
    const b1 = bugTask({ id: 'b1', ticketNumber: 100, status: 'done' });
    const b2 = bugTask({ id: 'b2', ticketNumber: 101, status: 'in-progress' });
    const child = bugTask({ id: 'multi', ticketNumber: 102, blockedBy: [100, 101] });

    expect(areBlockersCleared(storeWith([b1, b2, child]), child)).toBe(false);
    const out = getEligibleBacklogFifo(storeWith([b1, b2, child]), MATCHERS);
    expect(out.map((t) => t.id)).not.toContain('multi');

    b2.status = 'done';
    const out2 = getEligibleBacklogFifo(storeWith([b1, b2, child]), MATCHERS);
    expect(out2.map((t) => t.id)).toContain('multi');
  });
});

describe('areBlockersCleared — unit', () => {
  test('empty/missing → cleared', () => {
    expect(areBlockersCleared(storeWith([]), bugTask({ id: 'x' }))).toBe(true);
    expect(areBlockersCleared(storeWith([]), bugTask({ id: 'x', blockedBy: [] }))).toBe(true);
  });
});
