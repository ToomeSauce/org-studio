'use client';

import { PageHeader } from '@/components/PageHeader';
import { useGateway, useGatewayQuery } from '@/lib/hooks';
import { getTasks, saveTasks, getProjects, addTask, updateTask, deleteTask, type Task, type Project } from '@/lib/store';
import { Plus, X, Circle, Bot, Activity, GripVertical } from 'lucide-react';
import { clsx } from 'clsx';
import { useState, useEffect, useMemo, useCallback } from 'react';

const COLUMNS: { key: Task['status']; label: string; color: string }[] = [
  { key: 'backlog', label: 'Backlog', color: 'bg-zinc-500' },
  { key: 'todo', label: 'To Do', color: 'bg-[var(--info)]' },
  { key: 'in-progress', label: 'In Progress', color: 'bg-[var(--warning)]' },
  { key: 'review', label: 'Review', color: 'bg-purple-500' },
  { key: 'done', label: 'Done', color: 'bg-[var(--success)]' },
];

function TaskCard({ task, projects, onMove, onDelete }: {
  task: Task; projects: Project[];
  onMove: (id: string, status: Task['status']) => void;
  onDelete: (id: string) => void;
}) {
  const proj = projects.find(p => p.id === task.projectId);
  const daysAgo = Math.floor((Date.now() - task.createdAt) / 86400000);

  return (
    <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-md)] p-3 hover:border-[var(--border-strong)] transition-all group cursor-default">
      {proj && (
        <span className="text-[9px] font-semibold uppercase tracking-[0.05em] text-[var(--accent-primary)] mb-1 block">
          {proj.name}
        </span>
      )}
      <p className="text-[13px] font-medium text-[var(--text-primary)] leading-snug mb-2">{task.title}</p>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-[10px] text-[var(--text-muted)]">
          <span className="flex items-center gap-1">
            <Circle size={4} className={clsx('fill-current',
              task.assignee === 'Henry' ? 'text-[var(--accent-primary)]' : 'text-[var(--info)]'
            )} />
            {task.assignee}
          </span>
          <span>{daysAgo === 0 ? 'today' : `${daysAgo}d ago`}</span>
        </div>
        <button onClick={() => onDelete(task.id)} className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[var(--bg-hover)] text-[var(--text-muted)] transition-all">
          <X size={12} />
        </button>
      </div>
    </div>
  );
}

function LiveActivityPanel() {
  const { data: sessions } = useGatewayQuery<any>('sessions.list', { limit: 10 }, 8000);
  const sessionList = sessions?.sessions || [];
  const active = Array.isArray(sessionList) ? sessionList.filter((s: any) => s.updatedAt && Date.now() - s.updatedAt < 300000) : [];

  return (
    <div className="w-[280px] shrink-0 border-l border-[var(--border-default)] bg-[var(--bg-secondary)] flex flex-col">
      <div className="px-3 py-2.5 border-b border-[var(--border-default)] flex items-center gap-2">
        <Activity size={13} className="text-[var(--accent-primary)]" />
        <span className="text-[12px] font-semibold text-[var(--text-primary)]">Live Activity</span>
        <div className="ml-auto w-1.5 h-1.5 rounded-full bg-[var(--success)] animate-pulse" />
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {active.length === 0 && (
          <p className="text-[11px] text-[var(--text-muted)] text-center py-4">No active sessions</p>
        )}
        {active.map((s: any, i: number) => {
          const name = s.displayName || s.label || s.key?.split(':').pop() || 'Session';
          const kind = s.kind || 'direct';
          const model = s.model?.split('/').pop() || '';
          return (
            <div key={s.key || i} className="px-2.5 py-2 rounded-[var(--radius-md)] bg-[var(--bg-primary)] border border-[var(--border-subtle)] hover:border-[var(--border-default)] transition-colors">
              <div className="flex items-center gap-1.5 mb-0.5">
                <Bot size={10} className="text-[var(--accent-primary)]" />
                <span className="text-[11px] font-medium text-[var(--text-primary)] truncate">{name}</span>
              </div>
              <div className="text-[10px] text-[var(--text-muted)] flex items-center gap-1.5">
                <span className={clsx(
                  'px-1.5 py-px rounded-full text-[9px] font-semibold',
                  kind === 'cron' ? 'bg-[var(--warning-subtle)] text-[var(--warning)]'
                    : kind === 'run' ? 'bg-[var(--info-subtle)] text-[var(--info)]'
                    : 'bg-[var(--accent-muted)] text-[var(--accent-primary)]'
                )}>{kind}</span>
                {model && <span className="truncate">{model}</span>}
              </div>
            </div>
          );
        })}
        {/* Also show recent non-active sessions */}
        {Array.isArray(sessionList) && sessionList.filter((s: any) => !active.includes(s)).slice(0, 5).map((s: any, i: number) => {
          const name = s.displayName || s.label || s.key?.split(':').pop() || 'Session';
          return (
            <div key={`idle-${i}`} className="px-2.5 py-1.5 rounded-[var(--radius-md)] opacity-50">
              <div className="flex items-center gap-1.5">
                <Circle size={4} className="text-zinc-600 fill-current" />
                <span className="text-[10px] text-[var(--text-muted)] truncate">{name}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [filterProject, setFilterProject] = useState('all');
  const [filterAgent, setFilterAgent] = useState('all');
  const [addingTo, setAddingTo] = useState<Task['status'] | null>(null);
  const [newTitle, setNewTitle] = useState('');

  useEffect(() => {
    setTasks(getTasks());
    setProjects(getProjects());
  }, []);

  const filteredTasks = useMemo(() => {
    return tasks.filter(t => {
      if (filterProject !== 'all' && t.projectId !== filterProject) return false;
      if (filterAgent !== 'all' && t.assignee !== filterAgent) return false;
      return true;
    });
  }, [tasks, filterProject, filterAgent]);

  const agents = useMemo(() => [...new Set(tasks.map(t => t.assignee).filter(Boolean))], [tasks]);

  // Stats
  const now = Date.now();
  const weekAgo = now - 7 * 86400000;
  const thisWeek = tasks.filter(t => t.createdAt >= weekAgo).length;
  const inProgress = tasks.filter(t => t.status === 'in-progress').length;
  const total = tasks.length;
  const done = tasks.filter(t => t.status === 'done').length;
  const completionRate = total > 0 ? Math.round((done / total) * 100) : 0;

  const handleMove = useCallback((id: string, status: Task['status']) => {
    updateTask(id, { status });
    setTasks(getTasks());
  }, []);

  const handleDelete = useCallback((id: string) => {
    deleteTask(id);
    setTasks(getTasks());
  }, []);

  const handleAdd = (status: Task['status']) => {
    if (!newTitle.trim()) return;
    addTask({
      title: newTitle.trim(),
      status,
      projectId: filterProject !== 'all' ? filterProject : 'proj-mc',
      assignee: status === 'backlog' ? 'Basil' : 'Henry',
    });
    setTasks(getTasks());
    setNewTitle('');
    setAddingTo(null);
  };

  return (
    <div className="space-y-4 -mx-6 -my-6">
      {/* Stats bar */}
      <div className="px-6 pt-6 pb-2">
        <PageHeader title="Tasks" description="Track work across all projects" />
        <div className="flex items-center gap-6 mt-4">
          {[
            { label: 'This Week', value: thisWeek, color: 'text-[var(--info)]' },
            { label: 'In Progress', value: inProgress, color: 'text-[var(--warning)]' },
            { label: 'Total', value: total, color: 'text-[var(--text-primary)]' },
            { label: 'Completion', value: `${completionRate}%`, color: 'text-[var(--success)]' },
          ].map(stat => (
            <div key={stat.label} className="flex items-baseline gap-2">
              <span className={clsx('text-xl font-bold tracking-tight', stat.color)}>{stat.value}</span>
              <span className="text-[11px] font-medium text-[var(--text-muted)] uppercase tracking-wide">{stat.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Filters bar */}
      <div className="px-6 flex items-center gap-3 pb-3 border-b border-[var(--border-default)]">
        <select
          value={filterProject}
          onChange={e => setFilterProject(e.target.value)}
          className="text-[12px] px-2.5 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-[var(--text-secondary)] outline-none focus:border-[var(--accent-primary)] transition-colors"
        >
          <option value="all">All Projects</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>

        <select
          value={filterAgent}
          onChange={e => setFilterAgent(e.target.value)}
          className="text-[12px] px-2.5 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-[var(--text-secondary)] outline-none focus:border-[var(--accent-primary)] transition-colors"
        >
          <option value="all">All Agents</option>
          {agents.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>

      {/* Kanban + Activity */}
      <div className="flex" style={{ height: 'calc(100vh - 280px)' }}>
        {/* Kanban */}
        <div className="flex-1 overflow-x-auto">
          <div className="flex gap-3 px-6 pb-4 min-w-max h-full">
            {COLUMNS.map(col => {
              const colTasks = filteredTasks.filter(t => t.status === col.key);
              return (
                <div key={col.key} className="w-[260px] shrink-0 flex flex-col"
                  onDragOver={e => e.preventDefault()}
                  onDrop={e => {
                    const id = e.dataTransfer.getData('taskId');
                    if (id) handleMove(id, col.key);
                  }}
                >
                  {/* Column header */}
                  <div className="flex items-center gap-2 px-2 pb-2.5 mb-1">
                    <div className={clsx('w-2 h-2 rounded-full', col.color)} />
                    <span className="text-[12px] font-semibold text-[var(--text-secondary)]">{col.label}</span>
                    <span className="text-[11px] text-[var(--text-muted)] ml-auto">{colTasks.length}</span>
                  </div>

                  {/* Cards */}
                  <div className="flex-1 space-y-2 overflow-y-auto pr-1">
                    {colTasks.map(task => (
                      <div key={task.id} draggable
                        onDragStart={e => e.dataTransfer.setData('taskId', task.id)}
                      >
                        <TaskCard task={task} projects={projects} onMove={handleMove} onDelete={handleDelete} />
                      </div>
                    ))}

                    {/* Add button / inline form */}
                    {addingTo === col.key ? (
                      <div className="bg-[var(--bg-primary)] border border-[var(--border-strong)] rounded-[var(--radius-md)] p-2.5">
                        <input
                          value={newTitle}
                          onChange={e => setNewTitle(e.target.value)}
                          placeholder="Task title..."
                          className="w-full text-[12px] bg-transparent text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none mb-2"
                          autoFocus
                          onKeyDown={e => {
                            if (e.key === 'Enter') handleAdd(col.key);
                            if (e.key === 'Escape') { setAddingTo(null); setNewTitle(''); }
                          }}
                        />
                        <div className="flex gap-1.5">
                          <button onClick={() => handleAdd(col.key)}
                            className="text-[11px] px-2 py-1 bg-[var(--accent-primary)] text-white rounded-[var(--radius-sm)] hover:bg-[var(--accent-hover)] transition-colors">
                            Add
                          </button>
                          <button onClick={() => { setAddingTo(null); setNewTitle(''); }}
                            className="text-[11px] px-2 py-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => setAddingTo(col.key)}
                        className="w-full py-1.5 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] rounded-[var(--radius-md)] transition-colors flex items-center justify-center gap-1"
                      >
                        <Plus size={12} /> Add task
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Live Activity */}
        <LiveActivityPanel />
      </div>
    </div>
  );
}
