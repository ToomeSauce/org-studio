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

export interface ComponentLike {
  id: string;
  name: string;
  owner: string;
  role?: string;
  outcomes?: string;
  contract?: string;
  waitsFor?: ComponentWaitsFor[];
}

export interface ProjectLike {
  id: string;
  name: string;
  currentVersion?: string;
  devOwner?: string;
  qaOwner?: string;
  components?: ComponentLike[];
  sections?: ComponentLike[];
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
