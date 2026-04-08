'use client';

import { useWSData, useWSConnected } from '@/lib/ws';
import { Teammate, buildAgentMap } from '@/lib/teammates';
import { getProjectStatusLabel } from '@/lib/vision-status';
import { OnboardingWizard } from '@/components/OnboardingWizard';
import { SuggestedFeedbackSection } from '@/components/SuggestedFeedbackSection';
import { clsx } from 'clsx';
import { useMemo, useState, useEffect, useCallback } from 'react';
import { ArrowRight, AlertCircle } from 'lucide-react';

// ─── SECTION 1: Mission Statement ──────────────────────────────────────────

function MissionSection({ missionStatement }: { missionStatement?: string }) {
  const DEFAULT_MISSION = 'Define your mission — what does your team exist to do?';
  const mission = missionStatement || DEFAULT_MISSION;
  const isDefault = mission === DEFAULT_MISSION;

  return (
    <div className={clsx(
      'p-6 rounded-[var(--radius-lg)] border',
      isDefault
        ? 'border-[var(--border-default)] bg-[var(--bg-secondary)]'
        : 'border-l-4 border-l-[var(--accent-primary)] bg-gradient-to-r from-[rgba(var(--accent-primary-rgb),0.03)] to-transparent'
    )}>
      <div className="text-center">
        <p className="text-sm text-[var(--text-muted)] mb-1">Our Mission:</p>
        <p className={clsx(
          'text-lg font-bold leading-relaxed',
          isDefault ? 'text-[var(--text-muted)] italic' : 'text-[var(--text-primary)]'
        )}>
          {mission}
        </p>
      </div>
    </div>
  );
}

// ─── SECTION 2: Team Activity ─────────────────────────────────────────────

function TeamActivitySection({ teammates, activityStatuses, tasks, projects }: { teammates: Teammate[]; activityStatuses: Record<string, any>; tasks: any[]; projects: any[] }) {
  const now = Date.now();

  // Build project lookup
  const projectMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of projects) map[p.id] = p.name;
    return map;
  }, [projects]);

  // Find last activity per agent from task history
  const lastTaskActivity = useMemo(() => {
    const result: Record<string, { timestamp: number; projectName: string }> = {};
    for (const task of tasks) {
      const assignee = (task.assignee || '').toLowerCase();
      if (!assignee) continue;
      // Use the most recent meaningful timestamp
      const ts = task.completedAt || task.lastActivityAt || task.startedAt || task.createdAt || 0;
      const tsNum = typeof ts === 'string' ? new Date(ts).getTime() : ts;
      if (tsNum && (!result[assignee] || tsNum > result[assignee].timestamp)) {
        result[assignee] = {
          timestamp: tsNum,
          projectName: projectMap[task.projectId] || '',
        };
      }
    }
    return result;
  }, [tasks, projectMap]);

  // Deduplicate teammates by agentId
  const seen = new Set<string>();
  const uniqueTeammates = teammates.filter((tm: Teammate) => {
    if (!tm.agentId) return false;
    const key = tm.agentId.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const agents = uniqueTeammates
    .map((tm: Teammate) => {
      const status = activityStatuses[tm.agentId.toLowerCase()];
      const lastActive = status?.updatedAt || 0;
      const isActive = now - lastActive < 60 * 60 * 1000; // 1 hour
      
      // Also count as active if agent has in-progress tasks
      const hasInProgressTask = (tasks || []).some((t: any) => (
        (t.assignee?.toLowerCase() === tm.name.toLowerCase() || 
         t.assignee?.toLowerCase() === tm.agentId.toLowerCase()) && 
        t.status === 'in-progress'
      ));
      
      const isActiveWithTasks = isActive || hasInProgressTask;
      let statusDetail = status?.status || status?.detail || '';

      // Generate status from in-progress task if no self-reported status
      let derivedStatus = statusDetail;
      if (!derivedStatus && hasInProgressTask) {
        const ipTask = (tasks || []).find((t: any) => (
          (t.assignee?.toLowerCase() === tm.name.toLowerCase() || 
           t.assignee?.toLowerCase() === tm.agentId.toLowerCase()) && 
          t.status === 'in-progress'
        ));
        if (ipTask) {
          const taskTitle = ipTask.title?.length > 40 ? ipTask.title.slice(0, 40) + '…' : ipTask.title;
          const projName = projectMap[ipTask.projectId] || '';
          derivedStatus = projName ? `${taskTitle} · ${projName}` : taskTitle || 'Working on task';
        }
      }

      // For idle agents, find their last task activity
      const nameKey = tm.name.toLowerCase();
      const agentKey = tm.agentId.toLowerCase();
      const lastTask = lastTaskActivity[nameKey] || lastTaskActivity[agentKey];

      return {
        emoji: tm.emoji,
        name: tm.name,
        isActive: isActiveWithTasks,
        statusDetail: derivedStatus,
        lastTask,
      };
    })
    .sort((a, b) => (a.isActive !== b.isActive ? (a.isActive ? -1 : 1) : a.name.localeCompare(b.name)));

  return (
    <div>
      <h2 className="text-[var(--text-md)] font-semibold text-[var(--text-primary)] mb-3">Team Activity</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
        {agents.map((agent) => (
          <div key={agent.name} className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-md)] p-4 text-center hover:border-[var(--border-strong)] transition-all">
            <div className="text-2xl mb-2">{agent.emoji}</div>
            <p className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)] truncate mb-1">{agent.name}</p>
            <div className="flex items-center justify-center gap-1.5">
              <span
                className={clsx(
                  'w-2 h-2 rounded-full shrink-0',
                  agent.isActive ? 'bg-[var(--success)] animate-pulse' : 'bg-[var(--text-muted)]'
                )}
              />
              <p className={clsx(
                'text-[var(--text-xs)] truncate',
                agent.isActive ? 'text-[var(--text-secondary)]' : 'text-[var(--text-muted)]'
              )}>
                {agent.isActive ? agent.statusDetail : (
                  agent.lastTask ? formatLastActive(agent.lastTask.timestamp, agent.lastTask.projectName) : 'No activity yet'
                )}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatLastActive(timestamp: number, projectName: string): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  let timeStr: string;
  if (minutes < 1) timeStr = 'just now';
  else if (minutes < 60) timeStr = `${minutes}m ago`;
  else if (hours < 24) timeStr = `${hours}h ago`;
  else if (days < 7) timeStr = `${days}d ago`;
  else timeStr = new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  return projectName ? `${timeStr} · ${projectName}` : timeStr;
}

// ─── SECTION 3: Sprints ────────────────────────────────────────────────────

function SprintsSection({ projects, tasks, agentMap }: { projects: any[]; tasks: any[]; agentMap: Record<string, Teammate> }) {
  const projectMap = new Map(projects.map((p: any) => [p.id, p.name || p.title]));
  const enrichedTasks = tasks.map((t: any) => ({ ...t, projectName: projectMap.get(t.projectId) }));

  const sprints = useMemo(() => {
    const activeWorkStatuses = ['backlog', 'in-progress', 'qa', 'review', 'done'];
    const results: any[] = [];

    // Filter out archived projects
    const activeProjects = projects.filter((p: any) => !p.isArchived);

    for (const project of activeProjects) {
      const projectTasks = enrichedTasks.filter(
        (t: any) => t.projectId === project.id && activeWorkStatuses.includes(t.status)
      );

      if (projectTasks.length === 0) continue;

      const done = projectTasks.filter((t: any) => t.status === 'done').length;
      const total = projectTasks.length;
      const hasActive = projectTasks.some((t: any) => ['in-progress', 'qa', 'review'].includes(t.status));
      const allDone = projectTasks.every((t: any) => t.status === 'done');

      let statusEmoji = '📋';
      if (hasActive) statusEmoji = '⚙️';
      else if (allDone) statusEmoji = '✅';

      const devOwner = project.devOwner ? agentMap[project.devOwner.toLowerCase()]?.name : undefined;

      results.push({
        id: project.id,
        name: project.name || project.title || 'Untitled',
        version: project.currentVersion ? `v${project.currentVersion}` : undefined,
        done,
        total,
        statusEmoji,
        devOwner,
        hasActive,
        allDone,
      });
    }

    // Sort by most recently updated (using task activity)
    results.sort((a, b) => {
      const aTasks = enrichedTasks.filter((t: any) => t.projectId === projects.find((p: any) => p.name === a.name)?.id);
      const bTasks = enrichedTasks.filter((t: any) => t.projectId === projects.find((p: any) => p.name === b.name)?.id);
      const aLatest = Math.max(0, ...aTasks.map((t: any) => t.lastActivityAt || t.createdAt || 0));
      const bLatest = Math.max(0, ...bTasks.map((t: any) => t.lastActivityAt || t.createdAt || 0));
      return bLatest - aLatest;
    });

    return results;
  }, [projects, enrichedTasks, agentMap]);

  if (sprints.length === 0) return null;

  return (
    <div>
      <h2 className="text-[var(--text-md)] font-semibold text-[var(--text-primary)] mb-3">Project Sprints</h2>
      <div className="space-y-2">
        {sprints.map((sprint) => (
          <a
            key={sprint.id}
            href={`/projects/${sprint.id}`}
            className="flex items-center gap-4 p-4 bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-md)] hover:border-[var(--border-strong)] transition-all group"
          >
            <span className="text-lg flex-shrink-0">{sprint.statusEmoji}</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <p className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)] group-hover:text-[var(--accent-primary)] transition-colors truncate">
                  {sprint.name}
                </p>
                {sprint.version && <span className="text-[var(--text-xs)] text-[var(--text-muted)] font-mono">{sprint.version}</span>}
              </div>
              <div className="h-1.5 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[var(--accent-primary)]"
                  style={{ width: `${(sprint.done / sprint.total) * 100}%` }}
                />
              </div>
            </div>
            <div className="flex items-center gap-3 flex-shrink-0">
              <span className="text-[var(--text-xs)] text-[var(--text-muted)] font-mono">{sprint.done}/{sprint.total}</span>
              {sprint.devOwner && <span className="text-[var(--text-xs)] text-[var(--text-muted)]">{sprint.devOwner}</span>}
              <ArrowRight size={14} className="text-[var(--text-muted)] opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

// ─── SECTION 4: Needs Your Attention ───────────────────────────────────────

function AttentionSection({ tasks, projects }: { tasks: any[]; projects: any[] }) {
  const items = useMemo(() => {
    const result: any[] = [];
    const projectMap = new Map(projects.map((p: any) => [p.id, p.name || p.title]));

    // Filter out archived projects
    const activeProjects = projects.filter((p: any) => !p.isArchived);

    // Pending approvals (pendingVersion is a version string)
    for (const project of activeProjects) {
      if (project.autonomy?.pendingVersion && project.autonomy.pendingVersion !== 'awaiting_agent_response' && project.autonomy.pendingVersion !== 'needs_launch') {
        result.push({
          type: 'pending-approval',
          emoji: '🔴',
          title: `${project.name || project.title || 'Untitled'} v${project.autonomy.pendingVersion} proposed`,
          detail: 'Awaiting approval',
          id: `project-${project.id}`,
        });
      }
    }

    // Blocked tasks
    for (const task of tasks) {
      if (task.status === 'blocked') {
        result.push({
          type: 'blocked',
          emoji: '🟡',
          title: task.title,
          detail: projectMap.get(task.projectId) || task.projectId,
          id: task.id,
        });
      }
    }

    // Stuck tasks (in-progress > 4 hours with no activity)
    const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;
    for (const task of tasks) {
      if (task.status === 'in-progress' && !task.isArchived && task.updatedAt && task.updatedAt > 0 && task.updatedAt < fourHoursAgo) {
        result.push({
          type: 'stuck',
          emoji: '🟡',
          title: task.title,
          detail: `${projectMap.get(task.projectId) || task.projectId} • In progress > 4h`,
          id: task.id,
        });
      }
    }

    return result.slice(0, 10);
  }, [tasks, projects]);

  if (items.length === 0) {
    return (
      <div className="p-6 bg-gradient-to-br from-[rgba(34,197,94,0.05)] to-transparent border border-[var(--border-default)] rounded-[var(--radius-md)] text-center">
        <p className="text-[var(--text-sm)] text-[var(--text-muted)]">✅ All clear — agents are handling everything</p>
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-[var(--text-md)] font-semibold text-[var(--text-primary)] mb-3">Needs Your Attention</h2>
      <div className="space-y-2">
        {items.map((item) => (
          <a
            key={item.id}
            href="/context"
            className="flex items-center gap-3 p-4 bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-md)] hover:border-[var(--border-strong)] transition-all group"
          >
            <span className="text-lg flex-shrink-0">{item.emoji}</span>
            <div className="flex-1 min-w-0">
              <p className="text-[var(--text-sm)] font-medium text-[var(--text-primary)] group-hover:text-[var(--accent-primary)] transition-colors truncate">
                {item.title}
              </p>
              <p className="text-[var(--text-xs)] text-[var(--text-muted)] truncate">{item.detail}</p>
            </div>
            <ArrowRight size={14} className="text-[var(--text-muted)] flex-shrink-0" />
          </a>
        ))}
      </div>
    </div>
  );
}

// ─── SECTION 5: Recent Decisions ────────────────────────────────────────────

function RecentDecisionsSection({ projects }: { projects: any[] }) {
  const decisions = useMemo(() => {
    const result: any[] = [];

    // Filter out archived projects
    const activeProjects = projects.filter((p: any) => !p.isArchived);

    for (const project of activeProjects) {
      const autonomy = project.autonomy || {};

      // Auto-approved versions
      if (autonomy.lastApprovedAt) {
        result.push({
          type: 'approved',
          emoji: '✅',
          title: `${project.name || project.title || 'Untitled'} v${project.currentVersion || '?'} auto-approved`,
          timestamp: autonomy.lastApprovedAt,
        });
      }

      // Rejected versions
      if (autonomy.lastRejectedAt) {
        result.push({
          type: 'rejected',
          emoji: '❌',
          title: `${project.name || project.title || 'Untitled'} rejected`,
          timestamp: autonomy.lastRejectedAt,
        });
      }

      // Timed out cycles
      if (autonomy.lastTimeoutAt) {
        result.push({
          type: 'timeout',
          emoji: '⏱️',
          title: `${project.name || project.title || 'Untitled'} cycle timed out`,
          timestamp: autonomy.lastTimeoutAt,
        });
      }
    }

    // Sort by timestamp (newest first) and limit to 5
    result.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return result.slice(0, 5);
  }, [projects]);

  if (decisions.length === 0) return null;

  const formatRelativeTime = (timestamp: number) => {
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  };

  return (
    <div>
      <h2 className="text-[var(--text-md)] font-semibold text-[var(--text-primary)] mb-3">Recent Decisions</h2>
      <div className="space-y-2">
        {decisions.map((decision, i) => (
          <div
            key={i}
            className="flex items-center gap-3 p-3 bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-[var(--radius-sm)] text-[var(--text-sm)]"
          >
            <span className="flex-shrink-0">{decision.emoji}</span>
            <span className="flex-1 text-[var(--text-primary)]">{decision.title}</span>
            <span className="text-[var(--text-xs)] text-[var(--text-muted)] flex-shrink-0 whitespace-nowrap">
              {formatRelativeTime(decision.timestamp)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── MAIN PAGE ──────────────────────────────────────────────────────────────

export default function HomePage() {
  const wsConnected = useWSConnected();
  const storeData = useWSData<any>('store');
  const rawStatuses = useWSData<any>('activity-status');
  const activityStatuses = rawStatuses?.statuses || rawStatuses || {};

  const teammates: Teammate[] = storeData?.settings?.teammates || [];
  const projects = storeData?.projects || [];
  const tasks = storeData?.tasks || [];
  const missionStatement = storeData?.settings?.missionStatement;
  const agentMap = useMemo(() => buildAgentMap(teammates), [teammates]);

  // Onboarding check
  const DEFAULT_MISSION = 'Define your mission — what does your team exist to do?';
  const onboardingComplete = storeData?.settings?.onboardingComplete === true;
  const storeIsEmpty =
    teammates.length === 0 &&
    projects.length === 0 &&
    (!missionStatement || missionStatement === DEFAULT_MISSION);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [storeLoaded, setStoreLoaded] = useState(false);

  useEffect(() => {
    if (storeData && !storeLoaded) setStoreLoaded(true);
  }, [storeData, storeLoaded]);

  useEffect(() => {
    // Allow ?onboarding=true to force the wizard (for demos/screenshots)
    const params = new URLSearchParams(window.location.search);
    if (params.get('onboarding') === 'true') {
      setShowOnboarding(true);
    } else if (storeLoaded && !onboardingComplete && storeIsEmpty) {
      setShowOnboarding(true);
    }
  }, [storeLoaded, onboardingComplete, storeIsEmpty]);

  const handleOnboardingComplete = useCallback(() => {
    setShowOnboarding(false);
  }, []);

  if (showOnboarding) {
    return <OnboardingWizard onComplete={handleOnboardingComplete} />;
  }

  return (
    <div className="space-y-8">
      {/* Section 1: Mission Statement */}
      <MissionSection missionStatement={missionStatement} />

      {/* Section 2: Needs Your Attention */}
      <AttentionSection tasks={tasks} projects={projects} />

      {/* Section 3: Team Activity */}
      {teammates.length > 0 && (
        <TeamActivitySection teammates={teammates} activityStatuses={activityStatuses} tasks={tasks} projects={projects} />
      )}

      {/* Section 4: Project Sprints */}
      {projects.length > 0 && (
        <SprintsSection projects={projects} tasks={tasks} agentMap={agentMap} />
      )}

      {/* Section 5: Suggested Feedback */}
      <SuggestedFeedbackSection />

      {/* Section 6: Recent Decisions */}
      {projects.length > 0 && (
        <RecentDecisionsSection projects={projects} />
      )}
    </div>
  );
}
