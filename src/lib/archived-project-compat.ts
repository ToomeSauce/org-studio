/**
 * Archived-project compatibility helper.
 *
 * QA-only projects that were folded into parent project sections (ticket #685)
 * are marked `isArchived: true` with a `migratedTo` pointer.
 *
 * Any API endpoint that operates on a single project ID should call
 * `checkArchivedProject()` and, if it returns `migrated: true`, respond
 * with HTTP 410 Gone + the redirect payload.
 */

export interface MigratedResult {
  migrated: true;
  migratedTo: { projectId: string; sectionId: string };
}

export interface NotMigratedResult {
  migrated: false;
  migratedTo?: undefined;
}

export type ArchivedProjectCheck = MigratedResult | NotMigratedResult;

/**
 * Check whether `projectId` refers to an archived+migrated project.
 *
 * @param projects - full project list (from store)
 * @param projectId - the project ID being accessed
 * @returns `{ migrated: true, migratedTo }` or `{ migrated: false }`
 */
export function checkArchivedProject(
  projects: any[],
  projectId: string
): ArchivedProjectCheck {
  if (!projectId || !Array.isArray(projects)) return { migrated: false };

  const project = projects.find((p: any) => p.id === projectId);
  if (!project) return { migrated: false };

  if (
    project.isArchived &&
    project.migratedTo &&
    typeof project.migratedTo === 'object' &&
    project.migratedTo.projectId &&
    project.migratedTo.sectionId
  ) {
    return {
      migrated: true,
      migratedTo: {
        projectId: project.migratedTo.projectId,
        sectionId: project.migratedTo.sectionId,
      },
    };
  }

  return { migrated: false };
}
