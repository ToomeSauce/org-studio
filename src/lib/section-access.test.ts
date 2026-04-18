/**
 * Section access helper tests
 */
import { describe, it, expect } from 'vitest';
import {
  sectionOwnerMatches,
  isDefaultMainSection,
  agentIsMentionedOnTask,
  agentHasTaskAccess,
  agentOwnedSections,
} from './section-access';
import type { Section, Task, Project } from './store';

// ── Helpers ──

function makeSection(overrides: Partial<Section> = {}): Section {
  return { id: 'sec-1', name: 'Section 1', owner: 'Ana', outcomes: '', contract: '', ...overrides };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Test Project',
    description: '',
    phase: 'active',
    owner: 'Basil',
    priority: 'medium',
    createdAt: Date.now(),
    createdBy: 'test',
    sections: [makeSection()],
    ...overrides,
  } as Project;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Test task',
    status: 'backlog',
    projectId: 'proj-1',
    assignee: 'Mikey',
    createdAt: Date.now(),
    ...overrides,
  } as Task;
}

// ── sectionOwnerMatches ──

describe('sectionOwnerMatches', () => {
  it('returns true for exact match (case-insensitive)', () => {
    expect(sectionOwnerMatches(makeSection({ owner: 'Ana' }), 'ana')).toBe(true);
    expect(sectionOwnerMatches(makeSection({ owner: 'ana' }), 'Ana')).toBe(true);
    expect(sectionOwnerMatches(makeSection({ owner: 'ANA' }), 'ana')).toBe(true);
  });

  it('returns false for mismatch', () => {
    expect(sectionOwnerMatches(makeSection({ owner: 'Ana' }), 'Mikey')).toBe(false);
  });

  it('returns false for empty owner or agentName', () => {
    expect(sectionOwnerMatches(makeSection({ owner: '' }), 'Ana')).toBe(false);
    expect(sectionOwnerMatches(makeSection({ owner: 'Ana' }), '')).toBe(false);
  });
});

// ── isDefaultMainSection ──

describe('isDefaultMainSection', () => {
  it('returns true for sec-main-<projectId>', () => {
    expect(isDefaultMainSection('sec-main-proj-1', 'proj-1')).toBe(true);
  });

  it('returns true for falsy sectionId', () => {
    expect(isDefaultMainSection(undefined, 'proj-1')).toBe(true);
    expect(isDefaultMainSection(null, 'proj-1')).toBe(true);
    expect(isDefaultMainSection('', 'proj-1')).toBe(true);
    expect(isDefaultMainSection('  ', 'proj-1')).toBe(true);
  });

  it('returns false for non-default sectionId', () => {
    expect(isDefaultMainSection('sec-custom', 'proj-1')).toBe(false);
  });
});

// ── agentIsMentionedOnTask ──

describe('agentIsMentionedOnTask', () => {
  it('detects structured mention by name', () => {
    const task = makeTask({
      comments: [
        { id: 'c1', author: 'Basil', content: 'please check', createdAt: 1, mentions: ['Ana'] },
      ],
    });
    expect(agentIsMentionedOnTask(task, 'Ana')).toBe(true);
    expect(agentIsMentionedOnTask(task, 'ana')).toBe(true);
  });

  it('detects structured mention by agentId', () => {
    const task = makeTask({
      comments: [
        { id: 'c1', author: 'Basil', content: 'hey', createdAt: 1, mentions: ['agent-ana'] },
      ],
    });
    expect(agentIsMentionedOnTask(task, 'Ana', 'agent-ana')).toBe(true);
  });

  it('detects raw text @mention by name', () => {
    const task = makeTask({
      comments: [
        { id: 'c1', author: 'Basil', content: 'Hey @Ana please look at this', createdAt: 1 },
      ],
    });
    expect(agentIsMentionedOnTask(task, 'Ana')).toBe(true);
  });

  it('detects raw text @mention by agentId', () => {
    const task = makeTask({
      comments: [
        { id: 'c1', author: 'Basil', content: 'cc @agent-mikey for context', createdAt: 1 },
      ],
    });
    expect(agentIsMentionedOnTask(task, 'Mikey', 'agent-mikey')).toBe(true);
  });

  it('returns false when no mention exists', () => {
    const task = makeTask({
      comments: [
        { id: 'c1', author: 'Basil', content: 'Looks good', createdAt: 1 },
      ],
    });
    expect(agentIsMentionedOnTask(task, 'Ana')).toBe(false);
  });

  it('returns false when no comments', () => {
    expect(agentIsMentionedOnTask(makeTask({ comments: [] }), 'Ana')).toBe(false);
    expect(agentIsMentionedOnTask(makeTask({ comments: undefined }), 'Ana')).toBe(false);
  });
});

// ── agentHasTaskAccess ──

describe('agentHasTaskAccess', () => {
  it('grants access when agent is assignee (by name)', () => {
    const task = makeTask({ assignee: 'ana', sectionId: 'sec-other' });
    const project = makeProject({ sections: [makeSection({ id: 'sec-other', owner: 'Mikey' })] });
    expect(agentHasTaskAccess(task, project, 'Ana')).toBe(true);
  });

  it('grants access when agent is assignee (by agentId)', () => {
    const task = makeTask({ assignee: 'agent-ana', sectionId: 'sec-other' });
    const project = makeProject({ sections: [makeSection({ id: 'sec-other', owner: 'Mikey' })] });
    expect(agentHasTaskAccess(task, project, 'Ana', 'agent-ana')).toBe(true);
  });

  it('grants access when agent owns the section', () => {
    const task = makeTask({ assignee: 'Mikey', sectionId: 'sec-ana' });
    const project = makeProject({ sections: [makeSection({ id: 'sec-ana', owner: 'Ana' })] });
    expect(agentHasTaskAccess(task, project, 'Ana')).toBe(true);
  });

  it('grants access when task has no sectionId (broadly visible)', () => {
    const task = makeTask({ assignee: 'Mikey', sectionId: undefined });
    const project = makeProject({ sections: [makeSection({ id: 'sec-ana', owner: 'Ana' })] });
    expect(agentHasTaskAccess(task, project, 'Henry')).toBe(true);
  });

  it('grants access when sectionId is default Main', () => {
    const task = makeTask({ assignee: 'Mikey', sectionId: 'sec-main-proj-1' });
    const project = makeProject({ id: 'proj-1' });
    expect(agentHasTaskAccess(task, project, 'Henry')).toBe(true);
  });

  it('grants access when agent is @mentioned', () => {
    const task = makeTask({
      assignee: 'Mikey',
      sectionId: 'sec-other',
      comments: [
        { id: 'c1', author: 'Basil', content: 'cc @Ana', createdAt: 1 },
      ],
    });
    const project = makeProject({ sections: [makeSection({ id: 'sec-other', owner: 'Mikey' })] });
    expect(agentHasTaskAccess(task, project, 'Ana')).toBe(true);
  });

  it('grants access when section is orphaned (not found in project.sections)', () => {
    const task = makeTask({ assignee: 'Mikey', sectionId: 'sec-deleted' });
    const project = makeProject({ sections: [makeSection({ id: 'sec-existing', owner: 'Mikey' })] });
    expect(agentHasTaskAccess(task, project, 'Henry')).toBe(true);
  });

  it('denies access when none of the criteria match', () => {
    const task = makeTask({
      assignee: 'Mikey',
      sectionId: 'sec-mikey',
      comments: [
        { id: 'c1', author: 'Basil', content: 'Looks good', createdAt: 1 },
      ],
    });
    const project = makeProject({ sections: [makeSection({ id: 'sec-mikey', owner: 'Mikey' })] });
    // Ana is not assignee, not section owner, not @mentioned, section exists, not Main
    expect(agentHasTaskAccess(task, project, 'Ana', 'agent-ana')).toBe(false);
  });
});

// ── agentOwnedSections ──

describe('agentOwnedSections', () => {
  it('returns sections owned by agent', () => {
    const projects = [
      makeProject({
        id: 'p1',
        name: 'Alpha',
        sections: [
          makeSection({ id: 'sec-1', owner: 'Ana' }),
          makeSection({ id: 'sec-2', owner: 'Mikey' }),
        ],
      }),
    ];
    const result = agentOwnedSections(projects, 'Ana');
    expect(result).toHaveLength(1);
    expect(result[0].section.id).toBe('sec-1');
    expect(result[0].project.id).toBe('p1');
  });

  it('is case-insensitive', () => {
    const projects = [
      makeProject({
        sections: [makeSection({ id: 'sec-1', owner: 'ANA' })],
      }),
    ];
    expect(agentOwnedSections(projects, 'ana')).toHaveLength(1);
  });

  it('skips complete projects', () => {
    const projects = [
      makeProject({
        phase: 'complete',
        sections: [makeSection({ id: 'sec-1', owner: 'Ana' })],
      }),
    ];
    expect(agentOwnedSections(projects, 'Ana')).toHaveLength(0);
  });

  it('returns empty for no matches', () => {
    const projects = [
      makeProject({
        sections: [makeSection({ id: 'sec-1', owner: 'Mikey' })],
      }),
    ];
    expect(agentOwnedSections(projects, 'Ana')).toHaveLength(0);
  });

  it('spans multiple projects', () => {
    const projects = [
      makeProject({ id: 'p1', name: 'A', sections: [makeSection({ id: 's1', owner: 'Ana' })] }),
      makeProject({ id: 'p2', name: 'B', sections: [makeSection({ id: 's2', owner: 'Ana' })] }),
    ];
    expect(agentOwnedSections(projects, 'Ana')).toHaveLength(2);
  });

  it('handles projects with no sections', () => {
    const projects = [makeProject({ sections: undefined })];
    expect(agentOwnedSections(projects, 'Ana')).toHaveLength(0);
  });
});
