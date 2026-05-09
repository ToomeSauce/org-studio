/**
 * Pure helper functions for the Components panel and board filter pills.
 * Extracted for testability — no React, no side effects.
 *
 * #1112 PR 3
 */

// ─── Types (duplicated minimally to avoid circular imports) ───

export interface ComponentWaitsFor {
  componentId: string;
  projectId?: string;
  version: string;
}

// #1112 PR 3 (per-component roadmaps): shape of an item inside a version.
// Matches the existing project.versions[].items[] shape so legacy and new
// roadmaps are structurally identical — only their location differs.
export interface RoadmapItemLike {
  id?: string;
  title?: string;
  done?: boolean;
  taskId?: string;
}

// #1112 PR 3 (per-component roadmaps): shape of a version on a component's
// own roadmap. Matches project.versions[] today, with optional per-version
// waitsFor declaring a dependency on another component's shipped version.
export interface ComponentVersionLike {
  id?: string;
  version: string;
  status: 'planned' | 'current' | 'shipped' | string;
  items?: RoadmapItemLike[];
  createdAt?: number;
  sort_order?: number;
  version_type?: string;
  /**
   * Per-version dependency. When present and unsatisfied (the referenced
   * component has not shipped `version`), tasks inside this component-version
   * are NOT dispatch-eligible. Replaces component-level `waitsFor` from PR 2.
   *
   * All tasks grouped into this version share this single dependency. Mixing
   * different dependencies under one version is user-error (not enforced in
   * code — see skills/org-studio-api/SKILL.md).
   */
  waitsFor?: ComponentWaitsFor;
  /**
   * #1126 PR 1 (additive): per-version owner override. When set, this owner
   * takes precedence over the section's default `owner` for tasks created in
   * this version. Enables "versioned ownership" patterns — e.g. a single QA
   * owner takes over a specific version slice without modeling QA as a
   * separate component. Versions remain just versions; the version string is
   * unaffected. See `getEffectiveOwner()`.
   */
  owner?: string;

  /**
   * #1263 — outcome-bound versions. All optional; absence = no gate (zero
   * behavior change for existing versions). When `successCriteria` is set,
   * the version stays open until `metricCurrent` satisfies
   * `metricComparator` vs `metricTarget`, even when all child tickets are
   * done. See src/lib/version-metric.ts.
   */
  successCriteria?: string;
  metricCurrent?: number;
  metricTarget?: number;
  metricComparator?: 'gte' | 'lte' | 'eq';
  /** Human kill-switch — when true, dispatch is suppressed for this version. */
  loopPaused?: boolean;
}

export interface ComponentLike {
  id: string;
  name: string;
  owner: string;
  role?: string;
  outcomes?: string;
  contract?: string;
  /**
   * PR 2 shape — component-level dependency. Superseded by per-version
   * `waitsFor` on `versions[]` in PR 3. Read-path helpers still tolerate this
   * for backward compatibility until PR 6 migrates and deletes it.
   */
  waitsFor?: ComponentWaitsFor[];
  /**
   * #1186 / #1224: explicit list of approved versions for this component.
   * The single source of truth for dispatch eligibility. The vision owner
   * approves any subset (including non-contiguous picks) by ticking
   * checkboxes on the roadmap admin surface.
   */
  approvedVersions?: string[];
  /**
   * #1112 PR 3 (additive): per-component roadmap. Each version may declare a
   * `waitsFor` dependency on another component's shipped version. Replaces
   * the single project-wide `project.versions[]` (still consulted as a
   * fallback for the primary component until PR 6 completes migration).
   */
  versions?: ComponentVersionLike[];
}

export interface ProjectLike {
  id: string;
  name: string;
  currentVersion?: string;
  devOwner?: string;
  qaOwner?: string;
  components?: ComponentLike[];
  sections?: ComponentLike[];
  // Legacy / pre-PR-3 project-level roadmap + approval banner. Retained for
  // fallback reads on the primary component until PR 6 migration completes.
  versions?: ComponentVersionLike[];
  autonomy?: {
    cadence?: string;
    approvalMode?: string;
  };
}

export interface TaskLike {
  id: string;
  status: string;
  sectionId?: string;
  version?: string;
  projectId: string;
  roadmapItemId?: string;
  parentId?: string;
  // #1254 — explicit project-scope opt-in for blocked tasks that have no
  // component (cross-cutting milestones, launches, exit gates).
  projectScoped?: boolean;
}

/**
 * #1235 — Orphan blocked tasks for a project.
 *
 * A task is considered "orphan blocked" when it:
 *   - belongs to the project (projectId match),
 *   - has status === 'blocked',
 *   - is NOT anchored to a component (sectionId),
 *   - is NOT anchored to a roadmap item (roadmapItemId),
 *   - is NOT a sub-task of another task (parentId),
 *   - is NOT explicitly marked projectScoped (#1254 — opt-in for legitimate
 *     project-wide blocked work like launches and exit gates).
 *
 * The projects-list dashboard counts every blocked task in the project
 * (`tasks.filter(t => t.status==='blocked').length`), but the per-version
 * roadmap renders only roadmap-anchored tasks. Orphans contribute to the
 * count yet have nowhere to surface in the project dashboard — this helper
 * makes them findable so users can open and resolve each one.
 */
export function getOrphanBlockedTasks<T extends TaskLike>(
  tasks: T[],
  projectId: string,
): T[] {
  return tasks.filter((t) => {
    if (!t || t.projectId !== projectId) return false;
    if (t.status !== 'blocked') return false;
    if (t.sectionId) return false;
    if (t.roadmapItemId) return false;
    if (t.parentId) return false;
    if (t.projectScoped) return false;
    return true;
  });
}

// ─── Icon selection ───

export function getComponentIcon(role?: string): string {
  if (!role) return '🧩';
  const r = role.toLowerCase();
  if (r.includes('qa')) return '🧪';
  if (r.includes('design')) return '🎨';
  return '🧩';
}

// ─── Task count chips ───

export interface ComponentCounts {
  backlog: number;
  inProgress: number;
  done: number;
}

/**
 * Count tasks for a specific component (by sectionId) in a specific version.
 * Only counts statuses that map to backlog / in-progress / done buckets.
 */
export function getComponentCounts(
  tasks: TaskLike[],
  componentId: string,
  version: string | undefined
): ComponentCounts {
  const filtered = tasks.filter(t => {
    if (t.sectionId !== componentId) return false;
    if (version && t.version !== version) return false;
    return true;
  });

  return {
    backlog: filtered.filter(t => t.status === 'backlog' || t.status === 'planning').length,
    // #1290: 'review' removed; legacy data may still match but column is killed forward-going.
    inProgress: filtered.filter(t => t.status === 'in-progress' || (t.status as string) === 'review' || t.status === 'blocked').length,
    done: filtered.filter(t => t.status === 'done').length,
  };
}

/**
 * Total task count for a component across all status buckets.
 */
export function getComponentTotalCount(counts: ComponentCounts): number {
  return counts.backlog + counts.inProgress + counts.done;
}

// ─── waitsFor label resolution ───

/**
 * Resolve a waitsFor entry to a human-readable label.
 * Returns `"ComponentName @ version"` for same-project,
 * `"ProjectName › ComponentName @ version"` for cross-project.
 * Falls back to raw id if component name can't be resolved.
 */
export function resolveWaitsForLabel(
  currentProjectId: string,
  allProjects: ProjectLike[],
  w: ComponentWaitsFor
): { label: string; isCrossProject: boolean; targetProjectId?: string } {
  const targetProjectId = w.projectId || currentProjectId;
  const isCrossProject = targetProjectId !== currentProjectId;
  const targetProject = allProjects.find(p => p.id === targetProjectId);

  // Resolve component name: try components[] first, then sections[], then raw id
  let componentName = w.componentId;
  if (targetProject) {
    const comp = (targetProject.components || []).find(c => c.id === w.componentId)
      || (targetProject.sections || []).find(s => s.id === w.componentId);
    if (comp) componentName = comp.name;
  }

  if (isCrossProject) {
    const projectName = targetProject?.name || targetProjectId;
    return {
      label: `${projectName} › ${componentName} @ ${w.version}`,
      isCrossProject: true,
      targetProjectId,
    };
  }

  return {
    label: `${componentName} @ ${w.version}`,
    isCrossProject: false,
  };
}

// ─── Legacy drawer visibility ───

export function shouldShowLegacyDrawer(project: ProjectLike): boolean {
  return !!(project.devOwner || project.qaOwner);
}

// ─── Board filter ───

/**
 * Filter tasks by component (sectionId). When pillId is 'all' or undefined,
 * returns all tasks unfiltered.
 */
export function filterTasksByComponent(tasks: TaskLike[], pillId: string | undefined): TaskLike[] {
  if (!pillId || pillId === 'all') return tasks;
  return tasks.filter(t => t.sectionId === pillId);
}

// ─── Get effective components ───

/**
 * Returns components[] if populated, otherwise falls back to sections[].
 * This is the canonical way to read components in the UI.
 */
export function getEffectiveComponents(project: ProjectLike): ComponentLike[] {
  if (project.components && project.components.length > 0) return project.components;
  return project.sections || [];
}

// ─── Primary component convention ───

/**
 * The "primary" component is the first component without a special role
 * (i.e. not 'qa' and not 'support'). Typically named "Main". Used for two
 * things:
 *   1. Legacy fallback during the PR 3 → PR 6 transition: untagged tasks and
 *      the project-level roadmap / approvedThrough are considered to belong
 *      to the primary component.
 *   2. The migration target in PR 6 (project.versions[] → primary.versions[]).
 *      Project-level autonomy.approvedThrough was retired by #1224.
 *
 * Returns undefined when no component qualifies (project has no components,
 * or every component has role === 'qa' | 'support').
 */
export function getPrimaryComponent(project: ProjectLike): ComponentLike | undefined {
  const comps = getEffectiveComponents(project);
  return comps.find((c) => !c.role || (c.role !== 'qa' && c.role !== 'support'));
}

// ─── Per-component roadmap reads (#1112 PR 3; PR 6 removed legacy fallbacks) ───

/**
 * Return the effective roadmap versions for a given component.
 *
 * Post-#1112 PR 6: this just returns `component.versions[]`. The primary-
 * component fallback to `project.versions[]` was removed after the data
 * migration flattened every project into the per-component shape.
 *
 * Returns a fresh array (never mutates input). Order matches source order.
 */
export function getComponentVersions(
  project: ProjectLike,
  componentId: string,
): ComponentVersionLike[] {
  const comps = getEffectiveComponents(project);
  const component = comps.find((c) => c.id === componentId);
  if (!component || !component.versions || component.versions.length === 0) return [];
  return component.versions.slice();
}

/**
 * #1224: max-of-approvedVersions[] convenience reader. Returns `undefined`
 * when nothing is approved. Used in UI surfaces that still want a single
 * "banner" string to render; gating logic should use
 * `getComponentApprovedVersions()` + set membership instead.
 *
 * Function name retains "ApprovedThrough" for call-site stability — the
 * scalar field of that name is gone (#1224); this helper only ever
 * derives from `approvedVersions[]`.
 */
export function getComponentApprovedThrough(
  project: ProjectLike,
  componentId: string,
): string | undefined {
  const comps = getEffectiveComponents(project);
  const component = comps.find((c) => c.id === componentId);
  if (!component) return undefined;
  if (Array.isArray(component.approvedVersions) && component.approvedVersions.length > 0) {
    return maxVersion(component.approvedVersions);
  }
  return undefined;
}

/**
 * #1186: return the explicit set of approved versions for a component.
 * Returns an empty array when none are approved — the empty list is the
 * only "no approvals yet" signal post-#1224 (the legacy `approvedThrough`
 * scalar fallback is gone).
 *
 * Per-version eligibility checks should call:
 *   `getComponentApprovedVersions(project, componentId).includes(taskVersion)`
 * or use `isVersionApproved` directly.
 */
export function getComponentApprovedVersions(
  project: ProjectLike,
  componentId: string,
): string[] {
  const comps = getEffectiveComponents(project);
  const component = comps.find((c) => c.id === componentId);
  if (!component) return [];
  return Array.isArray(component.approvedVersions) ? [...component.approvedVersions] : [];
}

/**
 * #1186: is `version` approved for this component? Set membership against
 * `component.approvedVersions[]`. The legacy `approvedThrough` scalar fallback
 * was retired by #1224 — explicit-list approval is now the only mode.
 *
 * Set membership (not `<=` comparison) is intentional: with non-contiguous
 * approvals (e.g. tick 0.18, skip 0.19, tick 0.20), a `<=max` check would
 * let an unapproved 0.19 promote through. Locked in by #1222.
 */
export function isVersionApproved(
  project: ProjectLike,
  componentId: string,
  version: string,
): boolean {
  const comps = getEffectiveComponents(project);
  const component = comps.find((c) => c.id === componentId);
  if (!component) return false;
  return Array.isArray(component.approvedVersions) && component.approvedVersions.includes(version);
}

/**
 * #1186: max of a non-empty version list (semver-ordered with string
 * fallback). Local helper so component-helpers.ts stays self-contained.
 */
function maxVersion(versions: string[]): string {
  let best = versions[0];
  for (let i = 1; i < versions.length; i++) {
    if (isVersionLessOrEqualLocal(best, versions[i])) best = versions[i];
  }
  return best;
}

/**
 * Local lightweight version compare. Mirrors version-utils.isVersionLessOrEqual
 * without pulling in the import cycle. Treats numeric segments numerically;
 * falls back to lexicographic for non-numeric segments.
 */
function isVersionLessOrEqualLocal(a: string, b: string): boolean {
  if (a === b) return true;
  const ap = a.split('.').map((s) => parseInt(s, 10));
  const bp = b.split('.').map((s) => parseInt(s, 10));
  const len = Math.max(ap.length, bp.length);
  for (let i = 0; i < len; i++) {
    const av = Number.isFinite(ap[i]) ? ap[i] : 0;
    const bv = Number.isFinite(bp[i]) ? bp[i] : 0;
    if (av < bv) return true;
    if (av > bv) return false;
  }
  return true;
}

/**
 * #1126 PR 1: resolve the effective owner for a (component, version) pair.
 *
 * Precedence (highest first):
 *   1. `version.owner` — per-version override on the component
 *   2. `component.owner` — section default
 *   3. `undefined` — no owner resolvable (caller decides fallback)
 *
 * NOTE: this helper does NOT consult `task.assignee`. Per-task assignee is
 * the highest-precedence layer in the full chain
 * (`task.assignee > version.owner > component.owner`), but tasks may not
 * exist yet at call sites that resolve the default for new-task creation.
 * Callers that have a task in hand should check `task.assignee` first and
 * only fall back to this helper when no explicit assignee is set.
 *
 * Returns `undefined` if the component or version cannot be resolved on the
 * project, or if neither layer carries an owner. Callers handle that case.
 */
export function getEffectiveOwner(
  project: ProjectLike,
  componentId: string,
  versionId: string | undefined,
): string | undefined {
  const comps = getEffectiveComponents(project);
  const component = comps.find((c) => c.id === componentId);
  if (!component) return undefined;
  if (versionId && component.versions && component.versions.length > 0) {
    const version = component.versions.find((v) => v.id === versionId);
    if (version && typeof version.owner === 'string' && version.owner.trim().length > 0) {
      return version.owner;
    }
  }
  return component.owner && component.owner.trim().length > 0 ? component.owner : undefined;
}
