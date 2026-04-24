/**
 * Tests for component-helpers.ts and project page component logic
 * #1112 PR 3
 */
import { describe, it, expect } from 'vitest';
import {
  getComponentIcon,
  getComponentCounts,
  getComponentTotalCount,
  resolveWaitsForLabel,
  shouldShowLegacyDrawer,
  filterTasksByComponent,
  getEffectiveComponents,
  getPrimaryComponent,
  getComponentVersions,
  getComponentApprovedThrough,
  type ComponentLike,
  type ComponentVersionLike,
  type ProjectLike,
  type TaskLike,
} from '@/lib/component-helpers';

// ─── Fixtures ───

const mainComp: ComponentLike = {
  id: 'comp-main',
  name: 'Main',
  owner: 'Mikey',
  role: 'dev',
};

const qaComp: ComponentLike = {
  id: 'comp-qa',
  name: 'QA',
  owner: 'Billy',
  role: 'qa',
  waitsFor: [{ componentId: 'comp-main', version: '0.14.0' }],
};

const designComp: ComponentLike = {
  id: 'comp-design',
  name: 'Design',
  owner: 'Alice',
  role: 'design lead',
};

const currentProject: ProjectLike = {
  id: 'proj-1',
  name: 'Mission Control',
  currentVersion: '0.14.0',
  components: [mainComp, qaComp, designComp],
};

const otherProject: ProjectLike = {
  id: 'proj-2',
  name: 'Voice Service',
  components: [{ id: 'comp-voice-core', name: 'Core', owner: 'Gem', role: 'dev' }],
};

const allProjects: ProjectLike[] = [currentProject, otherProject];

const tasks: TaskLike[] = [
  { id: 't1', status: 'backlog', sectionId: 'comp-main', version: '0.14.0', projectId: 'proj-1' },
  { id: 't2', status: 'backlog', sectionId: 'comp-main', version: '0.14.0', projectId: 'proj-1' },
  { id: 't3', status: 'in-progress', sectionId: 'comp-main', version: '0.14.0', projectId: 'proj-1' },
  { id: 't4', status: 'done', sectionId: 'comp-main', version: '0.14.0', projectId: 'proj-1' },
  { id: 't5', status: 'done', sectionId: 'comp-main', version: '0.14.0', projectId: 'proj-1' },
  { id: 't6', status: 'backlog', sectionId: 'comp-qa', version: '0.14.0', projectId: 'proj-1' },
  { id: 't7', status: 'done', sectionId: 'comp-main', version: '0.13.0', projectId: 'proj-1' }, // different version
  { id: 't8', status: 'review', sectionId: 'comp-main', version: '0.14.0', projectId: 'proj-1' },
];

// ─── Tests ───

describe('getComponentIcon', () => {
  it('returns 🧪 for QA roles', () => {
    expect(getComponentIcon('qa')).toBe('🧪');
    expect(getComponentIcon('QA Lead')).toBe('🧪');
  });

  it('returns 🎨 for design roles', () => {
    expect(getComponentIcon('design')).toBe('🎨');
    expect(getComponentIcon('design lead')).toBe('🎨');
  });

  it('returns 🧩 for generic roles', () => {
    expect(getComponentIcon('dev')).toBe('🧩');
    expect(getComponentIcon(undefined)).toBe('🧩');
    expect(getComponentIcon('backend')).toBe('🧩');
  });
});

describe('getComponentCounts', () => {
  it('counts tasks for a component in the current version (1. Components panel renders counts)', () => {
    const counts = getComponentCounts(tasks, 'comp-main', '0.14.0');
    expect(counts.backlog).toBe(2);
    expect(counts.inProgress).toBe(2); // 1 in-progress + 1 review
    expect(counts.done).toBe(2);
  });

  it('counts tasks for QA component', () => {
    const counts = getComponentCounts(tasks, 'comp-qa', '0.14.0');
    expect(counts.backlog).toBe(1);
    expect(counts.inProgress).toBe(0);
    expect(counts.done).toBe(0);
  });

  it('excludes tasks from other versions', () => {
    const counts = getComponentCounts(tasks, 'comp-main', '0.13.0');
    // Only t7 matches version 0.13.0
    expect(counts.done).toBe(1);
    expect(counts.backlog).toBe(0);
  });

  it('returns zeroes for a component with no tasks', () => {
    const counts = getComponentCounts(tasks, 'comp-design', '0.14.0');
    expect(counts.backlog).toBe(0);
    expect(counts.inProgress).toBe(0);
    expect(counts.done).toBe(0);
  });
});

describe('getComponentTotalCount', () => {
  it('sums all count buckets', () => {
    expect(getComponentTotalCount({ backlog: 2, inProgress: 3, done: 5 })).toBe(10);
  });
});

describe('resolveWaitsForLabel', () => {
  it('resolves same-project waitsFor (3. waitsFor chip renders with component @ version)', () => {
    const result = resolveWaitsForLabel('proj-1', allProjects, {
      componentId: 'comp-main',
      version: '0.14.0',
    });
    expect(result.label).toBe('Main @ 0.14.0');
    expect(result.isCrossProject).toBe(false);
  });

  it('resolves cross-project waitsFor (4. shows otherProject › comp @ version)', () => {
    const result = resolveWaitsForLabel('proj-1', allProjects, {
      componentId: 'comp-voice-core',
      projectId: 'proj-2',
      version: '1.0.0',
    });
    expect(result.label).toBe('Voice Service › Core @ 1.0.0');
    expect(result.isCrossProject).toBe(true);
    expect(result.targetProjectId).toBe('proj-2');
  });

  it('falls back to raw component id when project not found', () => {
    const result = resolveWaitsForLabel('proj-1', allProjects, {
      componentId: 'comp-unknown',
      projectId: 'proj-999',
      version: '2.0',
    });
    expect(result.label).toBe('proj-999 › comp-unknown @ 2.0');
    expect(result.isCrossProject).toBe(true);
  });

  it('falls back to raw id when component not found in known project', () => {
    const result = resolveWaitsForLabel('proj-1', allProjects, {
      componentId: 'comp-gone',
      version: '0.14.0',
    });
    expect(result.label).toBe('comp-gone @ 0.14.0');
    expect(result.isCrossProject).toBe(false);
  });
});

describe('shouldShowLegacyDrawer', () => {
  it('returns false when neither devOwner nor qaOwner is set (5. Legacy drawer hidden)', () => {
    expect(shouldShowLegacyDrawer({ id: 'p1', name: 'X' })).toBe(false);
  });

  it('returns true when devOwner is set (6. Legacy drawer shown)', () => {
    expect(shouldShowLegacyDrawer({ id: 'p1', name: 'X', devOwner: 'Mikey' })).toBe(true);
  });

  it('returns true when qaOwner is set (7. Legacy drawer shown for qaOwner)', () => {
    expect(shouldShowLegacyDrawer({ id: 'p1', name: 'X', qaOwner: 'Billy' })).toBe(true);
  });

  it('returns true when both are set', () => {
    expect(shouldShowLegacyDrawer({ id: 'p1', name: 'X', devOwner: 'Mikey', qaOwner: 'Billy' })).toBe(true);
  });
});

describe('filterTasksByComponent', () => {
  it('returns all tasks when pillId is "all" (10. Board filter all → no filter)', () => {
    const result = filterTasksByComponent(tasks, 'all');
    expect(result).toHaveLength(tasks.length);
  });

  it('returns all tasks when pillId is undefined', () => {
    const result = filterTasksByComponent(tasks, undefined);
    expect(result).toHaveLength(tasks.length);
  });

  it('filters to matching sectionId (9. Board filter pill → state updates)', () => {
    const result = filterTasksByComponent(tasks, 'comp-main');
    // 7 tasks have sectionId=comp-main (t1-t5, t7, t8)
    expect(result.every(t => t.sectionId === 'comp-main')).toBe(true);
    expect(result.length).toBe(7);
  });

  it('filters to QA component', () => {
    const result = filterTasksByComponent(tasks, 'comp-qa');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('t6');
  });

  it('returns empty for non-existent component', () => {
    expect(filterTasksByComponent(tasks, 'comp-nope')).toHaveLength(0);
  });
});

describe('getEffectiveComponents', () => {
  it('prefers components[] when populated', () => {
    const result = getEffectiveComponents(currentProject);
    expect(result).toHaveLength(3);
    expect(result[0].name).toBe('Main');
  });

  it('falls back to sections[] when components is empty', () => {
    const proj: ProjectLike = {
      id: 'p',
      name: 'P',
      sections: [{ id: 's1', name: 'Section1', owner: 'Bob' }],
    };
    const result = getEffectiveComponents(proj);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Section1');
  });

  it('returns empty array when neither is populated', () => {
    expect(getEffectiveComponents({ id: 'p', name: 'P' })).toHaveLength(0);
  });
});

// 2. Row shows owner + role + counts — covered by getComponentCounts + getComponentIcon tests above
// 8. Edit modal no longer has Dev Owner field — verified by build + UI smoke test (no @testing-library/react)

// ─── #1112 PR 3: per-component roadmap helpers ───

describe('getPrimaryComponent', () => {
  it('returns first non-QA, non-support component', () => {
    const proj: ProjectLike = {
      id: 'p',
      name: 'P',
      components: [
        { id: 'qa', name: 'QA', owner: 'B', role: 'qa' },
        { id: 'main', name: 'Main', owner: 'M' },
        { id: 'support', name: 'Support', owner: 'S', role: 'support' },
      ],
    };
    expect(getPrimaryComponent(proj)?.id).toBe('main');
  });

  it('treats component with no role as primary-eligible', () => {
    const proj: ProjectLike = {
      id: 'p',
      name: 'P',
      components: [{ id: 'main', name: 'Main', owner: 'M' }],
    };
    expect(getPrimaryComponent(proj)?.id).toBe('main');
  });

  it('falls back to sections[] when components[] empty', () => {
    const proj: ProjectLike = {
      id: 'p',
      name: 'P',
      sections: [{ id: 'main', name: 'Main', owner: 'M' }],
    };
    expect(getPrimaryComponent(proj)?.id).toBe('main');
  });

  it('returns undefined when every component is qa/support', () => {
    const proj: ProjectLike = {
      id: 'p',
      name: 'P',
      components: [
        { id: 'qa', name: 'QA', owner: 'B', role: 'qa' },
        { id: 'support', name: 'Support', owner: 'S', role: 'support' },
      ],
    };
    expect(getPrimaryComponent(proj)).toBeUndefined();
  });

  it('returns undefined when project has no components', () => {
    expect(getPrimaryComponent({ id: 'p', name: 'P' })).toBeUndefined();
  });
});

describe('getComponentVersions', () => {
  const v1: ComponentVersionLike = { version: '0.1.0', status: 'shipped' };
  const v2: ComponentVersionLike = { version: '0.2.0', status: 'planned' };

  it('returns component.versions[] when populated', () => {
    const proj: ProjectLike = {
      id: 'p',
      name: 'P',
      components: [{ id: 'main', name: 'Main', owner: 'M', versions: [v1, v2] }],
      versions: [{ version: '9.9.9', status: 'shipped' }], // ignored
    };
    const result = getComponentVersions(proj, 'main');
    expect(result.map((v) => v.version)).toEqual(['0.1.0', '0.2.0']);
  });

  it('falls back to project.versions[] for the primary component', () => {
    const proj: ProjectLike = {
      id: 'p',
      name: 'P',
      components: [{ id: 'main', name: 'Main', owner: 'M' }],
      versions: [v1, v2],
    };
    const result = getComponentVersions(proj, 'main');
    expect(result.map((v) => v.version)).toEqual(['0.1.0', '0.2.0']);
  });

  it('does NOT fall back to project.versions[] for a non-primary component', () => {
    const proj: ProjectLike = {
      id: 'p',
      name: 'P',
      components: [
        { id: 'main', name: 'Main', owner: 'M' },
        { id: 'qa', name: 'QA', owner: 'B', role: 'qa' },
      ],
      versions: [v1],
    };
    expect(getComponentVersions(proj, 'qa')).toEqual([]);
  });

  it('returns empty array for unknown componentId', () => {
    expect(getComponentVersions({ id: 'p', name: 'P' }, 'nope')).toEqual([]);
  });

  it('does not mutate source (returns fresh array)', () => {
    const src = [v1, v2];
    const proj: ProjectLike = {
      id: 'p',
      name: 'P',
      components: [{ id: 'main', name: 'Main', owner: 'M', versions: src }],
    };
    const result = getComponentVersions(proj, 'main');
    result.push({ version: 'junk', status: 'planned' });
    expect(src).toHaveLength(2);
  });
});

describe('getComponentApprovedThrough', () => {
  it('returns component.approvedThrough when set', () => {
    const proj: ProjectLike = {
      id: 'p',
      name: 'P',
      components: [{ id: 'main', name: 'Main', owner: 'M', approvedThrough: '0.5.0' }],
      autonomy: { approvedThrough: '9.9.9' }, // ignored
    };
    expect(getComponentApprovedThrough(proj, 'main')).toBe('0.5.0');
  });

  it('falls back to project.autonomy.approvedThrough for the primary component', () => {
    const proj: ProjectLike = {
      id: 'p',
      name: 'P',
      components: [{ id: 'main', name: 'Main', owner: 'M' }],
      autonomy: { approvedThrough: '0.5.0' },
    };
    expect(getComponentApprovedThrough(proj, 'main')).toBe('0.5.0');
  });

  it('does NOT fall back to project.autonomy for a non-primary component', () => {
    const proj: ProjectLike = {
      id: 'p',
      name: 'P',
      components: [
        { id: 'main', name: 'Main', owner: 'M' },
        { id: 'qa', name: 'QA', owner: 'B', role: 'qa' },
      ],
      autonomy: { approvedThrough: '0.5.0' },
    };
    expect(getComponentApprovedThrough(proj, 'qa')).toBeUndefined();
  });

  it('returns undefined for unknown componentId', () => {
    expect(getComponentApprovedThrough({ id: 'p', name: 'P' }, 'nope')).toBeUndefined();
  });

  it('returns undefined when neither component nor project has a banner', () => {
    const proj: ProjectLike = {
      id: 'p',
      name: 'P',
      components: [{ id: 'main', name: 'Main', owner: 'M' }],
    };
    expect(getComponentApprovedThrough(proj, 'main')).toBeUndefined();
  });
});
