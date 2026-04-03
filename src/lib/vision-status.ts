/**
 * Translate internal vision/autonomy states to plain English labels
 * Used for display in Home, Projects list, and Project detail pages
 */

export interface Project {
  id: string;
  name: string;
  currentVersion?: string;
  autonomy?: {
    pendingVersion?: string | null;
    approvalMode?: string;
    cadence?: string;
    lastApprovedAt?: number;
    lastProposal?: any;
  };
}

export interface StatusLabel {
  label: string;
  color: string;
  emoji: string;
}

/**
 * Get the status label for a project based on its autonomy and sprint state
 * 
 * @param project - The project object
 * @param tasks - Array of all tasks (for sprint activity check)
 * @returns StatusLabel with label, color (tailwind), and emoji
 */
export function getProjectStatusLabel(project: Project, tasks: any[] = []): StatusLabel {
  const pending = project.autonomy?.pendingVersion;

  // Planning: Agent is working on next version
  if (pending === 'awaiting_agent_response') {
    return {
      label: 'Planning next version...',
      color: 'blue',
      emoji: '🔄',
    };
  }

  // Starting: About to launch a cycle
  if (pending === 'needs_launch') {
    return {
      label: 'Starting...',
      color: 'blue',
      emoji: '⏳',
    };
  }

  // Approval pending: Version proposed, waiting for human decision
  if (pending && pending !== 'in-progress' && pending !== null) {
    return {
      label: `v${pending} proposed — awaiting approval`,
      color: 'amber',
      emoji: '🔴',
    };
  }

  // Check for active sprint (tasks with current version)
  const projectTasks = tasks.filter((t: any) => t.projectId === project.id && !t.isArchived);
  const currentVersion = project.currentVersion;

  if (currentVersion && projectTasks.length > 0) {
    const versionTasks = projectTasks.filter((t: any) => t.version === currentVersion);
    const activeTasks = versionTasks.filter((t: any) => t.status === 'in-progress' || t.status === 'qa');
    const doneTasks = versionTasks.filter((t: any) => t.status === 'done');
    const total = versionTasks.length;

    if (activeTasks.length > 0) {
      return {
        label: `Sprint active — ${doneTasks.length}/${total} done`,
        color: 'green',
        emoji: '⚙️',
      };
    }

    if (doneTasks.length === total && total > 0) {
      return {
        label: 'Sprint complete',
        color: 'green',
        emoji: '✅',
      };
    }

    if (versionTasks.length > 0) {
      return {
        label: `v${currentVersion} — ${doneTasks.length}/${total} done`,
        color: 'slate',
        emoji: '📋',
      };
    }
  }

  // Default: No active sprint
  return {
    label: 'No active sprint',
    color: 'slate',
    emoji: '—',
  };
}

/**
 * Get color class for status badge
 */
export function getStatusColorClass(color: string): string {
  const colorMap: Record<string, string> = {
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    green: 'bg-green-50 text-green-700 border-green-200',
    slate: 'bg-slate-50 text-slate-600 border-slate-200',
  };
  return colorMap[color] || colorMap.slate;
}
