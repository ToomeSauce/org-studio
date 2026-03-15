'use client';

import { PageHeader } from '@/components/PageHeader';
import { StatusCard } from '@/components/StatusCard';
import { useWSData, useWSConnected } from '@/lib/ws';
import {
  Bot, Clock, Wifi, WifiOff, Zap, CheckCircle2, Circle, ArrowRight, X,
} from 'lucide-react';
import { ActivityTimeline } from '@/components/ActivityTimeline';
import { OnboardingWizard } from '@/components/OnboardingWizard';
import { clsx } from 'clsx';
import { Teammate, resolveColor, buildAgentMap } from '@/lib/teammates';
import { useMemo, useState, useEffect, useCallback } from 'react';

function TaskRow({ task, compact, agentMap }: { task: any; compact?: boolean; agentMap: Record<string, Teammate> }) {
  const assigneeKey = task.assignee?.toLowerCase();
  const teammate = agentMap[assigneeKey] || null;
  const agent = teammate ? { name: teammate.name, emoji: teammate.emoji, color: resolveColor(teammate.color).text } : null;
  const priority = task.priority || 'medium';
  const priorityColors: Record<string, string> = {
    high: 'text-[var(--error)]',
    medium: 'text-[var(--warning)]',
    low: 'text-[var(--text-muted)]',
  };

  return (
    <div className="flex items-center gap-3 py-2.5 px-4 rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] transition-colors">
      {task.status === 'done' ? (
        <CheckCircle2 size={15} className="text-[var(--success)] shrink-0" />
      ) : (
        <Circle size={15} className={clsx('shrink-0', priorityColors[priority] || 'text-[var(--text-muted)]')} />
      )}
      <div className="flex-1 min-w-0">
        <p className={clsx(
          'text-[var(--text-sm)] font-medium truncate',
          task.status === 'done' ? 'text-[var(--text-muted)] line-through' : 'text-[var(--text-primary)]'
        )}>
          {task.title}
        </p>
        {!compact && task.projectId && (
          <p className="text-[var(--text-xs)] text-[var(--text-muted)] truncate mt-0.5">{task.projectName || task.projectId}</p>
        )}
      </div>
      {agent && (
        <span className="flex items-center gap-1 shrink-0">
          <span className="text-sm">{agent.emoji}</span>
          <span className={clsx('text-[var(--text-xs)] font-medium', agent.color)}>{agent.name}</span>
        </span>
      )}
    </div>
  );
}


export default function DashboardPage() {
  const wsConnected = useWSConnected();
  const status = useWSData<any>('gateway-status');
  const sessions = useWSData<any>('sessions');
  const cronData = useWSData<any>('cron');
  const storeData = useWSData<any>('store');
  const rawStatuses = useWSData<any>('activity-status');
  const activityStatuses = rawStatuses?.statuses || rawStatuses || {};
  const state = wsConnected && status ? 'connected' : wsConnected ? 'connecting' : 'disconnected';

  const teammates: Teammate[] = storeData?.settings?.teammates || [];
  const agentMap = useMemo(() => buildAgentMap(teammates), [teammates]);

  const sessionList = sessions?.sessions || sessions || [];
  const cronJobs = cronData?.jobs || cronData || [];
  const tasks = storeData?.tasks || [];
  const projects = storeData?.projects || [];
  const activeSessions = Array.isArray(sessionList)
    ? sessionList.filter((s: any) => s.updatedAt && Date.now() - s.updatedAt < 300000)
    : [];
  const enabledCrons = Array.isArray(cronJobs)
    ? cronJobs.filter((j: any) => j.enabled !== false)
    : [];

  // Enrich tasks with project names
  const projectMap = new Map(projects.map((p: any) => [p.id, p.name || p.title]));
  const enrichedTasks = tasks.map((t: any) => ({ ...t, projectName: projectMap.get(t.projectId) }));

  // Split tasks
  const inProgressTasks = enrichedTasks.filter((t: any) => t.status === 'in-progress');
  const todoTasks = enrichedTasks.filter((t: any) => t.status === 'backlog');
  const recentlyDone = enrichedTasks
    .filter((t: any) => t.status === 'done')
    .sort((a: any, b: any) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
    .slice(0, 5);

  const isFirstRun = tasks.length === 0 && teammates.length <= 2 && !status;

  // ─── Onboarding wizard detection ───────────────────────────────────────
  const DEFAULT_MISSION = 'Define your mission — what does your team exist to do?';
  const onboardingComplete = storeData?.settings?.onboardingComplete === true;
  const storeIsEmpty =
    (storeData?.settings?.teammates || []).length === 0 &&
    (storeData?.projects || []).length === 0 &&
    (!storeData?.settings?.missionStatement || storeData.settings.missionStatement === DEFAULT_MISSION);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [storeLoaded, setStoreLoaded] = useState(false);

  // Only show once we've received store data via WS
  useEffect(() => {
    if (storeData && !storeLoaded) setStoreLoaded(true);
  }, [storeData, storeLoaded]);

  useEffect(() => {
    if (storeLoaded && !onboardingComplete && storeIsEmpty) {
      setShowOnboarding(true);
    }
  }, [storeLoaded, onboardingComplete, storeIsEmpty]);

  const handleOnboardingComplete = useCallback(() => {
    setShowOnboarding(false);
  }, []);

  // Welcome card — dismissible via localStorage
  const [welcomeDismissed, setWelcomeDismissed] = useState(true); // default hidden to avoid flash
  useEffect(() => {
    setWelcomeDismissed(localStorage.getItem('org-studio-welcome-dismissed') === '1');
  }, []);
  const dismissWelcome = () => {
    localStorage.setItem('org-studio-welcome-dismissed', '1');
    setWelcomeDismissed(true);
  };
  const showWelcome = isFirstRun && !welcomeDismissed;

  // ─── Onboarding wizard overlay ─────────────────────────────────────────
  if (showOnboarding) {
    return <OnboardingWizard onComplete={handleOnboardingComplete} />;
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Dashboard"
        description="Your team at a glance — tasks, agents, and live activity"
      />

      {showWelcome && (
        <div className="relative bg-gradient-to-br from-[rgba(255,92,92,0.05)] via-[rgba(139,92,246,0.05)] to-[rgba(34,211,238,0.05)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-8">
          <button onClick={dismissWelcome} className="absolute top-4 right-4 p-1.5 rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors" title="Dismiss">
            <X size={16} />
          </button>
          <div className="text-center">
            <h2 className="text-[var(--text-xl)] font-bold text-[var(--text-primary)] mb-2">Welcome to Org Studio</h2>
            <p className="text-[var(--text-base)] text-[var(--text-tertiary)] mb-6 max-w-lg mx-auto">
              Design your org for humans and AI agents working together.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl mx-auto mb-6">
            <a href="/team" className="group flex flex-col items-center gap-2 p-4 rounded-[var(--radius-md)] bg-[var(--bg-primary)] border border-[var(--border-default)] hover:border-[var(--border-strong)] transition-all text-center">
              <span className="text-2xl">👥</span>
              <span className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">1. Build your team</span>
              <span className="text-[var(--text-xs)] text-[var(--text-muted)]">Add humans and agents</span>
            </a>
            <a href="/vision" className="group flex flex-col items-center gap-2 p-4 rounded-[var(--radius-md)] bg-[var(--bg-primary)] border border-[var(--border-default)] hover:border-[var(--border-strong)] transition-all text-center">
              <span className="text-2xl">💡</span>
              <span className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">2. Define your vision</span>
              <span className="text-[var(--text-xs)] text-[var(--text-muted)]">Create projects & ideas</span>
            </a>
            <a href="/context" className="group flex flex-col items-center gap-2 p-4 rounded-[var(--radius-md)] bg-[var(--bg-primary)] border border-[var(--border-default)] hover:border-[var(--border-strong)] transition-all text-center">
              <span className="text-2xl">📋</span>
              <span className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">3. Add tasks</span>
              <span className="text-[var(--text-xs)] text-[var(--text-muted)]">Kanban board for the team</span>
            </a>
          </div>
          <p className="text-[var(--text-xs)] text-[var(--text-muted)] text-center">
            Connect an agent runtime via <code className="bg-[var(--bg-tertiary)] px-1 py-0.5 rounded">GATEWAY_URL</code> in .env.local to auto-discover agents.
          </p>
        </div>
      )}

      {/* Status cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        <StatusCard
          title="Gateway"
          value={state === 'connected' ? 'Online' : state}
          subtitle={status?.version ? `v${status.version}` : undefined}
          icon={state === 'connected' ? Wifi : WifiOff}
          color={state === 'connected' ? 'success' : 'error'}
          stagger={1}
        />
        <StatusCard
          title="In Progress"
          value={inProgressTasks.length}
          subtitle={`${todoTasks.length} queued`}
          icon={Zap}
          color="accent"
          stagger={2}
        />
        <StatusCard
          title="Active Sessions"
          value={activeSessions.length}
          subtitle={`${Array.isArray(sessionList) ? sessionList.length : 0} total`}
          icon={Bot}
          color="default"
          stagger={3}
        />
        <StatusCard
          title="Cron Jobs"
          value={enabledCrons.length}
          subtitle={`${Array.isArray(cronJobs) ? cronJobs.length : 0} total`}
          icon={Clock}
          color="default"
          stagger={4}
        />
      </div>

      {/* Main content — 3-column */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* In Progress */}
        <div className="animate-rise stagger-5 bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] shadow-[var(--shadow-sm),inset_0_1px_0_var(--card-highlight)] hover:border-[var(--border-strong)] transition-all">
          <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-subtle)]">
            <h2 className="text-[var(--text-md)] font-semibold text-[var(--text-primary)]">🔥 In Progress</h2>
            <span className="text-[var(--text-xs)] text-[var(--text-muted)] font-medium">
              {inProgressTasks.length} tasks
            </span>
          </div>
          <div className="divide-y divide-[var(--border-subtle)] max-h-[400px] overflow-y-auto">
            {inProgressTasks.length > 0 ? (
              inProgressTasks.map((task: any) => (
                <TaskRow key={task.id} task={task} agentMap={agentMap} />
              ))
            ) : (
              <div className="p-6 text-center">
                <p className="text-[var(--text-sm)] text-[var(--text-muted)]">No active tasks</p>
                <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-1 opacity-60">Add one from the <a href="/context" className="text-[var(--accent-primary)] hover:underline">Context board</a></p>
              </div>
            )}
          </div>
          {todoTasks.length > 0 && (
            <>
              <div className="px-5 py-2.5 border-t border-[var(--border-subtle)]">
                <p className="text-[var(--text-xs)] font-semibold text-[var(--text-muted)] uppercase tracking-wider">Up Next</p>
              </div>
              <div className="divide-y divide-[var(--border-subtle)] max-h-[200px] overflow-y-auto">
                {todoTasks.slice(0, 5).map((task: any) => (
                  <TaskRow key={task.id} task={task} compact agentMap={agentMap} />
                ))}
              </div>
            </>
          )}
        </div>

        {/* Recently Completed */}
        <div className="animate-rise stagger-5 bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] shadow-[var(--shadow-sm),inset_0_1px_0_var(--card-highlight)] hover:border-[var(--border-strong)] transition-all">
          <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-subtle)]">
            <h2 className="text-[var(--text-md)] font-semibold text-[var(--text-primary)]">✅ Recently Done</h2>
            <span className="text-[var(--text-xs)] text-[var(--text-muted)] font-medium">
              {enrichedTasks.filter((t: any) => t.status === 'done').length} total
            </span>
          </div>
          <div className="divide-y divide-[var(--border-subtle)] max-h-[400px] overflow-y-auto">
            {recentlyDone.length > 0 ? (
              recentlyDone.map((task: any) => (
                <TaskRow key={task.id} task={task} agentMap={agentMap} />
              ))
            ) : (
              <div className="p-6 text-center">
                <p className="text-[var(--text-sm)] text-[var(--text-muted)]">Nothing completed yet</p>
                <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-1 opacity-60">Finished tasks will appear here</p>
              </div>
            )}
          </div>
        </div>

        {/* Activity Timeline */}
        <ActivityTimeline
          tasks={enrichedTasks}
          teammates={teammates}
          activityStatuses={activityStatuses}
        />
      </div>
    </div>
  );
}
