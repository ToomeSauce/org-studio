/**
 * Per-component dispatch gating (#1112 PR 4).
 *
 * Pure, side-effect-free predicates that decide whether a backlog task is
 * dispatch-eligible under the per-component roadmap model.
 *
 * Rule summary (all must hold for an eligible backlog task):
 *   1. project.state === 'active'                                   — master switch (#1185)
 *   2. task has a component (sectionId) AND a version               — scoped work only
 *   3. task.version <= component.approvedThrough                    — within approval banner
 *   4. component-version waitsFor (if present) is satisfied         — dependency met
 *   (Rule 5 — backlog + assignee — is checked at the scheduler call site.)
 */
import {
  getComponentApprovedVersions,
  getComponentVersions,
  getEffectiveComponents,
  type ComponentVersionLike,
  type ProjectLike,
} from '@/lib/component-helpers';
import { compareVersions } from '@/lib/version-utils';

interface TaskLike {
  id: string;
  projectId?: string;
  sectionId?: string;
  version?: string;
  status?: string;
  assignee?: string;
  isArchived?: boolean;
  taskType?: string;
  loopPausedAt?: number | string | null;
  createdAt?: number;
}

// #1183 — adhoc tickets (taskType bug/chore/spike/followup) are filed without
// a version. They take the parallel adhoc dispatch lane: project must be
// started, but no sectionId/version/horizon/waitsFor checks.
const ADHOC_TASK_TYPES: ReadonlySet<string> = new Set([
  'bug',
  'chore',
  'spike',
  'followup',
]);

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

  // #1212: when explicit approvedVersions[] is present, prerequisite check
  // considers only prior versions that are ALSO in the approved set. A
  // deliberately skipped (unapproved) prior version does NOT block a later
  // approved one. Legacy approvedThrough mode keeps the all-prior walk.
  const approvedVersions = getComponentApprovedVersions(proj, componentId);
  if (approvedVersions.length > 0) {
    // If the target isn't in the version list, treat as out-of-scope (true).
    // Mirrors the legacy `idx <= 0` short-circuit below.
    const targetIdx = sorted.findIndex((v) => v.version === targetVersion);
    if (targetIdx === -1) return true;
    const approvedSet = new Set(approvedVersions);
    for (const v of sorted) {
      if (v.version === targetVersion) break;
      if (!approvedSet.has(v.version)) continue;
      const status = v.status;
      if (status !== 'shipped' && status !== 'done') return false;
    }
    return true;
  }

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
  // Skip paused/archived defensively (callers also filter, but keep the
  // predicate self-consistent so unit tests are sound in isolation).
  if (task?.isArchived || task?.loopPausedAt) return false;
  if (!task?.projectId || !task?.sectionId || !task?.version) return false;
  const proj = (store.projects || []).find((p) => p.id === task.projectId);
  if (!proj) return false;

  // Rule 1: project must be active. (#1185 rename: 'started' → 'active'.
  // Both literals accepted during transition.)
  const projState = (proj as any).state;
  if (projState !== 'active' && projState !== 'started') return false;

  // Rule 3: task.version must be in the component's approvedVersions[].
  // #1224: approvedThrough scalar is gone — explicit-list approval is the
  // only gate. Empty list = nothing approved = nothing dispatchable.
  const approvedVersions = getComponentApprovedVersions(proj, task.sectionId);
  if (approvedVersions.length === 0) return false;
  if (!approvedVersions.includes(task.version)) return false;

  // Rule 4: component-version waitsFor must be satisfied.
  if (isTaskGatedByWaitsFor(store, task)) return false;

  // Rule 5 (#1126 PR 2): all prior versions on this component must be shipped.
  // Sequential dispatch — versions queue up, tasks within a version don't.
  //
  // The PR2→PR5 transitional `role: 'qa'` carve-out was removed in PR 6
  // after the Thrivor migration folded the only remaining QA section
  // into Main. Versioned ownership is now uniform: every section runs
  // through the same gate.
  if (!priorVersionsComplete(store, task.projectId!, task.sectionId!, task.version!)) {
    return false;
  }

  return true;
}

/**
 * #1183 — adhoc dispatch lane.
 *
 * Adhoc tickets (taskType ∈ {bug, chore, spike, followup}) are filed without
 * a version by design (the addTask validator rejects adhoc + version combos).
 * Before #1183 they were invisible to event-driven dispatch because
 * isTaskDispatchEligible() returned false at the very first guard
 * (`!task.sectionId || !task.version`). Result: bug/chore tickets sat in
 * backlog forever unless a human @mentioned the assignee.
 *
 * The adhoc lane runs in parallel to the roadmap lane. Both predicates are
 * ORed in the scheduler's getActionableWork() and in buildDispatchMessage()'s
 * backlog filter (see src/app/api/scheduler/route.ts and src/lib/scheduler.ts).
 *
 * Eligibility rules (all must hold):
 *   1. taskType is one of the adhoc types
 *   2. status === 'backlog' AND assignee set (caller checks)
 *   3. project exists and project.state === 'active' (mirrors Rule 1 of
 *      the roadmap lane: inactive projects don't dispatch new work) (#1185)
 *   4. not archived, not paused
 *
 * Notes:
 *   - sectionId/version are NOT required (and not checked).
 *   - approvedThrough/waitsFor/priorVersionsComplete are NOT consulted.
 *   - Roadmap work still wins ranking-wise: buildDispatchMessage emits the
 *     top backlog candidate; the caller orders versioned tickets ahead of
 *     adhoc when both qualify.
 */
export function isTaskAdhocDispatchEligible(
  store: StoreLike,
  task: TaskLike,
): boolean {
  if (!task?.projectId || !task?.assignee) return false;
  if (task.isArchived || task.loopPausedAt) return false;
  if (task.status !== 'backlog') return false;
  if (!task.taskType || !ADHOC_TASK_TYPES.has(task.taskType)) return false;
  // #1211: adhoc tickets must NOT carry a version field. Such tasks are
  // inconsistent (adhoc lane has no approvedThrough gate; the roadmap
  // lane requires sectionId+roadmapItemId). Reject so the operator
  // either clears `version` or converts to a feature task.
  if ((task as any).version) return false;
  const proj = (store.projects || []).find((p) => p.id === task.projectId);
  if (!proj) return false;
  // #1185 rename: 'started' → 'active'. Both literals accepted during transition.
  const projState = (proj as any).state;
  if (projState !== 'active' && projState !== 'started') return false;
  return true;
}

/**
 * Umbrella: true iff a task is dispatch-eligible via EITHER lane.
 * Use this from scheduler call sites instead of calling the two predicates
 * separately — keeps the OR canonical and avoids drift.
 *
 * #1189 — this is the canonical eligibility entry point. Versioned and adhoc
 * lanes still have different RULES (versioned tickets need horizon/waitsFor/
 * priorVersionsComplete; adhoc tickets don't), but the dispatch QUEUE that
 * the scheduler picks from is unified — see `getEligibleBacklogFifo` below.
 */
export function isTaskAnyDispatchEligible(
  store: StoreLike,
  task: TaskLike,
): boolean {
  return (
    isTaskDispatchEligible(store, task) ||
    isTaskAdhocDispatchEligible(store, task)
  );
}

/**
 * #1189 — single FIFO dispatch queue per (assignee, project).
 *
 * Returns this agent's eligible backlog tickets across ALL active projects,
 * ordered by `createdAt` ASC (oldest landing first). Versioned roadmap
 * tickets and adhoc bug/chore tickets sit in the same queue in landing
 * order — there is no separate "versioned-first then adhoc" priority.
 *
 * Rationale: the old behavior was that the scheduler picked `backlog[0]`,
 * where `backlog` was a filter result — order was insertion order in
 * `store.tasks`, which usually matches createdAt but not always (e.g.
 * after Postgres reorders, after migrations). Pinning the order to
 * `createdAt` makes it explicit and predictable. New versions added on
 * the fly land at the bottom by virtue of having the largest createdAt;
 * vision owners can drag-reorder via ticket F (#1190).
 *
 * Args:
 *   - agentMatchers: lowercased strings the task.assignee field can match.
 *     Pass [agentName.toLowerCase(), agentId] from the caller — this lets
 *     the predicate be agnostic about agent-name resolution.
 *
 * Returns: tasks newest-last. Caller usually takes [0].
 */
export function getEligibleBacklogFifo(
  store: StoreLike,
  agentMatchers: string[],
): TaskLike[] {
  const matchers = new Set(agentMatchers.map((m) => (m || '').toLowerCase()).filter(Boolean));
  const eligible: TaskLike[] = [];
  for (const t of store.tasks || []) {
    if (t.status !== 'backlog') continue;
    const a = (t.assignee || '').toLowerCase();
    if (!matchers.has(a)) continue;
    if (!isTaskAnyDispatchEligible(store, t)) continue;
    eligible.push(t);
  }
  // Stable ASC by createdAt; ties keep array order (insertion).
  eligible.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  return eligible;
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

  const approvedVersions = getComponentApprovedVersions(proj, task.sectionId);
  if (approvedVersions.length === 0) return false;
  if (!approvedVersions.includes(task.version)) return false;

  // Waiting on a per-version waitsFor edge (existing).
  if (isTaskGatedByWaitsFor(store, task)) return true;

  // #1126 PR 2: waiting because a prior version on the same component is
  // not yet shipped. The work IS approved (within horizon) but blocked on
  // the queue ahead of it. That's a wait, not idle. The PR2→PR5 `role:
  // 'qa'` carve-out was removed in PR 6 — versioned ownership is now
  // uniform across all sections.
  if (!priorVersionsComplete(store, task.projectId!, task.sectionId!, task.version!)) {
    return true;
  }
  return false;
}
