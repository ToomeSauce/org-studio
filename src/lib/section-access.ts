/**
 * Section access helpers — pure functions for per-agent context isolation.
 * No I/O, no network. Used by scheduler prompt builder + org-generator.
 */

import type { Section, Task, Project, TaskComment } from './store';

/**
 * Case-insensitive exact match: section.owner vs agentName.
 */
export function sectionOwnerMatches(section: Section, agentName: string): boolean {
  if (!section.owner || !agentName) return false;
  return section.owner.toLowerCase() === agentName.toLowerCase();
}

/**
 * Returns true if sectionId is the default Main section for the given project,
 * or if sectionId is falsy/empty (unsectioned tasks are broadly visible).
 */
export function isDefaultMainSection(sectionId: string | undefined | null, projectId: string): boolean {
  if (!sectionId || sectionId.trim() === '') return true;
  return sectionId === `sec-main-${projectId}`;
}

/**
 * Scan task.comments[] for @mentions of the agent.
 * Checks both structured `comment.mentions[]` and raw text fallback.
 */
export function agentIsMentionedOnTask(
  task: Pick<Task, 'comments'>,
  agentName: string,
  agentId?: string,
): boolean {
  const comments = task.comments;
  if (!comments || comments.length === 0) return false;

  const nameLower = agentName.toLowerCase();
  const idLower = agentId?.toLowerCase();

  for (const comment of comments) {
    // Structured mentions array
    if (comment.mentions && comment.mentions.length > 0) {
      for (const m of comment.mentions) {
        const mLower = m.toLowerCase();
        if (mLower === nameLower) return true;
        if (idLower && mLower === idLower) return true;
      }
    }

    // Raw text fallback — look for @agentName or @agentId
    if (comment.content) {
      const contentLower = comment.content.toLowerCase();
      if (contentLower.includes(`@${nameLower}`)) return true;
      if (idLower && contentLower.includes(`@${idLower}`)) return true;
    }
  }

  return false;
}

/**
 * Determines whether an agent should see a task in their prompt.
 * Returns true if ANY of:
 *   1. task.assignee matches agent (case-insensitive name or id)
 *   2. The task's section owner matches agent
 *   3. Task has no sectionId or sectionId is the default Main → broadly visible
 *   4. Agent is @mentioned on the task (any comment)
 *   5. Task's section is orphaned (id not found in project.sections) → broadly visible
 */
export function agentHasTaskAccess(
  task: Pick<Task, 'assignee' | 'sectionId' | 'comments'>,
  project: Pick<Project, 'id' | 'sections'>,
  agentName: string,
  agentId?: string,
): boolean {
  const nameLower = agentName.toLowerCase();
  const idLower = agentId?.toLowerCase();

  // 1. Assignee match — always visible
  const assigneeLower = (task.assignee || '').toLowerCase();
  if (assigneeLower === nameLower || (idLower && assigneeLower === idLower)) {
    return true;
  }

  // 3. No sectionId or default Main → broadly visible
  if (isDefaultMainSection(task.sectionId, project.id)) {
    return true;
  }

  // Look up the section on the project
  const sections = project.sections || [];
  const section = sections.find(s => s.id === task.sectionId);

  // 5. Orphaned section (id not found) → broadly visible
  if (!section) {
    return true;
  }

  // 2. Section owner matches agent
  if (sectionOwnerMatches(section, agentName)) {
    return true;
  }

  // 4. Agent is @mentioned on any comment
  if (agentIsMentionedOnTask(task, agentName, agentId)) {
    return true;
  }

  return false;
}

/**
 * Returns all (project, section) pairs where the agent is the section owner.
 * Includes Main sections if the agent owns them (caller can filter if desired).
 * Skips archived/complete projects.
 */
export function agentOwnedSections(
  projects: Pick<Project, 'id' | 'name' | 'sections' | 'phase'>[],
  agentName: string,
): Array<{ project: Pick<Project, 'id' | 'name' | 'sections' | 'phase'>; section: Section }> {
  const results: Array<{ project: Pick<Project, 'id' | 'name' | 'sections' | 'phase'>; section: Section }> = [];

  for (const project of projects) {
    // Skip complete projects
    if (project.phase === 'complete') continue;

    const sections = project.sections || [];
    for (const section of sections) {
      if (sectionOwnerMatches(section, agentName)) {
        results.push({ project, section });
      }
    }
  }

  return results;
}
