/**
 * #1287 — Resolve the section's component and the task's roadmap-version
 * row for the notification router. Used by both addComment in
 * `/api/store` and the cross-process LISTEN bridge in `/api/notify/comment`
 * so they produce identical recipient sets.
 *
 * The component is found by:
 *   1. project.components[].id === task.sectionId, OR
 *   2. project.components[].id === project.sections[task.sectionId].componentId
 *   3. fallback: project.sections[].id === task.sectionId (treated as a
 *      pseudo-component with the section's owner — preserves legacy
 *      projects that never adopted distinct components).
 *
 * The version is found by walking the primary component's versions[]
 * (whichever component the store-provider hydration treats as primary —
 * mirrors the `role !== 'qa' | 'support'` selection rule) and matching
 * by `version === task.version`.
 *
 * Returns objects shaped for RouteParams.context. Either field is
 * undefined if not resolvable.
 */
import type { RouterComponent, RouterVersion } from './notification-router';

interface ProjectLike {
  id: string;
  components?: Array<{
    id: string;
    name?: string;
    owner?: string;
    role?: string;
    versions?: Array<{ version: string; owner?: string }>;
  }>;
  sections?: Array<{
    id: string;
    name?: string;
    owner?: string;
    componentId?: string;
  }>;
}

interface TaskLike {
  id: string;
  sectionId?: string;
  version?: string;
  projectId?: string;
}

type ProjectComponent = NonNullable<ProjectLike['components']>[number];

function pickPrimaryComponent(project: ProjectLike): ProjectComponent | undefined {
  const comps = project.components && project.components.length > 0
    ? (project.components as ProjectComponent[])
    : ((project.sections || []) as unknown as ProjectComponent[]);
  if (!comps || comps.length === 0) return undefined;
  const primary = comps.find((c) => {
    const role = c?.role ? String(c.role).toLowerCase() : '';
    return role !== 'qa' && role !== 'support';
  });
  return primary || comps[0];
}

export function resolveTaskComponent(
  project: ProjectLike | undefined | null,
  task: TaskLike | undefined | null,
): RouterComponent | undefined {
  if (!project || !task?.sectionId) return undefined;

  // 1. Direct component id match (most projects: section.id === component.id).
  const directComp = (project.components || []).find((c) => c.id === task.sectionId);
  if (directComp) {
    return { id: directComp.id, name: directComp.name || directComp.id, owner: directComp.owner };
  }

  // 2. Section -> componentId indirection.
  const section = (project.sections || []).find((s) => s.id === task.sectionId);
  if (section?.componentId) {
    const indirect = (project.components || []).find((c) => c.id === section.componentId);
    if (indirect) {
      return { id: indirect.id, name: indirect.name || indirect.id, owner: indirect.owner };
    }
  }

  // 3. Legacy fallback: treat the section itself as the component when
  //    the project has no components[] at all. Section owners are often
  //    humans, but the main router still skips humans via teammate.isHuman.
  if (section && (!project.components || project.components.length === 0)) {
    return { id: section.id, name: section.name || section.id, owner: section.owner };
  }

  return undefined;
}

export function resolveTaskVersion(
  project: ProjectLike | undefined | null,
  task: TaskLike | undefined | null,
): RouterVersion | undefined {
  if (!project || !task?.version) return undefined;
  const primary = pickPrimaryComponent(project);
  if (!primary) return undefined;
  const versions = (primary as any).versions || [];
  const match = versions.find((v: any) => v?.version === task.version);
  if (!match) return undefined;
  return { version: match.version, owner: match.owner };
}
