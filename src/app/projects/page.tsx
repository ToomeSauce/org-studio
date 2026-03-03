'use client';

import { PageHeader } from '@/components/PageHeader';
import { Plus, GripVertical, MoreHorizontal, Circle } from 'lucide-react';
import { useState } from 'react';
import { clsx } from 'clsx';

// Persistent state will be file-backed later — starting with in-memory + localStorage

interface Task {
  id: string;
  title: string;
  description?: string;
  status: 'backlog' | 'todo' | 'in_progress' | 'done';
  priority?: 'urgent' | 'high' | 'medium' | 'low';
  labels?: string[];
  assignee?: string;
  createdAt: string;
}

const COLUMNS = [
  { id: 'backlog', label: 'Backlog', color: 'text-zinc-500' },
  { id: 'todo', label: 'To Do', color: 'text-blue-400' },
  { id: 'in_progress', label: 'In Progress', color: 'text-amber-400' },
  { id: 'done', label: 'Done', color: 'text-green-400' },
] as const;

const priorityConfig = {
  urgent: { label: '🔴', color: 'text-red-400' },
  high: { label: '🟠', color: 'text-orange-400' },
  medium: { label: '🟡', color: 'text-yellow-400' },
  low: { label: '🔵', color: 'text-blue-400' },
};

// Default tasks — will move to persistent storage
const DEFAULT_TASKS: Task[] = [
  {
    id: '1', title: 'Short-Form E2E testing on staging',
    description: 'Test Module 343 micro-checkpoints → progress bar → speed round',
    status: 'in_progress', priority: 'high', labels: ['catpilot'], assignee: 'henry',
    createdAt: new Date().toISOString(),
  },
  {
    id: '2', title: 'Fix PSTN audio path',
    description: 'Call connects but no voice response',
    status: 'backlog', priority: 'medium', labels: ['voice'], assignee: 'henry',
    createdAt: new Date().toISOString(),
  },
  {
    id: '3', title: 'Event Grid subscription for incoming calls',
    description: 'Basil needs to create in Azure Portal',
    status: 'backlog', priority: 'low', labels: ['voice', 'blocked'], assignee: 'basil',
    createdAt: new Date().toISOString(),
  },
  {
    id: '4', title: 'Set ADMIN_CONTENT_GEN_ENABLED on staging',
    description: 'Quick Create returns error without this env var',
    status: 'backlog', priority: 'medium', labels: ['catpilot', 'blocked'], assignee: 'basil',
    createdAt: new Date().toISOString(),
  },
  {
    id: '5', title: 'Regression test suite — 35/35 passing',
    description: 'Short-form Module 343 all checkpoints',
    status: 'done', priority: 'high', labels: ['catpilot'],
    createdAt: new Date().toISOString(),
  },
  {
    id: '6', title: 'Reset button fix — clear cat_completions',
    description: 'Progress stuck at 100% after reset',
    status: 'done', priority: 'urgent', labels: ['catpilot'],
    createdAt: new Date().toISOString(),
  },
];

function loadTasks(): Task[] {
  if (typeof window === 'undefined') return DEFAULT_TASKS;
  const saved = localStorage.getItem('mc_tasks');
  return saved ? JSON.parse(saved) : DEFAULT_TASKS;
}

function saveTasks(tasks: Task[]) {
  if (typeof window !== 'undefined') {
    localStorage.setItem('mc_tasks', JSON.stringify(tasks));
  }
}

function TaskCard({ task, onMove }: { task: Task; onMove: (id: string, status: Task['status']) => void }) {
  return (
    <div className="group bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-md p-3 hover:border-[var(--border-strong)] transition-colors cursor-default">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm text-[var(--text-primary)] leading-snug">{task.title}</p>
          {task.description && (
            <p className="text-xs text-[var(--text-tertiary)] mt-1 line-clamp-2">{task.description}</p>
          )}
        </div>
        {task.priority && (
          <span className="text-xs shrink-0">{priorityConfig[task.priority].label}</span>
        )}
      </div>

      {/* Labels + assignee */}
      <div className="flex items-center gap-2 mt-2">
        {task.labels?.map(label => (
          <span key={label} className="text-[10px] px-1.5 py-0.5 bg-[var(--bg-tertiary)] text-[var(--text-muted)] rounded">
            {label}
          </span>
        ))}
        {task.assignee && (
          <span className="ml-auto text-[10px] text-[var(--text-muted)]">
            {task.assignee}
          </span>
        )}
      </div>
    </div>
  );
}

function AddTaskInput({ status, onAdd }: { status: Task['status']; onAdd: (title: string, status: Task['status']) => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const [title, setTitle] = useState('');

  const handleSubmit = () => {
    if (title.trim()) {
      onAdd(title.trim(), status);
      setTitle('');
      setIsOpen(false);
    }
  };

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="flex items-center gap-1.5 w-full px-3 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] rounded-md transition-colors"
      >
        <Plus size={12} />
        Add task
      </button>
    );
  }

  return (
    <div className="p-2">
      <input
        type="text"
        value={title}
        onChange={e => setTitle(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') handleSubmit();
          if (e.key === 'Escape') { setIsOpen(false); setTitle(''); }
        }}
        placeholder="Task title..."
        autoFocus
        className="w-full px-2 py-1.5 text-sm bg-[var(--bg-primary)] border border-[var(--border-strong)] rounded text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)]"
      />
      <div className="flex gap-2 mt-2">
        <button
          onClick={handleSubmit}
          className="px-2 py-1 text-xs bg-[var(--accent-primary)] text-white rounded hover:bg-[var(--accent-hover)] transition-colors"
        >
          Add
        </button>
        <button
          onClick={() => { setIsOpen(false); setTitle(''); }}
          className="px-2 py-1 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function ProjectsPage() {
  const [tasks, setTasks] = useState<Task[]>(loadTasks);

  const updateTasks = (newTasks: Task[]) => {
    setTasks(newTasks);
    saveTasks(newTasks);
  };

  const handleAdd = (title: string, status: Task['status']) => {
    const newTask: Task = {
      id: Date.now().toString(),
      title,
      status,
      createdAt: new Date().toISOString(),
    };
    updateTasks([...tasks, newTask]);
  };

  const handleMove = (id: string, status: Task['status']) => {
    updateTasks(tasks.map(t => t.id === id ? { ...t, status } : t));
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Projects"
        description="Track tasks and deliverables"
        actions={
          <button
            onClick={() => handleAdd('New task', 'backlog')}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-white rounded-md transition-colors"
          >
            <Plus size={14} />
            New Task
          </button>
        }
      />

      {/* Kanban columns */}
      <div className="grid grid-cols-4 gap-4 min-h-[500px]">
        {COLUMNS.map(col => {
          const columnTasks = tasks.filter(t => t.status === col.id);
          return (
            <div key={col.id} className="space-y-2">
              {/* Column header */}
              <div className="flex items-center gap-2 px-1 pb-2">
                <Circle size={8} className={clsx('fill-current', col.color)} />
                <span className="text-xs font-medium text-[var(--text-secondary)] uppercase tracking-wide">
                  {col.label}
                </span>
                <span className="text-xs text-[var(--text-muted)]">{columnTasks.length}</span>
              </div>

              {/* Tasks */}
              <div className="space-y-2">
                {columnTasks.map(task => (
                  <TaskCard key={task.id} task={task} onMove={handleMove} />
                ))}
              </div>

              {/* Add task */}
              <AddTaskInput status={col.id} onAdd={handleAdd} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
