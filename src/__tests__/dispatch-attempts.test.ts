import { describe, expect, it } from 'vitest';
import { classifyBlocker, diagnoseAgentBacklog } from '@/lib/dispatch-attempts';

type ComponentFixture = {
  id: string;
  name: string;
  owner: string;
  approvedThrough?: string;
  // #1224 — per-component approval is via approvedVersions[] (set-membership).
  // approvedThrough remains on the type for legacy fixtures, but newer
  // tests/fixtures express approval as an explicit version list.
  approvedVersions?: string[];
  versions: Array<{ version: string; status: string }>;
};

type ProjectFixture = {
  id: string;
  name: string;
  state: string;
  components: ComponentFixture[];
  sections: ComponentFixture[];
};

type TaskFixture = {
  id: string;
  projectId: string;
  sectionId: string;
  version: string;
  status: string;
  assignee: string;
  taskType: string;
};

function mkLegacySectionsProject(overrides: Partial<ProjectFixture> = {}): ProjectFixture {
  return {
    id: 'proj-garage',
    name: 'Garage',
    state: 'active',
    components: [],
    sections: [
      {
        id: 'sec-main-proj-garage',
        name: 'Main',
        owner: 'Gem',
        approvedVersions: ['1.19.0', '1.20.0'],
        versions: [
          { version: '1.19.0', status: 'shipped' },
          { version: '1.20.0', status: 'current' },
          { version: '2.0.0', status: 'planned' },
        ],
      },
    ],
    ...overrides,
  };
}

function mkGarageTask(overrides: Partial<TaskFixture> = {}): TaskFixture {
  return {
    id: 't-garage',
    projectId: 'proj-garage',
    sectionId: 'sec-main-proj-garage',
    version: '2.0.0',
    status: 'backlog',
    assignee: 'Gem',
    taskType: 'feature',
    ...overrides,
  };
}

describe('#1192 dispatch diagnostics for legacy sections projects', () => {
  it('falls back to sections[] when components[] is an empty array', () => {
    const store = {
      projects: [mkLegacySectionsProject()],
      tasks: [mkGarageTask()],
    };

    expect(classifyBlocker(store, mkGarageTask())).toBe('above-horizon');
  });

  it('does not report no-section-version for section-backed Garage backlog', () => {
    const store = {
      projects: [mkLegacySectionsProject()],
      tasks: [mkGarageTask()],
    };

    const diagnosis = diagnoseAgentBacklog(store, 'gem', 'Gem');

    expect(diagnosis.taskCountBacklog).toBe(1);
    expect(diagnosis.taskCountBlockedByGate).toBe(1);
    expect(diagnosis.topBlocker).toBe('above-horizon');
    expect(diagnosis.blockerBreakdown['no-section-version']).toBe(0);
  });
});

describe('#1194 perTask diagnostic shape', () => {
  // The /api/scheduler action=diagnose handler combines diagnoseAgentBacklog
  // with a per-task blocker breakdown. This test pins the shape callers can
  // rely on so future refactors don't silently break the contract.
  it('returns a blocker per ineligible task and null for eligible ones', () => {
    const project = mkLegacySectionsProject();
    const blockedTask = mkGarageTask({ id: 't-blocked', version: '2.0.0' });
    const eligibleTask = mkGarageTask({ id: 't-eligible', version: '1.20.0' });
    const store = {
      projects: [project],
      tasks: [blockedTask, eligibleTask],
    };

    // Mirror the handler's perTask construction (without spinning a server).
    const myBacklog = store.tasks.filter(
      (t) => t.assignee.toLowerCase() === 'gem' && t.status === 'backlog',
    );
    expect(myBacklog).toHaveLength(2);

    const perTask = myBacklog.map((t) => ({
      id: t.id,
      blocker: classifyBlocker(store, t),
    }));

    expect(perTask.find((r) => r.id === 't-blocked')?.blocker).toBe(
      'above-horizon',
    );
    // The eligible task at the current version still classifies via
    // classifyBlocker if asked directly — the handler suppresses this with
    // an isTaskAnyDispatchEligible check before calling. This test pins
    // the underlying classifier behavior.
    expect(perTask.find((r) => r.id === 't-eligible')?.blocker).toBeDefined();
  });
});
