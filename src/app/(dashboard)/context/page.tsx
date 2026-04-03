'use client';

import { PageHeader } from '@/components/PageHeader';
import { TaskDetailPanel } from '@/components/TaskDetailPanel';
import { addTask, updateTask, deleteTask, addComment, type Task, type Project, type TaskComment, getTaskActivityStatus, getActivityStatusDisplay, searchTasks, getActiveTasks, extractMentions, unarchiveTask, permanentlyDeleteTask, getArchivedTasks } from '@/lib/store';
import { useWSData, useWSConnected } from '@/lib/ws';
import { Plus, X, Circle, Bot, Activity, Eye, Pencil, Info, Target, Shield, FileText, Link as LinkIcon, ChevronDown, ChevronRight, MessageSquare, Maximize2, Search, Archive, RotateCcw, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import Link from 'next/link';
import { useState, useEffect, useMemo, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { toast } from 'react-toastify';

const BASE_COLUMNS: { key: Task['status']; label: string; color: string }[] = [
  { key: 'planning', label: 'Planning', color: 'bg-indigo-500' },
  { key: 'backlog', label: 'Backlog', color: 'bg-zinc-500' },
  { key: 'in-progress', label: 'In Progress', color: 'bg-[var(--warning)]' },
  { key: 'review', label: 'Review', color: 'bg-purple-500' },
  { key: 'done', label: 'Done', color: 'bg-[var(--success)]' },
];

const QA_COLUMN = { key: 'qa' as Task['status'], label: 'QA', color: 'bg-teal-500' };

const COLUMN_TOOLTIPS: Record<Task['status'], string> = {
  'planning': 'Human-owned — scope and define acceptance criteria before moving to Backlog.',
  'backlog': 'Agent intake queue — ready to be picked up. Top = highest priority.',
  'in-progress': 'Actively being worked by agents or humans.',
  'qa': 'QA validation — end-user testing before human review.',
  'review': 'Waiting for human review and sign-off.',
  'done': 'Completed and verified.',
};

const COLUMN_EMPTY: Record<Task['status'], { emoji: string; heading: string; text: string }> = {
  'planning': { emoji: '🔒', heading: 'Human territory', text: 'Scope and spec tasks here before they\'re ready. Move to Backlog when an agent can pick them up.' },
  'backlog': { emoji: '📥', heading: 'Agent intake', text: 'Ready tasks land here. Agents pull from the top — highest priority first.' },
  'in-progress': { emoji: '⚡', heading: 'Where the work happens', text: 'Agents pull from Backlog and work here. Tasks show up automatically.' },
  'qa': { emoji: '🧪', heading: 'QA queue', text: 'Tasks requiring end-user testing land here. Test assignee validates against the test plan.' },
  'review': { emoji: '👀', heading: 'Awaiting sign-off', text: 'Agents park finished work here for human review.' },
  'done': { emoji: '✅', heading: 'Shipped', text: 'Completed and verified. Nice work, team.' },
};

import { Teammate, resolveColor, buildAgentMap, buildNameColorMap } from '@/lib/teammates';

// --- Seed quality helpers ---

function computeSeedScore(fields: { title?: string; outcome?: string; doneWhen?: string; constraints?: string; context?: string }) {
  let score = 0;
  if (fields.title?.trim()) score += 35;
  if (fields.doneWhen?.trim()) score += 35;
  if (fields.constraints?.trim()) score += 15;
  if (fields.context?.trim()) score += 15;
  return score;
}


function composeSeedDescription(fields: { outcome?: string; doneWhen?: string; constraints?: string; context?: string; description?: string }) {
  const sections: string[] = [];
  if (fields.outcome?.trim()) sections.push(`## Outcome\n${fields.outcome.trim()}`);
  if (fields.doneWhen?.trim()) sections.push(`## Done When\n${fields.doneWhen.trim()}`);
  if (fields.constraints?.trim()) sections.push(`## Constraints\n${fields.constraints.trim()}`);
  if (fields.context?.trim()) sections.push(`## Context\n${fields.context.trim()}`);
  if (sections.length === 0) return fields.description?.trim() || undefined;
  const prefix = fields.description?.trim() ? fields.description.trim() + '\n\n' : '';
  return prefix + sections.join('\n\n');
}

function hasSeedFields(task: Task) {
  return !!(task.doneWhen?.trim() || task.constraints?.trim() || task.context?.trim());
}


// --- TaskCard (display only — no inline editing) ---

function TaskCard({ task, projects, onDelete, onSelect, agents, nameColors }: {
  task: Task; projects: Project[];
  onDelete: (id: string) => void;
  onSelect: (id: string) => void;
  agents: string[];
  nameColors: Record<string, string>;
}) {
  const proj = projects.find(p => p.id === task.projectId);
  const daysAgo = Math.floor((Date.now() - task.createdAt) / 86400000);
  const commentCount = task.comments?.length || 0;

  return (
    <div
      className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-md)] p-4 hover:border-[var(--border-strong)] transition-all group cursor-pointer hover:shadow-[0_2px_12px_rgba(0,0,0,0.3)]"
      onClick={() => onSelect(task.id)}
    >
      {proj && (
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--accent-primary)]">
            {proj.name}
          </span>
          {task.version && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
              v{task.version}
            </span>
          )}
        </div>
      )}
      <div className="flex items-start gap-1.5 mb-2">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            {task.ticketNumber && (
              <span className="text-[10px] font-semibold bg-[var(--accent-primary)]/15 text-[var(--accent-primary)] px-1.5 py-0.5 rounded-sm">
                #{task.ticketNumber}
              </span>
            )}
            {hasSeedFields(task) && (
              <span className="text-xs" title="Has acceptance criteria">✓</span>
            )}
          </div>
          <p className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)] leading-snug">{task.title}</p>
        </div>
      </div>
      {/* Review notes — shown on review/done cards when agent left notes */}
      {task.reviewNotes?.trim() && (task.status === 'review' || task.status === 'done') && (
        <div className="mb-2 px-2.5 py-2 bg-[var(--bg-secondary)] border-l-2 border-[var(--accent-primary)] rounded-r-[var(--radius-sm)]">
          <div className="flex items-center gap-1.5 mb-0.5">
            <MessageSquare size={11} className="text-[var(--accent-primary)]" />
            <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--accent-primary)]">
              {task.status === 'review' ? 'Review Notes' : 'Completion Notes'}
            </span>
          </div>
          <p className="text-[var(--text-xs)] text-[var(--text-secondary)] leading-relaxed whitespace-pre-wrap line-clamp-2">{task.reviewNotes}</p>
        </div>
      )}
      <div className="flex items-center justify-between mt-1">
        <div className="flex items-center gap-2.5 text-[var(--text-xs)] text-[var(--text-muted)]">
          <span className={clsx('font-medium', nameColors[task.assignee] || 'text-[var(--text-muted)]')}>
            {task.assignee}
          </span>
          <span>{daysAgo === 0 ? 'today' : `${daysAgo}d ago`}</span>
          {commentCount > 0 && (
            <span className="flex items-center gap-0.5 text-[var(--text-muted)]" title={`${commentCount} comment${commentCount !== 1 ? 's' : ''}`}>
              💬 {commentCount}
            </span>
          )}
          {['in-progress', 'qa', 'review'].includes(task.status) && (() => {
            const activityStatus = getTaskActivityStatus(task);
            const display = getActivityStatusDisplay(activityStatus);
            return (
              <span className={clsx('flex items-center gap-0.5', display.color)} title={`Status: ${display.label}`}>
                {display.icon}
              </span>
            );
          })()}
        </div>
        <div className="flex items-center gap-0.5">
          <button
            onClick={e => { e.stopPropagation(); onSelect(task.id); }}
            className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-[var(--bg-hover)] text-[var(--text-muted)] transition-all"
            title="Edit task"
          >
            <Pencil size={14} />
          </button>
          <button
            onClick={e => { e.stopPropagation(); onDelete(task.id); }}
            className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-[var(--bg-hover)] text-[var(--text-muted)] transition-all"
            title="Archive task"
          >
            <Archive size={14} />
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

  let context = '';
  const display = s.displayName || '';
  const keyRest = parts.slice(2).join(':');

  if (display.startsWith('Cron:') || kind === 'cron') {
    context = display.replace(/^Cron:\s*/, '') || 'running cron';
  } else if (keyRest.includes('group:') || keyRest.includes('slash:') || kind === 'group') {
    const groupPart = display.replace(/^(telegram|slack):(g-)?/, '');
    context = `group: ${groupPart || keyRest}`;
  } else if (keyRest.includes('subagent:') || kind === 'run') {
    context = 'running sub-agent';
  } else if (keyRest.includes('thread:')) {
    context = `thread on ${channel || 'slack'}`;
  } else {
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

  const recentFeed = allParsed
    .filter(s => s.isRecent && s.kind !== 'direct')
    .slice(0, 8);

  return (
    <div className="w-[280px] shrink-0 border-l border-[var(--border-default)] bg-[var(--bg-secondary)] hidden lg:flex flex-col">
      <div className="px-4 py-3 border-b border-[var(--border-default)] flex items-center gap-2">
        <Activity size={15} className="text-[var(--accent-primary)]" />
        <span className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">Live Activity</span>
        <div className="ml-auto w-2 h-2 rounded-full bg-[var(--success)] animate-pulse" />
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
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

  useEffect(() => {
    if (storeData?.tasks) setLocalTasks(storeData.tasks);
  }, [storeData]);
  const searchParams = useSearchParams();
  const urlProject = searchParams.get('project');
  const [filterProject, setFilterProject] = useState('all');

  useEffect(() => {
    if (urlProject) setFilterProject(urlProject);
  }, [urlProject]);
  const [filterAgent, setFilterAgent] = useState('all');
  const [filterVersion, setFilterVersion] = useState('all');
  const [addingTo, setAddingTo] = useState<Task['status'] | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [newProject, setNewProject] = useState('');
  const [newAssignee, setNewAssignee] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newPriority, setNewPriority] = useState<'high' | 'medium' | 'low'>('medium');
  const [newDoneWhen, setNewDoneWhen] = useState('');
  const [newConstraints, setNewConstraints] = useState('');
  const [newContext, setNewContext] = useState('');
  const [newTestType, setNewTestType] = useState<'self' | 'qa'>('self');
  const [newTestAssignee, setNewTestAssignee] = useState('');
  const [criteriaOpen, setCriteriaOpen] = useState(false);
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [dragSourceCol, setDragSourceCol] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');


  const filteredTasks = useMemo(() => {
    let result = tasks.filter(t => {
      // Exclude archived tasks from board
      if (t.isArchived) return false;
      if (filterProject !== 'all' && t.projectId !== filterProject) return false;
      if (filterAgent !== 'all' && t.assignee !== filterAgent) return false;
      if (filterVersion !== 'all' && t.version !== filterVersion) return false;
      return true;
    });

    // Apply search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(t => {
        if (t.ticketNumber && t.ticketNumber.toString().includes(q)) return true;
        if (t.title.toLowerCase().includes(q)) return true;
        if (t.description?.toLowerCase().includes(q)) return true;
        if (t.assignee.toLowerCase().includes(q)) return true;
        return false;
      });
    }

    return result;
  }, [tasks, filterProject, filterAgent, filterVersion, searchQuery]);

  const selectedTask = useMemo(() => {
    if (!selectedTaskId) return null;
    return tasks.find(t => t.id === selectedTaskId) || null;
  }, [selectedTaskId, tasks]);

  const teammates: Teammate[] = storeData?.settings?.teammates || [];
  const agentMap = useMemo(() => buildAgentMap(teammates), [teammates]);
  const nameColors = useMemo(() => buildNameColorMap(teammates), [teammates]);
  const knownNames = useMemo(() => teammates.map(t => t.name), [teammates]);
  const agents = useMemo(() => {
    const fromTasks = tasks.map(t => t.assignee).filter(Boolean);
    return [...new Set([...knownNames, ...fromTasks])];
  }, [tasks, knownNames]);

  // Derive unique versions from tasks
  const uniqueVersions = useMemo(() => {
    const versions = tasks
      .map(t => t.version)
      .filter(Boolean) as string[];
    return [...new Set(versions)].sort();
  }, [tasks]);

  // Derive columns based on qaLead setting
  const qaLead = storeData?.settings?.qaLead;
  const columns = useMemo(() => {
    if (qaLead) {
      return [...BASE_COLUMNS.slice(0, 3), QA_COLUMN, ...BASE_COLUMNS.slice(3)];
    }
    return BASE_COLUMNS;
  }, [qaLead]);

  const now = Date.now();
  const weekAgo = now - 7 * 86400000;
  const thisWeek = filteredTasks.filter(t => t.createdAt >= weekAgo).length;
  const inProgress = filteredTasks.filter(t => t.status === 'in-progress').length;
  const inQA = filteredTasks.filter(t => t.status === 'qa').length;
  const total = filteredTasks.length;
  const done = filteredTasks.filter(t => t.status === 'done').length;
  const completionRate = total > 0 ? Math.round((done / total) * 100) : 0;

  const handleMove = useCallback(async (id: string, status: Task['status']) => {
    setLocalTasks(prev => (prev || []).map(t => t.id === id ? { ...t, status } : t));
    await updateTask(id, { status });
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    if (selectedTaskId === id) setSelectedTaskId(null);
    setLocalTasks(prev => (prev || []).filter(t => t.id !== id));
    await deleteTask(id);
    toast.success('Task archived');
  }, [selectedTaskId]);

  const handleAssign = useCallback(async (id: string, assignee: string) => {
    setLocalTasks(prev => (prev || []).map(t => t.id === id ? { ...t, assignee } : t));
    await updateTask(id, { assignee });
  }, []);

  const handleEdit = useCallback((id: string, updates: Partial<Task>) => {
    setLocalTasks(prev => (prev || []).map(t => t.id === id ? { ...t, ...updates } : t));
  }, []);

  const handlePanelUpdate = useCallback(async (id: string, updates: Partial<Task>) => {
    setLocalTasks(prev => (prev || []).map(t => t.id === id ? { ...t, ...updates } : t));
    await updateTask(id, updates);
  }, []);

  const handlePanelDelete = useCallback(async (id: string) => {
    setSelectedTaskId(null);
    setLocalTasks(prev => (prev || []).filter(t => t.id !== id));
    await deleteTask(id);
  }, []);

  const handlePanelAddComment = useCallback(async (taskId: string, comment: Omit<TaskComment, 'id' | 'createdAt'>): Promise<TaskComment> => {
    const result = await addComment(taskId, comment);
    // Update local state with the new comment
    setLocalTasks(prev => (prev || []).map(t =>
      t.id === taskId ? { ...t, comments: [...(t.comments || []), result] } : t
    ));
    return result;
  }, []);

  const handleProjectChange = useCallback((projectId: string) => {
    setNewProject(projectId);
    const proj = projects.find(p => p.id === projectId);
    if (proj?.owner) {
      setNewAssignee(proj.owner);
    }
  }, [projects]);

  const resetAddForm = useCallback(() => {
    setNewTitle('');
    setNewProject('');
    setNewAssignee('');
    setNewDescription('');
    setNewPriority('medium');
    setNewDoneWhen('');
    setNewConstraints('');
    setNewContext('');
    setNewTestType('self');
    setNewTestAssignee('');
    setCriteriaOpen(false);
    setAddingTo(null);
  }, []);

  const openAddForm = useCallback((status: Task['status']) => {
    const defaultProjectId = filterProject !== 'all' ? filterProject : (projects[0]?.id || '');
    const defaultProject = projects.find(p => p.id === defaultProjectId);
    setNewProject(defaultProjectId);
    setNewAssignee(defaultProject?.owner || teammates[0]?.name || '');
    setCriteriaOpen(status === 'planning');
    setAddingTo(status);
  }, [filterProject, projects, teammates]);

  const handleAdd = async (status: Task['status']) => {
    if (!newTitle.trim()) return;
    const seedFields = {
      doneWhen: newDoneWhen.trim() || undefined,
      constraints: newConstraints.trim() || undefined,
      context: newContext.trim() || undefined,
    };
    const desc = composeSeedDescription({ ...seedFields, description: newDescription.trim() });
    await addTask({
      title: newTitle.trim(),
      status,
      projectId: newProject || (filterProject !== 'all' ? filterProject : (projects[0]?.id || '')),
      assignee: newAssignee || teammates[0]?.name || '',
      description: desc,
      priority: newPriority,
      testType: newTestType,
      testAssignee: newTestType === 'qa' ? (newTestAssignee || undefined) : undefined,
      ...seedFields,
    });
    resetAddForm();
  };

  if (loading) {
    return (
      <div className="space-y-5">
        <PageHeader title="Context Board" description="Loading..." />
      </div>
    );
  }

  return (
    <div className="space-y-5 -mx-4 -my-4 sm:-mx-6 sm:-my-6">
      <div className="px-4 md:px-6 pt-4 sm:pt-6 pb-2">
        <PageHeader title="Context Board" description="Share context. Tasks, wins, blockers, learnings. Transparency FTW." />
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 sm:gap-x-8 mt-5">
          {[
            { label: 'This Week', value: thisWeek, color: 'text-[var(--info)]' },
            { label: 'In Progress', value: inProgress, color: 'text-[var(--warning)]' },
            ...(qaLead ? [{ label: 'In QA', value: inQA, color: 'text-teal-400' }] : []),
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
          <div className="mx-3 sm:mx-6 px-4 py-2.5 bg-[var(--accent-primary)]/5 border border-[var(--accent-primary)]/20 rounded-[var(--radius-md)] flex items-center justify-between gap-2 flex-wrap">
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

      <div className="px-4 md:px-6 flex flex-wrap items-center gap-3 pb-4 border-b border-[var(--border-default)]">
        {/* Project Filter */}
        <select
          value={filterProject}
          onChange={e => setFilterProject(e.target.value)}
          className="text-[var(--text-sm)] px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-[var(--text-secondary)] outline-none focus:border-[var(--accent-primary)] transition-colors"
        >
          <option value="all">All Projects</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          <option disabled>──────────</option>
          <option value="archived">📦 Archived</option>
        </select>

        {/* Agent Filter */}
        <select
          value={filterAgent}
          onChange={e => setFilterAgent(e.target.value)}
          className="text-[var(--text-sm)] px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-[var(--text-secondary)] outline-none focus:border-[var(--accent-primary)] transition-colors"
        >
          <option value="all">All Agents</option>
          {agents.map(a => <option key={a} value={a}>{a}</option>)}
        </select>

        {/* Version Filter */}
        {uniqueVersions.length > 0 && (
          <select
            value={filterVersion}
            onChange={e => setFilterVersion(e.target.value)}
            className="text-[var(--text-sm)] px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-[var(--text-secondary)] outline-none focus:border-[var(--accent-primary)] transition-colors"
          >
            <option value="all">All Versions</option>
            {uniqueVersions.map(v => <option key={v} value={v}>v{v}</option>)}
          </select>
        )}

        {/* Search Box (moved to right) */}
        <div className="flex items-center gap-2 px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] focus-within:border-[var(--accent-primary)] transition-colors w-full sm:flex-1 sm:max-w-sm sm:ml-auto">
          <Search size={16} className="text-[var(--text-muted)]" />
          <input
            type="text"
            placeholder="Search by title, #ticket, or assignee..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="flex-1 bg-transparent text-[var(--text-sm)] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

{filterProject === 'archived' ? (
        // Archived tasks view
        (() => {
          const archivedTasks = getArchivedTasks().filter(t => {
            if (filterAgent !== 'all' && t.assignee !== filterAgent) return false;
            if (searchQuery && !t.title.toLowerCase().includes(searchQuery.toLowerCase())) return false;
            return true;
          });

          const archivedByStatus = new Map<Task['status'], Task[]>();
          columns.forEach(col => archivedByStatus.set(col.key, []));
          archivedTasks.forEach(t => {
            const status = t.status as Task['status'];
            if (!archivedByStatus.has(status)) archivedByStatus.set(status, []);
            archivedByStatus.get(status)!.push(t);
          });

          return (
            <div style={{ height: 'calc(100vh - 300px)' }}>
              <div className="px-6 py-4 mb-4 bg-[var(--bg-secondary)] rounded-[var(--radius-md)] border border-[var(--border-default)]">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-lg">📦</span>
                  <h2 className="text-[var(--text-md)] font-semibold text-[var(--text-primary)]">Archived Tasks</h2>
                  <span className="text-[var(--text-xs)] text-[var(--text-muted)] font-medium">({archivedTasks.length})</span>
                </div>
                <p className="text-[var(--text-xs)] text-[var(--text-muted)]">Restore tasks to return them to the board</p>
              </div>

              <div className="overflow-x-auto h-full pb-20">
                <div className="flex gap-2 sm:gap-4 px-3 sm:px-6 pb-4 min-w-max h-full">
                  {columns.map(col => {
                    const colTasks = archivedByStatus.get(col.key) || [];
                    return (
                      <div key={col.key} className="w-[280px] sm:w-[320px] shrink-0 flex flex-col">
                        <div className="bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-t-[var(--radius-md)] px-3 py-2 flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className={clsx(col.color, 'w-2 h-2 rounded-full')} />
                            <h3 className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">{col.label}</h3>
                            <span className="text-[var(--text-xs)] text-[var(--text-muted)] font-medium">({colTasks.length})</span>
                          </div>
                        </div>

                        <div className="flex-1 overflow-y-auto bg-[var(--bg-primary)] border border-t-0 border-[var(--border-subtle)] rounded-b-[var(--radius-md)] px-2 py-2 space-y-2">
                          {colTasks.length > 0 ? (
                            colTasks.map(task => {
                              const proj = projects.find(p => p.id === task.projectId);
                              const daysAgo = Math.floor((Date.now() - task.createdAt) / 86400000);
                              return (
                                <div
                                  key={task.id}
                                  className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-md)] p-3 hover:border-[var(--border-strong)] transition-all group cursor-pointer hover:shadow-[0_2px_12px_rgba(0,0,0,0.3)]"
                                >
                                  {proj && (
                                    <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--accent-primary)] mb-1 block">
                                      {proj.name}
                                    </span>
                                  )}
                                  {task.ticketNumber && (
                                    <span className="text-[10px] font-semibold bg-[var(--accent-primary)]/15 text-[var(--accent-primary)] px-1.5 py-0.5 rounded-sm mb-1 block">
                                      #{task.ticketNumber}
                                    </span>
                                  )}
                                  <p className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)] leading-snug mb-2">{task.title}</p>
                                  <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-1.5 text-[var(--text-xs)] text-[var(--text-muted)]">
                                      <span className="font-medium">{task.assignee}</span>
                                      <span>{daysAgo === 0 ? 'today' : `${daysAgo}d ago`}</span>
                                    </div>
                                    <div className="flex items-center gap-0.5">
                                      <button
                                        onClick={async (e) => {
                                          e.stopPropagation();
                                          try {
                                            await unarchiveTask(task.id);
                                            toast.success('Task restored');
                                          } catch (e) {
                                            toast.error('Failed to restore task');
                                          }
                                        }}
                                        className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-[var(--bg-hover)] text-[var(--text-muted)] transition-all"
                                        title="Restore task"
                                      >
                                        <RotateCcw size={14} />
                                      </button>
                                      <button
                                        onClick={async (e) => {
                                          e.stopPropagation();
                                          if (confirm('Permanently delete this task? This cannot be undone.')) {
                                            try {
                                              await permanentlyDeleteTask(task.id);
                                              toast.success('Task deleted permanently');
                                            } catch (e) {
                                              toast.error('Failed to delete task');
                                            }
                                          }
                                        }}
                                        className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-[var(--bg-hover)] text-[var(--text-muted)] transition-all"
                                        title="Delete permanently"
                                      >
                                        <Trash2 size={14} />
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              );
                            })
                          ) : (
                            <div className="p-4 text-center text-[var(--text-xs)] text-[var(--text-muted)]">
                              {COLUMN_EMPTY[col.key].emoji} No archived tasks
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })()
      ) : (
        // Regular board view
      <div style={{ height: 'calc(100vh - 300px)' }}>
        <div className="overflow-x-auto h-full">
          <div className="flex gap-2 sm:gap-4 px-3 sm:px-6 pb-4 min-w-max h-full">
            {columns.map(col => {
              const colTasks = filteredTasks
                .filter(t => t.status === col.key)
                .sort((a, b) => {
                  return (a.sortOrder ?? a.createdAt) - (b.sortOrder ?? b.createdAt);
                });
              return (
                <div key={col.key} className="w-[280px] sm:w-[320px] shrink-0 flex flex-col"
                  onDragOver={e => {
                    e.preventDefault();
                    if (dragOverCol !== col.key) setDragOverCol(col.key);
                  }}
                  onDragLeave={e => {
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

                    // Readiness nudge: Planning → Backlog with low seed score
                    if (sourceCol === 'planning' && col.key === 'backlog') {
                      const task = tasks.find(t => t.id === id);
                      if (task) {
                        const score = computeSeedScore({
                          title: task.title,
                          doneWhen: task.doneWhen,
                          constraints: task.constraints,
                          context: task.context,
                        });
                        if (score < 50) {
                          toast.warn(
                            `⚠️ This task is missing ${!task.doneWhen?.trim() ? 'acceptance criteria' : 'key details'}. Agents may not know when they're done.`,
                            { autoClose: 5000 }
                          );
                        }
                      }
                    }

                    if (sourceCol === col.key) {
                      const currentIdx = colTasks.findIndex(t => t.id === id);
                      if (currentIdx === -1 || currentIdx === insertIdx || currentIdx === insertIdx - 1) return;

                      const reordered = [...colTasks];
                      const [moved] = reordered.splice(currentIdx, 1);
                      const targetIdx = insertIdx > currentIdx ? insertIdx - 1 : insertIdx;
                      reordered.splice(targetIdx, 0, moved);

                      reordered.forEach((t, i) => {
                        const newOrder = (i + 1) * 1000;
                        if (t.sortOrder !== newOrder) {
                          setLocalTasks(prev => (prev || []).map(lt => lt.id === t.id ? { ...lt, sortOrder: newOrder } : lt));
                          updateTask(t.id, { sortOrder: newOrder });
                        }
                      });
                    } else {
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
                          <TaskCard
                            task={task}
                            projects={projects}
                            onDelete={handleDelete}
                            onSelect={setSelectedTaskId}
                            agents={agents}
                            nameColors={nameColors}
                          />
                        </div>
                      </div>
                    ))}
                    {dragOverCol === col.key && dragOverIndex === colTasks.length && (
                      <div className={clsx('h-0.5 rounded-full mx-1 my-1', col.color)} />
                    )}

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
                          placeholder="What needs to happen?"
                          className="w-full text-[var(--text-sm)] bg-transparent text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none mb-2"
                          autoFocus
                          onKeyDown={e => {
                            if (e.key === 'Escape') resetAddForm();
                          }}
                        />

                        <textarea
                          value={newDescription}
                          onChange={e => setNewDescription(e.target.value)}
                          placeholder="Add details..."
                          rows={2}
                          className="w-full text-[var(--text-xs)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] px-2 py-1.5 text-[var(--text-secondary)] placeholder-[var(--text-muted)] outline-none resize-none mb-2"
                        />

                        <div className="grid grid-cols-3 gap-2 mb-2">
                          <select
                            value={newProject || (filterProject !== 'all' ? filterProject : (projects[0]?.id || ''))}
                            onChange={e => handleProjectChange(e.target.value)}
                            className="w-full text-[var(--text-xs)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] px-2 py-1.5 text-[var(--text-secondary)] outline-none"
                          >
                            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                          <select
                            value={newAssignee || teammates[0]?.name || ''}
                            onChange={e => setNewAssignee(e.target.value)}
                            className="w-full text-[var(--text-xs)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] px-2 py-1.5 text-[var(--text-secondary)] outline-none"
                          >
                            {agents.map(a => <option key={a} value={a}>{a}</option>)}
                          </select>
                          <select
                            value={newPriority}
                            onChange={e => setNewPriority(e.target.value as 'high' | 'medium' | 'low')}
                            className="w-full text-[var(--text-xs)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] px-2 py-1.5 text-[var(--text-secondary)] outline-none"
                          >
                            <option value="high">🔴 High</option>
                            <option value="medium">🟡 Medium</option>
                            <option value="low">🟢 Low</option>
                          </select>
                        </div>

                        {/* Test type options — only show when QA lead is set */}
                        {qaLead && (
                        <div className="flex items-center gap-3 mb-2">
                          <label className="text-[var(--text-xs)] text-[var(--text-muted)]">Test Type</label>
                          <select
                            value={newTestType}
                            onChange={e => setNewTestType(e.target.value as 'self' | 'qa')}
                            className="text-[var(--text-xs)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] px-2 py-1 text-[var(--text-secondary)] outline-none"
                          >
                            <option value="self">Self Test</option>
                            <option value="qa">QA Test</option>
                          </select>
                          {newTestType === 'qa' && (
                            <select
                              value={newTestAssignee}
                              onChange={e => setNewTestAssignee(e.target.value)}
                              className="text-[var(--text-xs)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] px-2 py-1 text-[var(--text-secondary)] outline-none"
                            >
                              <option value="">Auto (default QA)</option>
                              {agents.map(a => <option key={a} value={a}>{a}</option>)}
                            </select>
                          )}
                        </div>
                        )}

                        <button
                          type="button"
                          onClick={() => setCriteriaOpen(!criteriaOpen)}
                          className="flex items-center gap-1.5 text-[var(--text-xs)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors mb-2 w-full"
                        >
                          {criteriaOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          <Target size={12} />
                          <span>Acceptance Criteria</span>
                        </button>

                        {criteriaOpen && (
                          <div className="space-y-2 mb-2">
                            <div>
                              <label className="text-[var(--text-xs)] font-semibold text-[var(--text-muted)] mb-1 block">Acceptance Criteria</label>
                              <textarea
                                value={newDoneWhen}
                                onChange={e => setNewDoneWhen(e.target.value)}
                                placeholder="List the specific conditions that must be true when complete."
                                rows={2}
                                className="w-full text-[var(--text-xs)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] px-2 py-1.5 text-[var(--text-secondary)] placeholder-[var(--text-muted)] outline-none resize-none"
                              />
                            </div>
                            <div>
                              <label className="text-[var(--text-xs)] font-semibold text-[var(--text-muted)] mb-1 block">Boundaries</label>
                              <textarea
                                value={newConstraints}
                                onChange={e => setNewConstraints(e.target.value)}
                                placeholder="What's off-limits or out of scope?"
                                rows={2}
                                className="w-full text-[var(--text-xs)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] px-2 py-1.5 text-[var(--text-secondary)] placeholder-[var(--text-muted)] outline-none resize-none"
                              />
                            </div>
                            <div>
                              <label className="text-[var(--text-xs)] font-semibold text-[var(--text-muted)] mb-1 block">References</label>
                              <textarea
                                value={newContext}
                                onChange={e => setNewContext(e.target.value)}
                                placeholder="Links, files, or background info."
                                rows={2}
                                className="w-full text-[var(--text-xs)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] px-2 py-1.5 text-[var(--text-secondary)] placeholder-[var(--text-muted)] outline-none resize-none"
                              />
                            </div>
                          </div>
                        )}

                        <div className="flex gap-2">
                          <button onClick={() => handleAdd(col.key)}
                            className="text-[var(--text-xs)] px-3 py-1.5 bg-[var(--accent-primary)] text-white rounded-[var(--radius-sm)] hover:bg-[var(--accent-hover)] transition-colors font-medium">
                            Add
                          </button>
                          <button onClick={resetAddForm}
                            className="text-[var(--text-xs)] px-3 py-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => openAddForm(col.key)}
                        className="w-full py-2 text-[var(--text-xs)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] rounded-[var(--radius-md)] transition-colors flex items-center justify-center gap-1.5 mt-1"
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
      )}

      {/* Task Detail Panel */}
      {selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          projects={projects}
          agents={agents}
          nameColors={nameColors}
          qaLead={qaLead || null}
          onUpdate={handlePanelUpdate}
          onDelete={handlePanelDelete}
          onAddComment={handlePanelAddComment}
          onClose={() => setSelectedTaskId(null)}
        />
      )}
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
