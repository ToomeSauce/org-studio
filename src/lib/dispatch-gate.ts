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
 */
import {
  getComponentApprovedThrough,
  getComponentVersions,
  getEffectiveComponents,
  type ComponentVersionLike,
  type ProjectLike,
} from '@/lib/component-helpers';
import { compareVersions } from '@/lib/version-utils';
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
 * shape). Post-PR-6 there is no legacy fallback — an unknown version or
 * a component with no `versions[]` returns false (empty ≠ shipped).
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
 * Post-#1112 PR 6: only per-version `component.versions[i].waitsFor` is
 * consulted. Legacy component-level `component.waitsFor[]` was removed
 * after the data migration.
 */
export function isTaskGatedByWaitsFor(store: StoreLike, task: TaskLike): boolean {
  if (!task?.projectId || !task?.sectionId) return false;
  const proj = (store.projects || []).find((p) => p.id === task.projectId);
  if (!proj) return false;
  const cmp = getEffectiveComponents(proj).find((c) => c.id === task.sectionId);
  if (!cmp || !cmp.versions || cmp.versions.length === 0) return false;

  const v = cmp.versions.find((vv) => vv.version === task.version);
  const w = v?.waitsFor;
  if (!w || !w.componentId || !w.version) return false;
  const targetProjectId = w.projectId || task.projectId;
  return !isComponentVersionShipped(store, targetProjectId, w.componentId, w.version);
}

/**
 * Canonical version sort: explicit `sort_order` ASC first, then semver ASC.
 * Mirrors the sort applied at the roadmap read path; isolating it here keeps
 * the sequential gate consistent with what the UI shows users.
 */
function sortVersionsCanonical(versions: ComponentVersionLike[]): ComponentVersionLike[] {
  return versions.slice().sort((a, b) => {
    if (a.sort_order != null && b.sort_order != null) return a.sort_order - b.sort_order;
    if (a.sort_order != null) return -1;
    if (b.sort_order != null) return 1;
    return compareVersions(a.version, b.version);
  });
}

/**
 * #1126 PR 2: Returns true iff every version that comes BEFORE `targetVersion`
 * (canonical order) on this component is `status: 'shipped'` (or `'done'` as
 * a tolerant alias for legacy data).
 *
 * Used by the sequential dispatch gate: a version cannot dispatch tasks
 * until every prior version is shipped. Versions within a single component
 * are an ordered queue; tasks within a single version remain unordered.
 *
 * Edge cases:
 *   - Component has no `versions[]` at all → returns true (no prior to check).
 *   - `targetVersion` is the first version in canonical order → returns true.
 *   - `targetVersion` is not present in `versions[]` → returns true (caller's
 *     other rules will handle the unknown-version case; this predicate is
 *     specifically about "prior versions complete", not version validity).
 *
 * NOTE: this predicate does not look at task statuses. The component's own
 * `version.status` IS the source of truth for shipped/not. PR 5 of the
 * roadmap-sync work flips drifted statuses based on linked task completion;
 * the sequential gate trusts that result.
 */
export function priorVersionsComplete(
  store: StoreLike,
  projectId: string,
  componentId: string,
  targetVersion: string,
): boolean {
  const proj = (store.projects || []).find((p) => p.id === projectId);
  if (!proj) return true;
  const versions = getComponentVersions(proj, componentId);
  if (versions.length === 0) return true;
  const sorted = sortVersionsCanonical(versions);
  const idx = sorted.findIndex((v) => v.version === targetVersion);
  if (idx <= 0) return true; // first version OR not found
  for (let i = 0; i < idx; i++) {
    const status = sorted[i].status;
    if (status !== 'shipped' && status !== 'done') return false;
  }
  return true;
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

  // Rule 5 (#1126 PR 2): all prior versions on this component must be shipped.
  // Sequential dispatch — versions queue up, tasks within a version don't.
  //
  // PR2→PR4 transitional carve-out: legacy `role: 'qa'` sections are exempt
  // from this rule. They still flow through their existing component-level
  // waitsFor edges (Rule 4) until PR 5 migrates Thrivor and PR 6 rips the
  // role: 'qa' branch entirely. Without this carve-out, applying sequential
  // gating to Thrivor's QA section would deadlock dispatch in the migration
  // window.
  const proj2 = (store.projects || []).find((p) => p.id === task.projectId);
  const cmp = proj2 ? getEffectiveComponents(proj2).find((c) => c.id === task.sectionId) : undefined;
  const isLegacyQaSection = cmp?.role === 'qa';
  if (!isLegacyQaSection) {
    if (!priorVersionsComplete(store, task.projectId!, task.sectionId!, task.version!)) {
      return false;
    }
  }

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
  if (!withinHorizon) return false;

  // Waiting on a per-version waitsFor edge (existing).
  if (isTaskGatedByWaitsFor(store, task)) return true;

  // #1126 PR 2: waiting because a prior version on the same component is
  // not yet shipped. The work IS approved (within horizon) but blocked on
  // the queue ahead of it. That's a wait, not idle. Same legacy carve-out
  // as the dispatch gate: role: 'qa' sections aren't sequence-gated until
  // PR 5/6 lands.
  const cmp = getEffectiveComponents(proj).find((c) => c.id === task.sectionId);
  const isLegacyQaSection = cmp?.role === 'qa';
  if (!isLegacyQaSection && !priorVersionsComplete(store, task.projectId!, task.sectionId!, task.version!)) {
    return true;
  }
  return false;
}
