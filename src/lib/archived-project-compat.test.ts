import { describe, it, expect } from 'vitest';
import { checkArchivedProject } from './archived-project-compat';

describe('checkArchivedProject', () => {
  const projects = [
    {
      id: 'proj-active',
      name: 'Active Project',
      isArchived: false,
    },
    {
      id: 'proj-archived-qa',
      name: 'Thrivor QA',
      isArchived: true,
      archivedReason: 'qa-fold',
      migratedTo: { projectId: 'proj-parent', sectionId: 'sec-qa-proj-parent' },
    },
    {
      id: 'proj-archived-no-migrate',
      name: 'Old Project',
      isArchived: true,
      // No migratedTo — manually archived, not a qa-fold
    },
  ];

  it('returns migrated: true for an archived project with migratedTo', () => {
    const result = checkArchivedProject(projects, 'proj-archived-qa');
    expect(result.migrated).toBe(true);
    expect(result.migratedTo).toEqual({
      projectId: 'proj-parent',
      sectionId: 'sec-qa-proj-parent',
    });
  });

  it('returns migrated: false for a non-archived project', () => {
    const result = checkArchivedProject(projects, 'proj-active');
    expect(result.migrated).toBe(false);
    expect(result.migratedTo).toBeUndefined();
  });

  it('returns migrated: false for an archived project without migratedTo', () => {
    const result = checkArchivedProject(projects, 'proj-archived-no-migrate');
    expect(result.migrated).toBe(false);
  });

  it('returns migrated: false for an unknown project ID', () => {
    const result = checkArchivedProject(projects, 'does-not-exist');
    expect(result.migrated).toBe(false);
  });

  it('handles empty / null inputs gracefully', () => {
    expect(checkArchivedProject([], 'any')).toEqual({ migrated: false });
    expect(checkArchivedProject(projects, '')).toEqual({ migrated: false });
    expect(checkArchivedProject(null as any, 'any')).toEqual({ migrated: false });
  });
});
