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
   * #1112 PR 3 (additive): per-component approval banner. Tasks whose
   * `version` is beyond this value are NOT dispatch-eligible even when the
   * project is started. Replaces the project-wide
   * `project.autonomy.approvedThrough` field (which is still consulted as a
   * fallback for the primary component until PR 6 completes migration).
   */
  approvedThrough?: string;
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
    approvedThrough?: string | null;
  };
}

export interface TaskLike {
  id: string;
  status: string;
  sectionId?: string;
  version?: string;
  projectId: string;
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
    inProgress: filtered.filter(t => t.status === 'in-progress' || t.status === 'review' || t.status === 'blocked').length,
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
 *   2. The migration target in PR 6 (project.versions[] → primary.versions[],
 *      project.autonomy.approvedThrough → primary.approvedThrough).
 *
 * Returns undefined when no component qualifies (project has no components,
 * or every component has role === 'qa' | 'support').
 */
export function getPrimaryComponent(project: ProjectLike): ComponentLike | undefined {
  const comps = getEffectiveComponents(project);
  return comps.find((c) => !c.role || (c.role !== 'qa' && c.role !== 'support'));
}

// ─── Per-component roadmap reads (#1112 PR 3) ───

/**
 * Return the effective roadmap versions for a given component.
 *
 * Preference order:
 *   1. `component.versions[]` (PR 3 shape) when populated — the component
 *      owns its own roadmap.
 *   2. For the PRIMARY component only: fall back to `project.versions[]`
 *      (pre-PR-3 shape) when the component has no versions of its own. This
 *      keeps legacy projects rendering and dispatching correctly until PR 6
 *      migrates the data.
 *   3. Empty array for non-primary components with no versions of their own.
 *
 * Returns a fresh array (never mutates input). Order matches source order.
 */
export function getComponentVersions(
  project: ProjectLike,
  componentId: string,
): ComponentVersionLike[] {
  const comps = getEffectiveComponents(project);
  const component = comps.find((c) => c.id === componentId);
  if (!component) return [];

  // (1) Component owns its own roadmap.
  if (component.versions && component.versions.length > 0) {
    return component.versions.slice();
  }

  // (2) Primary-component fallback to the legacy project-level roadmap.
  const primary = getPrimaryComponent(project);
  if (primary && primary.id === componentId && project.versions && project.versions.length > 0) {
    return project.versions.slice();
  }

  // (3) Non-primary component with no versions: genuinely empty.
  return [];
}

/**
 * Return the effective approval banner ("approvedThrough" version string)
 * for a given component.
 *
 * Preference order:
 *   1. `component.approvedThrough` (PR 3 shape) when set — the component owns
 *      its own banner.
 *   2. For the PRIMARY component only: fall back to
 *      `project.autonomy.approvedThrough` (pre-PR-3 shape) when the component
 *      doesn't have its own banner. Keeps legacy projects working until PR 6.
 *   3. `undefined` — no banner set; nothing is dispatch-eligible for this
 *      component.
 */
export function getComponentApprovedThrough(
  project: ProjectLike,
  componentId: string,
): string | undefined {
  const comps = getEffectiveComponents(project);
  const component = comps.find((c) => c.id === componentId);
  if (!component) return undefined;

  // (1) Component owns its own banner.
  if (component.approvedThrough) return component.approvedThrough;

  // (2) Primary-component fallback to the legacy project-level banner.
  const primary = getPrimaryComponent(project);
  if (primary && primary.id === componentId) {
    const legacy = project.autonomy?.approvedThrough;
    if (legacy) return legacy;
  }

  // (3) No banner.
  return undefined;
}
