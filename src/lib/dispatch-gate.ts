/**
 * Per-component dispatch gating (#1112 PR 4).
 *
 * Pure, side-effect-free predicates that decide whether a backlog task is
 * dispatch-eligible under the per-component roadmap model.
 *
 * Rule summary (all must hold for an eligible backlog task):
 *   1. project.state === 'started'                                  — master switch
 *   2. task has a component (sectionId) AND a version               — scoped work only
 *   3. task.version <= component.approvedThrough                    — within approval banner
 *   4. component-version waitsFor (if present) is satisfied         — dependency met
 *   (Rule 5 — backlog + assignee — is checked at the scheduler call site.)
 *
 * Legacy fallbacks (removed in PR 6):
 *   - `getComponentApprovedThrough` and `getComponentVersions` fall back to
 *     project-level `autonomy.approvedThrough` / `project.versions[]` for
 *     the primary component.
 *   - `isTaskGatedByWaitsFor` tolerates a component-level `waitsFor[]` array
 *     (PR 2 shape) when the component has no per-version `versions[]` yet.
 */
import {
  getComponentApprovedThrough,
  getComponentVersions,
  getEffectiveComponents,
  type ProjectLike,
} from '@/lib/component-helpers';
import { isVersionLessOrEqual } from '@/lib/version-utils';

interface TaskLike {
  id: string;
  projectId?: string;
  sectionId?: string;
  version?: string;
  status?: string;
  assignee?: string;
  isArchived?: boolean;
}

interface StoreLike {
  projects?: ProjectLike[];
  tasks?: TaskLike[];
}

/**
 * Returns true iff the target component's version is shipped.
 *
 * Canonical source: `component.versions[i].status === 'shipped'` (PR 3
 * shape). Legacy fallback: `getComponentVersions` returns
 * `project.versions[]` for the primary component when the component has no
 * `versions[]` of its own.
 *
 * An unknown version returns false (empty ≠ shipped).
 */
export function isComponentVersionShipped(
  store: StoreLike,
  targetProjectId: string,
  targetComponentId: string,
  targetVersion: string,
): boolean {
  const proj = (store.projects || []).find((p) => p.id === targetProjectId);
  if (!proj) return false;
  const versions = getComponentVersions(proj, targetComponentId);
  const v = versions.find((vv) => vv.version === targetVersion);
  if (!v) return false;
  return v.status === 'shipped';
}

/**
 * Returns true iff the task's component-version has a `waitsFor` dependency
 * that is currently unsatisfied.
 *
 * Preferred: per-version `component.versions[i].waitsFor` (PR 3).
 * Fallback:  component-level `component.waitsFor[]` array (PR 2 shape) — any
 *            unsatisfied entry gates every backlog task under that component.
 */
export function isTaskGatedByWaitsFor(store: StoreLike, task: TaskLike): boolean {
  if (!task?.projectId || !task?.sectionId) return false;
  const proj = (store.projects || []).find((p) => p.id === task.projectId);
  if (!proj) return false;
  const cmp = getEffectiveComponents(proj).find((c) => c.id === task.sectionId);
  if (!cmp) return false;

  // (A) Per-version waitsFor — preferred.
  if (cmp.versions && cmp.versions.length > 0) {
    const v = cmp.versions.find((vv) => vv.version === task.version);
    const w = v?.waitsFor;
    if (!w || !w.componentId || !w.version) return false;
    const targetProjectId = w.projectId || task.projectId;
    return !isComponentVersionShipped(store, targetProjectId, w.componentId, w.version);
  }

  // (B) Legacy component-level waitsFor (PR 2 shape).
  const legacy = Array.isArray(cmp.waitsFor) ? cmp.waitsFor : [];
  for (const w of legacy) {
    if (!w?.componentId || !w?.version) continue;
    const targetProjectId = w.projectId || task.projectId;
    if (!isComponentVersionShipped(store, targetProjectId, w.componentId, w.version)) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true iff the task is dispatch-eligible (all rules 1-4 satisfied).
 * The caller is responsible for rules 5 (status === 'backlog' and assignee
 * matches).
 *
 * Handy predicates the caller can use to distinguish "waiting" from "idle"
 * when deciding auto-stop: see `isTaskWaiting`.
 */
export function isTaskDispatchEligible(store: StoreLike, task: TaskLike): boolean {
  if (!task?.projectId || !task?.sectionId || !task?.version) return false;
  const proj = (store.projects || []).find((p) => p.id === task.projectId);
  if (!proj) return false;

  // Rule 1: project must be started.
  if ((proj as any).state !== 'started') return false;

  // Rule 3: task.version must be within the component's approval banner.
  const approvedThrough = getComponentApprovedThrough(proj, task.sectionId);
  if (!approvedThrough) return false;
  if (!isVersionLessOrEqual(task.version, approvedThrough)) return false;

  // Rule 4: component-version waitsFor must be satisfied.
  if (isTaskGatedByWaitsFor(store, task)) return false;

  return true;
}

/**
 * Returns true iff the task is "waiting" (not idle) — i.e. the project
 * should remain in started state even though this task is not currently
 * dispatch-eligible. Used by the auto-stop pass.
 *
 * Waiting includes:
 *   - status === 'blocked' (human-resolvable blocker)
 *   - backlog task within the component's approval banner but gated by
 *     an unsatisfied waitsFor (dependency pending)
 *
 * "Above horizon" (unapproved) backlog tasks are NOT waiting — they need
 * human approval to enter the active arc; auto-stop is the correct signal.
 */
export function isTaskWaiting(store: StoreLike, task: TaskLike): boolean {
  if (task.status === 'blocked') return true;
  if (task.status !== 'backlog') return false;
  if (!task?.projectId || !task?.sectionId || !task?.version) return false;
  const proj = (store.projects || []).find((p) => p.id === task.projectId);
  if (!proj) return false;

  const approvedThrough = getComponentApprovedThrough(proj, task.sectionId);
  const withinHorizon = !!approvedThrough && isVersionLessOrEqual(task.version, approvedThrough);
  return withinHorizon && isTaskGatedByWaitsFor(store, task);
}
