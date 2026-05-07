/**
 * resolve-section-id (#1269)
 *
 * addTask / updateTask used to silently accept tasks with `projectId` set
 * but `sectionId` missing. The dispatch gate keys on
 * `task.projectId && task.sectionId && task.version`, so a task without
 * sectionId becomes invisible to the scheduler with no warning. This bit
 * #1263 (Basil reported the ticket sitting in backlog forever).
 *
 * Resolution rules:
 *   - sectionId already set on caller payload → return it as-is (no-op).
 *   - Project missing or has no sections/components defined → 400.
 *   - Project has exactly 1 effective section → return its id.
 *   - Project has >1 effective sections → prefer `sec-main-<projectId>`
 *     when present; otherwise 400 with the list of valid section ids.
 *
 * "Effective sections" mirrors `getEffectiveComponents`: components[] if
 * populated, else sections[]. They share the same shape — `{ id, name, ... }`.
 */

import { getEffectiveComponents } from '@/lib/component-helpers';

export interface ResolveOk {
  ok: true;
  sectionId: string;
  /** True iff we filled this in (caller didn't supply one). */
  resolved: boolean;
}

export interface ResolveErr {
  ok: false;
  error: string;
  validSectionIds?: string[];
  status: 400;
}

export type ResolveResult = ResolveOk | ResolveErr;

export function resolveSectionId(
  project: any | null | undefined,
  projectId: string,
  providedSectionId: string | null | undefined,
): ResolveResult {
  // Caller supplied a sectionId — preserve existing behavior, no resolution needed.
  // (Validation that the sectionId actually exists on the project is the
  // caller's job; this helper only fills in the blank.)
  if (providedSectionId && typeof providedSectionId === 'string' && providedSectionId.trim()) {
    return { ok: true, sectionId: providedSectionId, resolved: false };
  }

  if (!project) {
    return {
      ok: false,
      error: `Cannot auto-resolve sectionId — projectId '${projectId}' has no project record.`,
      status: 400,
    };
  }

  const sections = getEffectiveComponents(project) || [];
  const validIds = sections.map((s: any) => s?.id).filter(Boolean) as string[];

  if (validIds.length === 0) {
    return {
      ok: false,
      error: `Cannot auto-resolve sectionId — project '${projectId}' has no sections or components defined. Add a section to the project before filing tasks.`,
      validSectionIds: [],
      status: 400,
    };
  }

  if (validIds.length === 1) {
    return { ok: true, sectionId: validIds[0], resolved: true };
  }

  // Multi-section project — prefer the conventional `sec-main-<projectId>` if it exists.
  const conventionalMain = `sec-main-${projectId}`;
  if (validIds.includes(conventionalMain)) {
    return { ok: true, sectionId: conventionalMain, resolved: true };
  }

  return {
    ok: false,
    error: `Cannot auto-resolve sectionId — project '${projectId}' has multiple sections and no '${conventionalMain}' default. Pass an explicit sectionId.`,
    validSectionIds: validIds,
    status: 400,
  };
}
