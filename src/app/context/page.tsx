'use client';

import { PageHeader } from '@/components/PageHeader';
import { addTask, updateTask, deleteTask, type Task, type Project } from '@/lib/store';
import { useWSData, useWSConnected } from '@/lib/ws';
import { Plus, X, Circle, Bot, Activity, Eye, Pencil, Info } from 'lucide-react';
import { clsx } from 'clsx';
import Link from 'next/link';
import { useState, useEffect, useMemo, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

const COLUMNS: { key: Task['status']; label: string; color: string }[] = [
  { key: 'planning', label: 'Planning', color: 'bg-indigo-500' },
  { key: 'backlog', label: 'Backlog', color: 'bg-zinc-500' },
  { key: 'in-progress', label: 'In Progress', color: 'bg-[var(--warning)]' },
  { key: 'review', label: 'Review', color: 'bg-purple-500' },
  { key: 'done', label: 'Done', color: 'bg-[var(--success)]' },
];

const COLUMN_TOOLTIPS: Record<Task['status'], string> = {
  'planning': 'Human-owned — tasks being scoped and specced. Not ready for agents.',
  'backlog': 'Agent intake queue — ready to be picked up. Top = highest priority.',
  'in-progress': 'Actively being worked by agents or humans.',
  'review': 'Waiting for human review and sign-off.',
  'done': 'Completed and verified.',
};

const COLUMN_EMPTY: Record<Task['status'], { emoji: string; heading: string; text: string }> = {
  'planning': { emoji: '🔒', heading: 'Human territory', text: 'Scope and spec tasks here before they\'re ready. Move to Backlog when an agent can pick them up.' },
  'backlog': { emoji: '📥', heading: 'Agent intake', text: 'Ready tasks land here. Agents pull from the top — highest priority first.' },
  'in-progress': { emoji: '⚡', heading: 'Where the work happens', text: 'Agents pull from Backlog and work here. Tasks show up automatically.' },
  'review': { emoji: '👀', heading: 'Awaiting sign-off', text: 'Agents park finished work here for human review.' },
  'done': { emoji: '✅', heading: 'Shipped', text: 'Completed and verified. Nice work, team.' },
};

const PRIORITY_WEIGHT: Record<string, number> = { high: 0, medium: 1, low: 2 };

import { Teammate, resolveColor, buildAgentMap, buildNameColorMap } from '@/lib/teammates';

function TaskCard({ task, projects, onMove, onDelete, onAssign, onEdit, agents, nameColors }: {
  task: Task; projects: Project[];
  onMove: (id: string, status: Task['status']) => void;
  onDelete: (id: string) => void;
  onAssign: (id: string, assignee: string) => void;
  onEdit: (id: string, updates: Partial<Task>) => void;
  agents: string[];
  nameColors: Record<string, string>;
}) {
  const proj = projects.find(p => p.id === task.projectId);
  const daysAgo = Math.floor((Date.now() - task.createdAt) / 86400000);

  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(task.title);
  const [editProject, setEditProject] = useState(task.projectId || '');
  const [editAssignee, setEditAssignee] = useState(task.assignee || '');
  const [editDescription, setEditDescription] = useState(task.description || '');
  const [editPriority, setEditPriority] = useState<'high' | 'medium' | 'low'>(task.priority || 'medium');

  const handleSave = async () => {
    const updates: Partial<Task> = {
      title: editTitle.trim(),
      projectId: editProject,
      assignee: editAssignee,
      description: editDescription.trim() || undefined,
      priority: editPriority,
    };
    onEdit(task.id, updates);
    await updateTask(task.id, updates);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="bg-[var(--bg-primary)] border border-[var(--border-strong)] rounded-[var(--radius-md)] p-3">
        <input
          value={editTitle}
          onChange={e => setEditTitle(e.target.value)}
          className="w-full text-[var(--text-sm)] bg-transparent text-[var(--text-primary)] outline-none mb-2 font-medium"
          autoFocus
          onKeyDown={e => { if (e.key === 'Escape') setEditing(false); }}
        />
        <select
          value={editProject}
          onChange={e => setEditProject(e.target.value)}
          className="w-full text-[var(--text-xs)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] px-2 py-1.5 text-[var(--text-secondary)] outline-none mb-2"
        >
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select
          value={editAssignee}
          onChange={e => setEditAssignee(e.target.value)}
          className="w-full text-[var(--text-xs)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] px-2 py-1.5 text-[var(--text-secondary)] outline-none mb-2"
        >
          {agents.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <textarea
          value={editDescription}
          onChange={e => setEditDescription(e.target.value)}
          rows={2}
          className="w-full text-[var(--text-xs)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] px-2 py-1.5 text-[var(--text-secondary)] outline-none resize-none mb-2"
        />
        <select
          value={editPriority}
          onChange={e => setEditPriority(e.target.value as 'high' | 'medium' | 'low')}
          className="w-full text-[var(--text-xs)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] px-2 py-1.5 text-[var(--text-secondary)] outline-none mb-2.5"
        >
          <option value="high">🔴 High</option>
          <option value="medium">🟡 Medium</option>
          <option value="low">🟢 Low</option>
        </select>
        <div className="flex gap-2">
          <button onClick={handleSave}
            className="text-[var(--text-xs)] px-3 py-1.5 bg-[var(--accent-primary)] text-white rounded-[var(--radius-sm)] hover:bg-[var(--accent-hover)] transition-colors font-medium">
            Save
          </button>
          <button onClick={() => setEditing(false)}
            className="text-[var(--text-xs)] px-3 py-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-md)] p-3.5 hover:border-[var(--border-strong)] transition-all group cursor-default">
      {proj && (
        <span className="text-[var(--text-xs)] font-semibold uppercase tracking-[0.05em] text-[var(--accent-primary)] mb-1.5 block">
          {proj.name}
        </span>
      )}
      <p className="text-[var(--text-sm)] font-medium text-[var(--text-primary)] leading-snug mb-2.5">{task.title}</p>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5 text-[var(--text-xs)] text-[var(--text-muted)]">
          <select
            value={task.assignee}
            onChange={e => onAssign(task.id, e.target.value)}
            className={clsx(
              'bg-transparent border-none outline-none cursor-pointer font-medium p-0 -ml-0.5',
              nameColors[task.assignee] || 'text-[var(--text-muted)]'
            )}
          >
            {agents.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
          <span>{daysAgo === 0 ? 'today' : `${daysAgo}d ago`}</span>
        </div>
        <div className="flex items-center gap-0.5">
          <button onClick={() => {
            setEditTitle(task.title);
            setEditProject(task.projectId || '');
            setEditAssignee(task.assignee || '');
            setEditDescription(task.description || '');
            setEditPriority(task.priority || 'medium');
            setEditing(true);
          }} className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-[var(--bg-hover)] text-[var(--text-muted)] transition-all">
            <Pencil size={14} />
          </button>
          <button onClick={() => onDelete(task.id)} className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-[var(--bg-hover)] text-[var(--text-muted)] transition-all">
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

function parseSession(s: any, agentMap: Record<string, Teammate>) {
  const key: string = s.key || '';
  const parts = key.split(':');
  const agentId = parts.length >= 2 ? parts[1] : '';
  const teammate = agentMap[agentId];
  const agentName = teammate?.name || agentId || 'Unknown';
  const emoji = teammate?.emoji || '🤖';
  const color = teammate ? resolveColor(teammate.color).text : 'text-[var(--text-muted)]';
  const kind: string = s.kind || 'direct';
  const channel = s.lastChannel || s.origin?.surface || '';

  // Build context string
  let context = '';
  const display = s.displayName || '';
  const keyRest = parts.slice(2).join(':'); // everything after agent:<id>:

  if (display.startsWith('Cron:') || kind === 'cron') {
    context = display.replace(/^Cron:\s*/, '') || 'running cron';
  } else if (keyRest.includes('group:') || keyRest.includes('slash:') || kind === 'group') {
    // Group/slash — extract group name
    const groupPart = display.replace(/^(telegram|slack):(g-)?/, '');
    context = `group: ${groupPart || keyRest}`;
  } else if (keyRest.includes('subagent:') || kind === 'run') {
    context = 'running sub-agent';
  } else if (keyRest.includes('thread:')) {
    context = `thread on ${channel || 'slack'}`;
  } else {
    // Direct chat — extract human name
    const userName = display.replace(/\s*id:\d+$/, '').replace(/^(telegram|slack):.*/, '');
    if (userName && userName !== display) {
      context = `chatting with ${userName}`;
    } else if (display && !display.includes(':')) {
      context = `chatting with ${display}`;
    } else {
      context = channel ? `active on ${channel}` : 'active';
    }
  }

  const updatedAt = s.updatedAt || 0;
  const ageSec = updatedAt ? (Date.now() - updatedAt) / 1000 : Infinity;
  const ageLabel = ageSec < 60 ? 'now' : ageSec < 3600 ? `${Math.floor(ageSec / 60)}m ago` : `${Math.floor(ageSec / 3600)}h ago`;
  const isActive = ageSec < 300;
  const isRecent = ageSec < 3600;

  return { key, agentId, agentName, emoji, color, kind, context, ageLabel, isActive, isRecent, channel, model: s.model?.split('/').pop() || '' };
}

function LiveActivityPanel() {
  const sessions = useWSData<any>('sessions');
  const rawStatuses = useWSData<any>('activity-status');
  const storeData = useWSData<any>('store');
  const activityStatuses = rawStatuses?.statuses || rawStatuses || {};
  const sessionList = sessions?.sessions || [];
  const teammates: Teammate[] = storeData?.settings?.teammates || [];
  const agentMap = useMemo(() => buildAgentMap(teammates), [teammates]);
  const allParsed = Array.isArray(sessionList) ? sessionList.map(s => parseSession(s, agentMap)) : [];

  // Group by agent, pick best (most recent) session per agent for the summary
  const agentIds = teammates.filter(t => !t.isHuman && t.agentId).map(t => t.agentId);
  const agentSummaries = agentIds.map(id => {
    const agentSessions = allParsed.filter(s => s.agentId === id);
    const activeSessions = agentSessions.filter(s => s.isActive);
    const best = activeSessions[0] || agentSessions[0];
    const selfReported = activityStatuses[id];
    const teammate = agentMap[id];
    return {
      agentId: id,
      meta: teammate ? { name: teammate.name, emoji: teammate.emoji, color: resolveColor(teammate.color).text } : null,
      activeSessions,
      recentSessions: agentSessions.filter(s => s.isRecent),
      best,
      selfReported,
    };
  });

  // Recent non-main sessions for the feed below
  const recentFeed = allParsed
    .filter(s => s.isRecent && s.kind !== 'direct')
    .slice(0, 8);

  return (
    <div className="w-[280px] shrink-0 border-l border-[var(--border-default)] bg-[var(--bg-secondary)] flex flex-col">
      <div className="px-4 py-3 border-b border-[var(--border-default)] flex items-center gap-2">
        <Activity size={15} className="text-[var(--accent-primary)]" />
        <span className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">Live Activity</span>
        <div className="ml-auto w-2 h-2 rounded-full bg-[var(--success)] animate-pulse" />
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
        {/* Agent status rows */}
        {agentSummaries.map(({ agentId, meta, activeSessions, best, selfReported }) => {
          if (!meta) return null;
          const isActive = activeSessions.length > 0 || !!selfReported;
          const statusText = selfReported?.status
            || (best && isActive ? best.context : best ? `last seen ${best.ageLabel}` : 'offline');
          return (
            <div key={agentId} className={clsx(
              'px-3 py-2.5 rounded-[var(--radius-md)] bg-[var(--bg-primary)] border transition-colors',
              isActive ? 'border-[rgba(52,211,153,0.2)]' : 'border-[var(--border-subtle)] hover:border-[var(--border-default)]'
            )}>
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-sm">{meta.emoji}</span>
                <span className={clsx('text-[var(--text-xs)] font-semibold', meta.color)}>{meta.name}</span>
                <span className={clsx(
                  'text-[10px] font-semibold px-1.5 py-0.5 rounded-full ml-auto',
                  isActive
                    ? 'bg-[var(--success-subtle)] text-[var(--success)]'
                    : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]'
                )}>
                  {isActive ? 'ACTIVE' : 'IDLE'}
                </span>
              </div>
              <p className="text-[var(--text-xs)] text-[var(--text-muted)] truncate">{statusText}</p>
              {selfReported?.detail && (
                <p className="text-[var(--text-xs)] text-[var(--text-muted)] truncate mt-0.5 opacity-60">{selfReported.detail}</p>
              )}
              {activeSessions.length > 1 && (
                <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-1">
                  +{activeSessions.length - 1} more session{activeSessions.length > 2 ? 's' : ''}
                </p>
              )}
            </div>
          );
        })}

        {/* Recent activity feed */}
        {recentFeed.length > 0 && (
          <>
            <div className="pt-2 pb-1 px-1">
              <span className="text-[var(--text-xs)] font-semibold text-[var(--text-muted)] uppercase tracking-wide">Recent</span>
            </div>
            {recentFeed.map((s, i) => (
              <div key={s.key || i} className="px-3 py-2 rounded-[var(--radius-md)] opacity-60 hover:opacity-80 transition-opacity">
                <div className="flex items-center gap-2">
                  <span className="text-xs">{s.emoji}</span>
                  <span className="text-[var(--text-xs)] text-[var(--text-muted)] truncate flex-1">
                    {s.agentName} · {s.context}
                  </span>
                  <span className="text-[var(--text-xs)] text-[var(--text-muted)] shrink-0">{s.ageLabel}</span>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function TasksPageInner() {
  const storeData = useWSData<any>('store');
  const [localTasks, setLocalTasks] = useState<Task[] | null>(null);
  const tasks: Task[] = localTasks || storeData?.tasks || [];
  const projects: Project[] = storeData?.projects || [];
  const loading = !storeData;

  // Sync WS data to local state when it arrives
  useEffect(() => {
    if (storeData?.tasks) setLocalTasks(storeData.tasks);
  }, [storeData]);
  const searchParams = useSearchParams();
  const urlProject = searchParams.get('project');
  const [filterProject, setFilterProject] = useState('all');

  // Sync URL ?project= param to filter on mount / URL change
  useEffect(() => {
    if (urlProject) setFilterProject(urlProject);
  }, [urlProject]);
  const [filterAgent, setFilterAgent] = useState('all');
  const [addingTo, setAddingTo] = useState<Task['status'] | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [newProject, setNewProject] = useState('');
  const [newAssignee, setNewAssignee] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newPriority, setNewPriority] = useState<'high' | 'medium' | 'low'>('medium');
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [dragSourceCol, setDragSourceCol] = useState<string | null>(null);

  const filteredTasks = useMemo(() => {
    return tasks.filter(t => {
      if (filterProject !== 'all' && t.projectId !== filterProject) return false;
      if (filterAgent !== 'all' && t.assignee !== filterAgent) return false;
      return true;
    });
  }, [tasks, filterProject, filterAgent]);

  const teammates: Teammate[] = storeData?.settings?.teammates || [];
  const agentMap = useMemo(() => buildAgentMap(teammates), [teammates]);
  const nameColors = useMemo(() => buildNameColorMap(teammates), [teammates]);
  const knownNames = useMemo(() => teammates.map(t => t.name), [teammates]);
  const agents = useMemo(() => {
    const fromTasks = tasks.map(t => t.assignee).filter(Boolean);
    return [...new Set([...knownNames, ...fromTasks])];
  }, [tasks, knownNames]);

  // Stats now use filteredTasks so they respect the project/agent filter
  const now = Date.now();
  const weekAgo = now - 7 * 86400000;
  const thisWeek = filteredTasks.filter(t => t.createdAt >= weekAgo).length;
  const inProgress = filteredTasks.filter(t => t.status === 'in-progress').length;
  const total = filteredTasks.length;
  const done = filteredTasks.filter(t => t.status === 'done').length;
  const completionRate = total > 0 ? Math.round((done / total) * 100) : 0;

  const handleMove = useCallback(async (id: string, status: Task['status']) => {
    // Optimistic update
    setLocalTasks(prev => (prev || []).map(t => t.id === id ? { ...t, status } : t));
    await updateTask(id, { status });
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    setLocalTasks(prev => (prev || []).filter(t => t.id !== id));
    await deleteTask(id);
  }, []);

  const handleAssign = useCallback(async (id: string, assignee: string) => {
    setLocalTasks(prev => (prev || []).map(t => t.id === id ? { ...t, assignee } : t));
    await updateTask(id, { assignee });
  }, []);

  const handleEdit = useCallback((id: string, updates: Partial<Task>) => {
    setLocalTasks(prev => (prev || []).map(t => t.id === id ? { ...t, ...updates } : t));
  }, []);

  // Auto-assign from project owner when project changes in add form
  const handleProjectChange = useCallback((projectId: string) => {
    setNewProject(projectId);
    const proj = projects.find(p => p.id === projectId);
    if (proj?.owner) {
      setNewAssignee(proj.owner);
    }
  }, [projects]);

  // Open add form with smart defaults
  const openAddForm = useCallback((status: Task['status']) => {
    const defaultProjectId = filterProject !== 'all' ? filterProject : (projects[0]?.id || '');
    const defaultProject = projects.find(p => p.id === defaultProjectId);
    setNewProject(defaultProjectId);
    setNewAssignee(defaultProject?.owner || teammates[0]?.name || '');
    setAddingTo(status);
  }, [filterProject, projects, teammates]);

  const handleAdd = async (status: Task['status']) => {
    if (!newTitle.trim()) return;
    await addTask({
      title: newTitle.trim(),
      status,
      projectId: newProject || (filterProject !== 'all' ? filterProject : (projects[0]?.id || '')),
      assignee: newAssignee || teammates[0]?.name || '',
      description: newDescription.trim() || undefined,
      priority: newPriority,
    });
    setNewTitle('');
    setNewProject('');
    setNewAssignee('');
    setNewDescription('');
    setNewPriority('medium');
    setAddingTo(null);
    // WS will push the updated store automatically
  };

  if (loading) {
    return (
      <div className="space-y-5">
        <PageHeader title="Context Board" description="Loading..." />
      </div>
    );
  }

  return (
    <div className="space-y-5 -mx-6 -my-6">
      <div className="px-6 pt-6 pb-2">
        <PageHeader title="Context Board" description="Share context. Tasks, wins, blockers, learnings. Transparency FTW." />
        <div className="flex items-center gap-8 mt-5">
          {[
            { label: 'This Week', value: thisWeek, color: 'text-[var(--info)]' },
            { label: 'In Progress', value: inProgress, color: 'text-[var(--warning)]' },
            { label: 'Total', value: total, color: 'text-[var(--text-primary)]' },
            { label: 'Completion', value: `${completionRate}%`, color: 'text-[var(--success)]' },
          ].map(stat => (
            <div key={stat.label} className="flex items-baseline gap-2">
              <span className={clsx('text-[var(--text-xl)] font-bold tracking-tight', stat.color)}>{stat.value}</span>
              <span className="text-[var(--text-xs)] font-semibold text-[var(--text-muted)] uppercase tracking-wide">{stat.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Vision context banner */}
      {filterProject !== 'all' && (() => {
        const proj = projects.find(p => p.id === filterProject);
        return proj ? (
          <div className="mx-6 px-4 py-2.5 bg-[var(--accent-primary)]/5 border border-[var(--accent-primary)]/20 rounded-[var(--radius-md)] flex items-center justify-between">
            <div className="flex items-center gap-2 text-[var(--text-sm)]">
              <Eye size={14} className="text-[var(--accent-primary)]" />
              <span className="text-[var(--text-muted)]">Viewing tasks for</span>
              <Link href={`/vision`} className="font-bold text-[var(--accent-primary)] hover:underline">{proj.name}</Link>
            </div>
            <button onClick={() => setFilterProject('all')} className="text-[var(--text-xs)] text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center gap-1 transition-colors">
              <X size={12} /> Clear filter
            </button>
          </div>
        ) : null;
      })()}

      <div className="px-6 flex items-center gap-3 pb-4 border-b border-[var(--border-default)]">
        <select
          value={filterProject}
          onChange={e => setFilterProject(e.target.value)}
          className="text-[var(--text-sm)] px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-[var(--text-secondary)] outline-none focus:border-[var(--accent-primary)] transition-colors"
        >
          <option value="all">All Projects</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>

        <select
          value={filterAgent}
          onChange={e => setFilterAgent(e.target.value)}
          className="text-[var(--text-sm)] px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-[var(--text-secondary)] outline-none focus:border-[var(--accent-primary)] transition-colors"
        >
          <option value="all">All Agents</option>
          {agents.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>

      <div style={{ height: 'calc(100vh - 300px)' }}>
        <div className="overflow-x-auto h-full">
          <div className="flex gap-4 px-6 pb-4 min-w-max h-full">
            {COLUMNS.map(col => {
              const colTasks = filteredTasks
                .filter(t => t.status === col.key)
                .sort((a, b) => {
                  const pa = PRIORITY_WEIGHT[a.priority || 'medium'] ?? 1;
                  const pb = PRIORITY_WEIGHT[b.priority || 'medium'] ?? 1;
                  if (pa !== pb) return pa - pb;
                  return (a.sortOrder ?? a.createdAt) - (b.sortOrder ?? b.createdAt);
                });
              return (
                <div key={col.key} className="w-[270px] shrink-0 flex flex-col"
                  onDragOver={e => {
                    e.preventDefault();
                    // If dragging over the column background (not a card), show drop at end
                    if (dragOverCol !== col.key) setDragOverCol(col.key);
                  }}
                  onDragLeave={e => {
                    // Only clear if actually leaving the column
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                      if (dragOverCol === col.key) { setDragOverCol(null); setDragOverIndex(null); }
                    }
                  }}
                  onDrop={e => {
                    e.preventDefault();
                    const id = e.dataTransfer.getData('taskId');
                    const sourceCol = e.dataTransfer.getData('sourceCol');
                    if (!id) return;

                    const insertIdx = dragOverIndex !== null ? dragOverIndex : colTasks.length;
                    setDragOverCol(null);
                    setDragOverIndex(null);
                    setDragSourceCol(null);

                    if (sourceCol === col.key) {
                      // Within-column reorder
                      const currentIdx = colTasks.findIndex(t => t.id === id);
                      if (currentIdx === -1 || currentIdx === insertIdx || currentIdx === insertIdx - 1) return;

                      const reordered = [...colTasks];
                      const [moved] = reordered.splice(currentIdx, 1);
                      const targetIdx = insertIdx > currentIdx ? insertIdx - 1 : insertIdx;
                      reordered.splice(targetIdx, 0, moved);

                      // Assign new sortOrders
                      reordered.forEach((t, i) => {
                        const newOrder = (i + 1) * 1000;
                        if (t.sortOrder !== newOrder) {
                          setLocalTasks(prev => (prev || []).map(lt => lt.id === t.id ? { ...lt, sortOrder: newOrder } : lt));
                          updateTask(t.id, { sortOrder: newOrder });
                        }
                      });
                    } else {
                      // Cross-column move
                      const newSortOrder = insertIdx < colTasks.length
                        ? (colTasks[insertIdx]?.sortOrder ?? colTasks[insertIdx]?.createdAt ?? Date.now()) - 1
                        : (colTasks.length > 0 ? (colTasks[colTasks.length - 1]?.sortOrder ?? colTasks[colTasks.length - 1]?.createdAt ?? Date.now()) + 1000 : 1000);

                      setLocalTasks(prev => (prev || []).map(t => t.id === id ? { ...t, status: col.key, sortOrder: newSortOrder } : t));
                      updateTask(id, { status: col.key, sortOrder: newSortOrder });
                    }
                  }}
                >
                  <div className="flex items-center gap-2.5 px-2 pb-3 mb-1">
                    <div className={clsx('w-2.5 h-2.5 rounded-full', col.color)} />
                    <span className="text-[var(--text-sm)] font-semibold text-[var(--text-secondary)]">{col.label}</span>
                    <span className="relative group/tip">
                      <Info size={13} className="text-[var(--text-muted)] opacity-40 hover:opacity-80 cursor-help transition-opacity" />
                      <span className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 w-52 px-3 py-2 rounded-[var(--radius-md)] bg-[var(--bg-primary)] border border-[var(--border-strong)] shadow-lg text-[var(--text-xs)] text-[var(--text-secondary)] leading-relaxed opacity-0 pointer-events-none group-hover/tip:opacity-100 group-hover/tip:pointer-events-auto transition-opacity z-50">
                        {COLUMN_TOOLTIPS[col.key]}
                      </span>
                    </span>
                    <span className="text-[var(--text-xs)] text-[var(--text-muted)] ml-auto">{colTasks.length}</span>
                  </div>

                  <div className="flex-1 space-y-0 overflow-y-auto pr-1">
                    {colTasks.map((task, idx) => (
                      <div key={task.id}>
                        {/* Drop indicator line */}
                        {dragOverCol === col.key && dragOverIndex === idx && (
                          <div className={clsx('h-0.5 rounded-full mx-1 my-1', col.color)} />
                        )}
                        <div
                          className="py-1"
                          draggable
                          onDragStart={e => {
                            e.dataTransfer.setData('taskId', task.id);
                            e.dataTransfer.setData('sourceCol', col.key);
                            setDragSourceCol(col.key);
                          }}
                          onDragEnd={() => { setDragOverCol(null); setDragOverIndex(null); setDragSourceCol(null); }}
                          onDragOver={e => {
                            e.preventDefault();
                            e.stopPropagation();
                            const rect = e.currentTarget.getBoundingClientRect();
                            const midY = rect.top + rect.height / 2;
                            const newIdx = e.clientY < midY ? idx : idx + 1;
                            if (dragOverCol !== col.key || dragOverIndex !== newIdx) {
                              setDragOverCol(col.key);
                              setDragOverIndex(newIdx);
                            }
                          }}
                        >
                          <TaskCard task={task} projects={projects} onMove={handleMove} onDelete={handleDelete} onAssign={handleAssign} onEdit={handleEdit} agents={agents} nameColors={nameColors} />
                        </div>
                      </div>
                    ))}
                    {/* Drop indicator at end of list */}
                    {dragOverCol === col.key && dragOverIndex === colTasks.length && (
                      <div className={clsx('h-0.5 rounded-full mx-1 my-1', col.color)} />
                    )}

                    {/* Smart empty state */}
                    {colTasks.length === 0 && addingTo !== col.key && (() => {
                      const empty = COLUMN_EMPTY[col.key];
                      return (
                        <div className="flex flex-col items-center text-center py-8 px-4">
                          <span className="text-2xl mb-2">{empty.emoji}</span>
                          <p className="text-[var(--text-xs)] font-semibold text-[var(--text-secondary)] mb-1">{empty.heading}</p>
                          <p className="text-[var(--text-xs)] text-[var(--text-muted)] leading-relaxed max-w-[200px]">{empty.text}</p>
                        </div>
                      );
                    })()}

                    {addingTo === col.key ? (
                      <div className="bg-[var(--bg-primary)] border border-[var(--border-strong)] rounded-[var(--radius-md)] p-3 mt-1.5">
                        <input
                          value={newTitle}
                          onChange={e => setNewTitle(e.target.value)}
                          placeholder="Task title..."
                          className="w-full text-[var(--text-sm)] bg-transparent text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none mb-2"
                          autoFocus
                          onKeyDown={e => {
                            if (e.key === 'Escape') { setAddingTo(null); setNewTitle(''); setNewProject(''); setNewAssignee(''); setNewDescription(''); setNewPriority('medium'); }
                          }}
                        />
                        <select
                          value={newProject || (filterProject !== 'all' ? filterProject : (projects[0]?.id || ''))}
                          onChange={e => handleProjectChange(e.target.value)}
                          className="w-full text-[var(--text-xs)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] px-2 py-1.5 text-[var(--text-secondary)] outline-none mb-2"
                        >
                          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                        <select
                          value={newAssignee || teammates[0]?.name || ''}
                          onChange={e => setNewAssignee(e.target.value)}
                          className="w-full text-[var(--text-xs)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] px-2 py-1.5 text-[var(--text-secondary)] outline-none mb-2"
                        >
                          {agents.map(a => <option key={a} value={a}>{a}</option>)}
                        </select>
                        <textarea
                          value={newDescription}
                          onChange={e => setNewDescription(e.target.value)}
                          placeholder="Description (optional)"
                          rows={2}
                          className="w-full text-[var(--text-xs)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] px-2 py-1.5 text-[var(--text-secondary)] placeholder-[var(--text-muted)] outline-none resize-none mb-2"
                        />
                        <select
                          value={newPriority}
                          onChange={e => setNewPriority(e.target.value as 'high' | 'medium' | 'low')}
                          className="w-full text-[var(--text-xs)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] px-2 py-1.5 text-[var(--text-secondary)] outline-none mb-2.5"
                        >
                          <option value="high">🔴 High</option>
                          <option value="medium">🟡 Medium</option>
                          <option value="low">🟢 Low</option>
                        </select>
                        <div className="flex gap-2">
                          <button onClick={() => handleAdd(col.key)}
                            className="text-[var(--text-xs)] px-3 py-1.5 bg-[var(--accent-primary)] text-white rounded-[var(--radius-sm)] hover:bg-[var(--accent-hover)] transition-colors font-medium">
                            Add
                          </button>
                          <button onClick={() => { setAddingTo(null); setNewTitle(''); setNewProject(''); setNewAssignee(''); setNewDescription(''); setNewPriority('medium'); }}
                            className="text-[var(--text-xs)] px-3 py-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => openAddForm(col.key)}
                        className="w-full py-2 mt-1 text-[var(--text-xs)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] rounded-[var(--radius-md)] transition-colors flex items-center justify-center gap-1.5"
                      >
                        <Plus size={14} /> Add task
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

      </div>
    </div>
  );
}

export default function TasksPage() {
  return (
    <Suspense>
      <TasksPageInner />
    </Suspense>
  );
}
