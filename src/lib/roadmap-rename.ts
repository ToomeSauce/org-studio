/**
 * #1267: Pure helpers for the roadmap version-rename transaction.
 *
 * Extracted so the rename logic is unit-testable without spinning up a full
 * Next.js route-handler test rig. The route handler in
 * src/app/api/roadmap/[projectId]/route.ts wraps these in a Postgres
 * transaction.
 */

export interface RenameProjectDataResult {
  data: any;
  componentsHits: number;
  sectionsHits: number;
  approvedVersionsHits: number;
  autonomyApprovedThrough: boolean;
  currentVersion: boolean;
}

/**
 * Walks a project's `data` jsonb and rewrites every reference to
 * `originalVersion` so it points at `newVersion` (and its rv-derived id at
 * `newId`). Returns a fresh object with hit counts so callers can include
 * them in API responses for visibility.
 *
 * Mutation rules:
 * - components[].versions[] and sections[].versions[]: when an entry has
 *   `version === originalVersion`, rewrite its `version`. If the entry's
 *   `id` was the rv-derived id (`rv-<projectId>-<old-dashed>`), rewrite
 *   to the new rv-derived id; otherwise leave the custom id alone.
 * - components[].approvedVersions[] and sections[].approvedVersions[]:
 *   string-replace `originalVersion` with `newVersion`.
 * - data.autonomy.approvedThrough: legacy field, rewrite if equal.
 * - data.currentVersion: rewrite if equal.
 */
export function renameVersionInProjectData(
  data: any,
  projectId: string,
  originalVersion: string,
  newVersion: string,
): RenameProjectDataResult {
  // Defensive deep-ish clone via JSON round-trip (project.data is plain JSON
  // anyway). We don't want to mutate the caller's reference; the route
  // explicitly writes the returned object back.
  const next = data ? JSON.parse(JSON.stringify(data)) : {};

  const oldRvId = `rv-${projectId}-${originalVersion.replace(/\./g, '-')}`;
  const newRvId = `rv-${projectId}-${newVersion.replace(/\./g, '-')}`;

  let componentsHits = 0;
  let sectionsHits = 0;
  let approvedVersionsHits = 0;

  const rewriteList = (list: any[] | undefined): number => {
    if (!Array.isArray(list)) return 0;
    let hits = 0;
    for (const c of list) {
      if (!c || typeof c !== 'object') continue;
      if (Array.isArray(c.versions)) {
        for (const entry of c.versions) {
          if (entry && entry.version === originalVersion) {
            entry.version = newVersion;
            if (entry.id === oldRvId) entry.id = newRvId;
            hits++;
          }
        }
      }
      if (Array.isArray(c.approvedVersions)) {
        const before = c.approvedVersions.length;
        c.approvedVersions = c.approvedVersions.map((v: string) =>
          v === originalVersion ? newVersion : v,
        );
        // Count any rewrites
        for (let i = 0; i < before; i++) {
          // We can't compare to original now; instead detect by recounting
          // matches below. Cheap approximation: increment per entry that
          // now equals newVersion AND wasn't already newVersion. Skipped:
          // we tally a single bumped count below.
        }
      }
    }
    return hits;
  };

  componentsHits = rewriteList(next.components);
  sectionsHits = rewriteList(next.sections);

  // Recount approvedVersions hits cleanly by walking again (cheaper than the
  // diff dance in rewriteList).
  const countApproved = (list: any[] | undefined): number => {
    if (!Array.isArray(list)) return 0;
    let hits = 0;
    for (const c of list) {
      if (c && Array.isArray(c.approvedVersions)) {
        for (const v of c.approvedVersions) if (v === newVersion) hits++;
      }
    }
    return hits;
  };
  // We can't easily separate "was-already-newVersion" from "rewritten" after
  // the fact; the caller treats this as an upper-bound visibility hint.
  // Compute pre/post by re-reading the original data:
  const origApproved =
    countApproved(data?.components) + countApproved(data?.sections);
  const postApproved =
    countApproved(next.components) + countApproved(next.sections);
  approvedVersionsHits = Math.max(0, postApproved - origApproved);

  let autonomyApprovedThrough = false;
  if (
    next.autonomy &&
    typeof next.autonomy === 'object' &&
    next.autonomy.approvedThrough === originalVersion
  ) {
    next.autonomy.approvedThrough = newVersion;
    autonomyApprovedThrough = true;
  }

  let currentVersion = false;
  if (next.currentVersion === originalVersion) {
    next.currentVersion = newVersion;
    currentVersion = true;
  }

  return {
    data: next,
    componentsHits,
    sectionsHits,
    approvedVersionsHits,
    autonomyApprovedThrough,
    currentVersion,
  };
}

/**
 * Compute the rv-derived id for a (projectId, version) pair. Mirrors the
 * existing convention used throughout the route and the migration scripts.
 */
export function rvDerivedId(projectId: string, version: string): string {
  return `rv-${projectId}-${version.replace(/\./g, '-')}`;
}
