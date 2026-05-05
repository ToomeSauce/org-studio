import { describe, expect, it } from 'vitest';
import { classifyBlocker, diagnoseAgentBacklog } from '@/lib/dispatch-attempts';

type ComponentFixture = {
  id: string;
  name: string;
  owner: string;
  approvedThrough: string;
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
