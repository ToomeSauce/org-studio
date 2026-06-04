'use client';

import { useWSData, useWSConnected } from '@/lib/ws';
import { Teammate, buildAgentMap } from '@/lib/teammates';
import { isAwaitingHumanResponse } from '@/lib/blocker-filters';
import { getProjectStatusLabel } from '@/lib/vision-status';
import { SuggestedFeedbackSection } from '@/components/SuggestedFeedbackSection';
import { clsx } from 'clsx';
import { useMemo, useState, useEffect, useCallback } from 'react';
import { ArrowRight, AlertCircle, FolderPlus, Compass, Users as UsersIcon, RefreshCw, X } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';

const OnboardingWizard = dynamic(
  () => import('@/components/OnboardingWizard').then(mod => mod.OnboardingWizard),
  { ssr: false, loading: () => <div className="p-8 text-center text-[var(--text-muted)]">Loading…</div> }
);

// #1495 Bug 3 — Team Activity section removed from home per Basil 2026-05-21.
// Section, TeamActivitySection component, formatLastActive helper, the
// activityStatuses useWSData('activity-status') hook, and the selectedAgent
// state are all gone. The hook is still used in context/team/
// ProjectDashboardPage — confirmed safe to drop from home only. Full prior
// body lives in git history (SHA 705eaf7^).
// ActivityFeedSection still renders (Section 3 below) — it now shows the
// unfiltered feed since there's no longer a click-to-filter surface on this
// page.


// ─── SECTION: First-Run / Empty Workspace ─────────────────────────────────────
// #1604 — When a workspace has zero projects (typically right after onboarding),
// the home page used to fall back to the "All clear" / "No recent activity"
// stubs, which read as "nothing to do" at the exact moment the user needs a
// next action. This section gives an unmistakable primary CTA to create the
// first project + explains, in product terms, what happens next. Fully
// reversible: rendered only while projects.length === 0 and replaced by the
// normal sections as soon as a project exists.
function FirstRunSection({ orgName }: { orgName?: string }) {
  return (
    <div className="border border-[var(--border-default)] rounded-[var(--radius-lg)] bg-[var(--bg-secondary)] p-8 sm:p-10">
      <div className="max-w-2xl">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-[var(--radius-md)] bg-[var(--accent-muted)] mb-5">
          <FolderPlus size={24} className="text-[var(--accent-primary)]" />
        </div>
        <h2 className="text-[var(--text-2xl)] font-bold text-[var(--text-primary)] mb-2 tracking-tight">
          {orgName ? `${orgName} is set up — now create your first project` : 'Create your first project'}
        </h2>
        <p className="text-[var(--text-md)] text-[var(--text-secondary)] leading-relaxed mb-6">
          A project is where your team does its work. Give it a vision — a North Star,
          boundaries, and the outcomes that matter — and your agents will propose a
          roadmap, then ship against it autonomously while you review and approve.
        </p>

        <Link
          href="/projects?new=true"
          className="inline-flex items-center gap-2 px-6 py-3 rounded-[var(--radius-md)] text-[var(--text-base)] font-semibold transition-all bg-[var(--accent-primary)] text-white hover:bg-[var(--accent-hover)] shadow-[var(--shadow-glow)]"
        >
          <FolderPlus size={17} /> Create your first project
        </Link>

        <div className="mt-8 pt-6 border-t border-[var(--border-default)] grid gap-4 sm:grid-cols-3">
          <div className="flex gap-3">
            <Compass size={18} className="text-[var(--accent-primary)] shrink-0 mt-0.5" />
            <div>
              <p className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">1. Set a vision</p>
              <p className="text-[var(--text-xs)] text-[var(--text-tertiary)] mt-0.5">North Star, boundaries, and target outcomes.</p>
            </div>
          </div>
          <div className="flex gap-3">
            <UsersIcon size={18} className="text-[var(--accent-2)] shrink-0 mt-0.5" />
            <div>
              <p className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">2. Assign ownership</p>
              <p className="text-[var(--text-xs)] text-[var(--text-tertiary)] mt-0.5">Pick who owns the vision and the build on the <Link href="/team" className="text-[var(--accent-primary)] hover:underline">Team page</Link>.</p>
            </div>
          </div>
          <div className="flex gap-3">
            <ArrowRight size={18} className="text-[var(--success)] shrink-0 mt-0.5" />
            <div>
              <p className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">3. Approve &amp; ship</p>
              <p className="text-[var(--text-xs)] text-[var(--text-tertiary)] mt-0.5">Agents propose a roadmap; you review, approve, iterate.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// #1606 GAP-4 — Recovery affordance for partially-abandoned onboarding. The wizard
// only full-screen auto-shows on a truly empty workspace; once the user has added
// any data, `storeIsEmpty` is false and the old trigger never re-fired — stranding
// anyone who quit mid-flow (or clicked Settings → Reset Onboarding, which set
// onboardingComplete=false but was defeated by the same condition). This banner
// renders while onboardingComplete===false AND the workspace is non-empty, giving a
// discoverable in-UI 'Resume setup' path with no magic ?onboarding=true param.
// Dismissible per-session (sessionStorage) so it's recoverable, not a nag.
function FirstRunResumeBanner({ onResume, onDismiss }: { onResume: () => void; onDismiss: () => void }) {
  return (
    <div className="flex items-start gap-4 border border-[var(--accent-primary)] bg-[var(--accent-muted)] rounded-[var(--radius-lg)] p-4 sm:p-5">
      <div className="inline-flex items-center justify-center w-9 h-9 rounded-[var(--radius-md)] bg-[var(--bg-primary)] shrink-0">
        <RefreshCw size={17} className="text-[var(--accent-primary)]" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">Finish setting up your workspace</p>
        <p className="text-[var(--text-xs)] text-[var(--text-secondary)] mt-0.5 leading-relaxed">
          You started the setup wizard but didn&apos;t finish. Pick up where you left off — set your
          organization, connect a runtime, and add your team.
        </p>
        <div className="flex items-center gap-3 mt-3">
          <button
            onClick={onResume}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-[var(--radius-md)] text-[var(--text-sm)] font-medium transition-all bg-[var(--accent-primary)] text-white hover:bg-[var(--accent-hover)]"
          >
            <RefreshCw size={14} /> Resume setup
          </button>
          <button
            onClick={onDismiss}
            className="text-[var(--text-sm)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
          >
            Dismiss
          </button>
        </div>
      </div>
      <button
        onClick={onDismiss}
        className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors shrink-0"
        title="Dismiss"
        aria-label="Dismiss setup reminder"
      >
        <X size={16} />
      </button>
    </div>
  );
}

// ─── SECTION: Activity Feed ───────────────────────────────────────────────────
function ActivityFeedSection({ selectedAgent, tasks, projects }: { selectedAgent?: string; tasks?: any[]; projects?: any[] }) {
  const feed = useWSData<any>('activity-feed');
  const wsEvents: any[] = Array.isArray(feed) ? feed : (feed?.events || []);

  // Build fallback from task statusHistory when WS feed is empty
  const fallbackEvents = useMemo(() => {
    if (wsEvents.length > 0 || !tasks?.length) return [];
    // #1290: 'review' kept here so historical activity-feed entries still render with 'eyes' emoji; #862 'qa' similar.
    const statusEmoji: Record<string, string> = { 'in-progress': '⚙️', 'review': '👀', 'done': '✅', 'blocked': '🚫', 'qa': '🧪', 'backlog': '📋' };
    const projectMap: Record<string, string> = {};
    for (const p of (projects || [])) projectMap[p.id] = p.name;
    const entries: any[] = [];
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    for (const task of tasks) {
      if (!task.statusHistory?.length) continue;
      for (const h of task.statusHistory) {
        if (!h.timestamp || h.timestamp < oneDayAgo) continue;
        entries.push({
          id: `hist-${task.id}-${h.status}-${h.timestamp}`,
          timestamp: h.timestamp,
          type: 'task-status',
          emoji: statusEmoji[h.status] || '📋',
          agent: h.by || task.assignee || 'Unknown',
          project: projectMap[task.projectId] || '',
          message: `${h.by || task.assignee || 'Unknown'} moved "${task.title}" to ${h.status}`,
        });
      }
    }
    return entries.sort((a, b) => b.timestamp - a.timestamp).slice(0, 50);
  }, [wsEvents.length, tasks, projects]);

  const events = wsEvents.length > 0 ? wsEvents : fallbackEvents;

  // Filter by agent if selected
  const filtered = selectedAgent ? events.filter(e => e.agent?.toLowerCase() === selectedAgent.toLowerCase()) : events;

  // Group tool events to reduce noise (collapse consecutive tools from same agent)
  const collapsed = useMemo(() => {
    const result: any[] = [];
    for (const evt of filtered) {
      if (evt.type === 'agent-tool') {
        const last = result[result.length - 1];
        if (last?.type === 'agent-tool-group' && last.agent === evt.agent && Date.now() - last.timestamp < 120000) {
          last.tools.push(evt.message);
          last.count++;
          last.timestamp = evt.timestamp;
          continue;
        }
        result.push({
          ...evt,
          type: 'agent-tool-group',
          tools: [evt.message],
          count: 1,
        });
      } else {
        result.push(evt);
      }
    }
    return result.slice(0, 20);
  }, [filtered]);

  if (collapsed.length === 0) {
    return (
      <div className="p-4 border border-[var(--border-default)] rounded-[var(--radius-md)] text-center">
        <p className="text-[var(--text-xs)] text-[var(--text-muted)]">No recent activity</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[var(--text-md)] font-semibold text-[var(--text-primary)]">
          {selectedAgent ? `Activity — ${selectedAgent}` : 'Activity Feed'}
        </h2>
      </div>
      <div className="space-y-1 max-h-[400px] overflow-y-auto border border-[var(--border-default)] rounded-[var(--radius-md)] p-3 bg-[var(--bg-secondary)]">
        {collapsed.map((evt: any) => (
          <div key={evt.id} className="flex items-start gap-2 py-1.5 text-[var(--text-xs)] border-b border-[var(--border-subtle)] last:border-0">
            <span className="shrink-0 w-5 text-center">{evt.emoji || '📋'}</span>
            <div className="flex-1 min-w-0">
              {evt.type === 'agent-tool-group' ? (
                <span className="text-[var(--text-muted)]">
                  <span className="font-medium text-[var(--text-secondary)]">{evt.agent}</span>
                  {' '}{evt.count > 1 ? `${evt.count} tool calls` : evt.tools[0]}
                </span>
              ) : (
                <span className="text-[var(--text-secondary)]">{evt.message}</span>
              )}
              {evt.detail && (
                <p className="text-[var(--text-muted)] mt-0.5 truncate">{evt.detail}</p>
              )}
            </div>
            <span className="text-[var(--text-muted)] shrink-0 tabular-nums">
              {formatFeedTime(evt.timestamp)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatFeedTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}


// ─── SECTION 3: Sprints ────────────────────────────────────────────────────

function SprintsSection({ projects, tasks, agentMap }: { projects: any[]; tasks: any[]; agentMap: Record<string, Teammate> }) {
  const projectMap = new Map(projects.map((p: any) => [p.id, p.name || p.title]));
  const enrichedTasks = tasks.map((t: any) => ({ ...t, projectName: projectMap.get(t.projectId) }));

  const sprints = useMemo(() => {
    // #1290: 'review' removed but kept in legacy filter for historical reporting; #862 'qa' similar.
    const activeWorkStatuses = ['backlog', 'in-progress', 'qa', 'review', 'done'];
    const results: any[] = [];

    // #1190 follow-up — home page "Active Projects" mirrors the projects
    // page Active bucket: only projects with state === 'active' (or legacy
    // 'started' during the #1185 transition). Drops archived and inactive.
    const activeProjects = projects.filter((p: any) => {
      if (p.isArchived) return false;
      const state = p.state;
      return state === 'active' || state === 'started';
    });

    for (const project of activeProjects) {
      const projectTasks = enrichedTasks.filter(
        (t: any) => t.projectId === project.id && activeWorkStatuses.includes(t.status)
      );

      if (projectTasks.length === 0) continue;

      const done = projectTasks.filter((t: any) => t.status === 'done').length;
      const total = projectTasks.length;
      // #1290: 'review' removed; legacy 'qa' kept (#862). Active = in-progress only forward-going.
      const hasActive = projectTasks.some((t: any) => ['in-progress', 'qa', 'review'].includes(t.status));
      const allDone = projectTasks.every((t: any) => t.status === 'done');

      let statusEmoji = '📋';
      if (hasActive) statusEmoji = '⚙️';
      else if (allDone) statusEmoji = '✅';

      const devOwner = project.devOwner ? agentMap[project.devOwner.toLowerCase()]?.name : undefined;

      results.push({
        id: project.id,
        name: project.name || project.title || 'Untitled',
        version: project.currentVersion ? `${project.currentVersion}` : undefined,
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
      <h2 className="text-[var(--text-md)] font-semibold text-[var(--text-primary)] mb-3">Active Projects</h2>
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

    // Filter to only ACTIVE projects — mirrors home "Active Projects" and the
    // projects-page Active bucket. Inactive/archived projects don't bleed
    // blockers onto the home view; they're still visible inside the project
    // itself. (Active = state==='active' or legacy 'started'.)
    const activeProjects = projects.filter((p: any) => {
      if (p.isArchived) return false;
      const state = p.state;
      return state === 'active' || state === 'started';
    });
    const activeProjectIds = new Set(activeProjects.map((p: any) => p.id));

    // Pending approvals (pendingVersion is a version string)
    for (const project of activeProjects) {
      if (project.autonomy?.pendingVersion && project.autonomy.pendingVersion !== 'awaiting_agent_response' && project.autonomy.pendingVersion !== 'needs_launch') {
        result.push({
          type: 'pending-approval',
          emoji: '🔴',
          title: `${project.name || project.title || 'Untitled'} ${project.autonomy.pendingVersion} proposed`,
          detail: 'Awaiting approval',
          id: `project-${project.id}`,
          href: `/projects/${project.id}`,
        });
      }
    }

    // Blocked tasks (only on active projects, only those waiting on the
    // human owner — #1192). Agent-on-agent blockers stay on the project
    // board where they belong.
    for (const task of tasks) {
      if (
        task.status === 'blocked' &&
        activeProjectIds.has(task.projectId) &&
        isAwaitingHumanResponse(task)
      ) {
        result.push({
          type: 'blocked',
          emoji: '🟡',
          title: task.title,
          detail: projectMap.get(task.projectId) || task.projectId,
          id: task.id,
          href: `/context?task=${task.id}`,
        });
      }
    }

    // Stuck tasks (in-progress > 4 hours with no activity, only on active projects)
    const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;
    for (const task of tasks) {
      if (
        task.status === 'in-progress' &&
        !task.isArchived &&
        activeProjectIds.has(task.projectId) &&
        task.updatedAt &&
        task.updatedAt > 0 &&
        task.updatedAt < fourHoursAgo
      ) {
        result.push({
          type: 'stuck',
          emoji: '🟡',
          title: task.title,
          detail: `${projectMap.get(task.projectId) || task.projectId} • In progress > 4h`,
          id: task.id,
          href: `/context?task=${task.id}`,
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
      <h2 className="text-[var(--text-md)] font-semibold text-[var(--text-primary)] mb-3">Blockers</h2>
      <div className="space-y-2">
        {items.map((item) => (
          <a
            key={item.id}
            href={item.href || '/context'}
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
          title: `${project.name || project.title || 'Untitled'} ${project.currentVersion || '?'} auto-approved`,
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
  // Feature-flag dispatch for mobile-first UX was removed — the /tabs/* routes
  // were never built. Flag remains reserved for v0.14+ Thread IA work.

  const wsConnected = useWSConnected();
  const storeData = useWSData<any>('store');
  // #1495 Bug 3 — dropped useWSData('activity-status') hook; was the only
  // home-page consumer. Hook still used in context/team/ProjectDashboardPage.

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
  // #1606 GAP-4 — per-session dismissal of the resume-setup banner (recoverable,
  // not a nag; returns next session until onboarding actually completes).
  const [bannerDismissed, setBannerDismissed] = useState(false);
  // #1495 Bug 3 — selectedAgent state removed with TeamActivitySection. The
  // only setter was the team-card click handler. ActivityFeedSection now
  // shows the unfiltered feed (selectedAgent prop is optional).

  useEffect(() => {
    if (storeData && !storeLoaded) setStoreLoaded(true);
  }, [storeData, storeLoaded]);

  // #1606 GAP-4 — hydrate banner dismissal from sessionStorage on mount.
  useEffect(() => {
    try {
      if (sessionStorage.getItem('os-resume-banner-dismissed') === '1') {
        setBannerDismissed(true);
      }
    } catch { /* sessionStorage unavailable — banner just stays visible */ }
  }, []);

  useEffect(() => {
    // Allow ?onboarding=true to force the wizard (for demos/screenshots)
    const params = new URLSearchParams(window.location.search);
    if (params.get('onboarding') === 'true') {
      setShowOnboarding(true);
    } else if (storeLoaded && !onboardingComplete && storeIsEmpty) {
      // #1606 GAP-4 — full-screen auto-takeover ONLY for a truly empty workspace
      // (genuine first run). Once any data exists, we no longer hijack the screen;
      // the dismissible resume banner below handles recovery instead.
      setShowOnboarding(true);
    }
  }, [storeLoaded, onboardingComplete, storeIsEmpty]);

  const handleOnboardingComplete = useCallback(() => {
    setShowOnboarding(false);
  }, []);

  // #1606 GAP-4 — re-open the wizard from the resume banner (no ?onboarding=true needed).
  const handleResumeOnboarding = useCallback(() => {
    setShowOnboarding(true);
  }, []);

  const handleDismissBanner = useCallback(() => {
    setBannerDismissed(true);
    try { sessionStorage.setItem('os-resume-banner-dismissed', '1'); } catch { /* no-op */ }
  }, []);

  if (showOnboarding) {
    return <OnboardingWizard onComplete={handleOnboardingComplete} />;
  }

  // #1606 GAP-4 — show the resume banner when setup was started but never finished
  // (onboardingComplete still false) AND the workspace already has data (so the
  // full-screen wizard no longer auto-fires). Reuses the same condition that used
  // to silently strand the user. Hidden once onboarding completes or per-session.
  const showResumeBanner =
    storeLoaded && !onboardingComplete && !storeIsEmpty && !bannerDismissed;

  // #1604 — First-run / empty workspace: once onboarding is dismissed but no
  // projects exist yet, show a single clear "create your first project" surface
  // instead of the "All clear"/"No recent activity" stubs, which mislead on an
  // empty workspace. Reverts to the normal dashboard automatically once the
  // first project is created.
  const hasProjects = projects.length > 0;
  if (storeLoaded && !hasProjects) {
    return (
      <div className="space-y-8">
        {showResumeBanner && (
          <FirstRunResumeBanner onResume={handleResumeOnboarding} onDismiss={handleDismissBanner} />
        )}
        <FirstRunSection orgName={storeData?.settings?.orgName} />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* #1606 GAP-4 — resume-setup banner (workspace has projects but onboarding unfinished) */}
      {showResumeBanner && (
        <FirstRunResumeBanner onResume={handleResumeOnboarding} onDismiss={handleDismissBanner} />
      )}
      {/* Section 1: Blockers */}
      <AttentionSection tasks={tasks} projects={projects} />

      {/* Section 2: Team Activity — removed per #1495 (Basil 2026-05-21) */}

      {/* Section 3: Activity Feed */}
      <ActivityFeedSection tasks={tasks} projects={projects} />

      {/* Section 4: Active Projects */}
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
