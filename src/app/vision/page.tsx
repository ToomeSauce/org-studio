'use client';

import { PageHeader } from '@/components/PageHeader';
import { type Project, type Task, updateProject, addProject } from '@/lib/store';
import { useWSData } from '@/lib/ws';
import { useMemo, useState, useCallback, useRef } from 'react';
import { Lightbulb, Rocket, Archive, Plus, X, Check, ArrowRight, GripVertical, Pencil } from 'lucide-react';
import { clsx } from 'clsx';
import Link from 'next/link';
import { Teammate, buildNameColorMap } from '@/lib/teammates';

// --- Column / phase mapping ---

type ColumnId = 'ideation' | 'active' | 'archived';

const COLUMN_PHASES: Record<ColumnId, Project['phase']> = {
  ideation: 'inspiration',
  active: 'active',
  archived: 'complete',
};

function phaseToColumn(phase: Project['phase']): ColumnId {
  if (phase === 'inspiration') return 'ideation';
  if (phase === 'active' || phase === 'planning') return 'active';
  return 'archived'; // complete, paused
}

const COLUMNS: { id: ColumnId; label: string; icon: typeof Lightbulb; tagline: string; emoji: string }[] = [
  { id: 'archived', label: 'Archived', icon: Archive, tagline: 'Shelved & completed', emoji: '📦' },
  { id: 'ideation', label: 'Ideation', icon: Lightbulb, tagline: 'All ideas start here', emoji: '💡' },
  { id: 'active', label: 'Active', icon: Rocket, tagline: 'In progress', emoji: '🚀' },
];

const priorityConfig: Record<string, { label: string; color: string }> = {
  high: { label: 'High', color: 'text-[var(--error)]' },
  medium: { label: 'Medium', color: 'text-[var(--warning)]' },
  low: { label: 'Low', color: 'text-[var(--text-muted)]' },
};

const phaseBadgeConfig: Record<string, { label: string; cls: string }> = {
  active: { label: 'Active', cls: 'text-[var(--success)] bg-[var(--success-subtle)]' },
  planning: { label: 'Planning', cls: 'text-[var(--info)] bg-[var(--info-subtle)]' },
  inspiration: { label: 'Idea', cls: 'text-amber-400 bg-amber-400/10' },
  paused: { label: 'Paused', cls: 'text-[var(--warning)] bg-[var(--warning-subtle)]' },
  complete: { label: 'Complete', cls: 'text-[var(--text-muted)] bg-[var(--bg-tertiary)]' },
};

// --- Toast ---

function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  // auto-dismiss after 4s
  const ref = useRef<HTMLDivElement>(null);
  useState(() => { setTimeout(onDone, 4000); });
  return (
    <div ref={ref} className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-rise">
      <div className="px-5 py-3 rounded-[var(--radius-lg)] bg-[var(--card)] border border-[var(--success)]/40 shadow-lg text-[var(--text-sm)] text-[var(--text-primary)] flex items-center gap-2">
        <Rocket size={16} className="text-[var(--success)]" />
        {message}
      </div>
    </div>
  );
}

// --- Kanban Card ---

function KanbanCard({
  project,
  tasks,
  column,
  nameColors,
  knownNames,
  onDragStart,
}: {
  project: Project;
  tasks: Task[];
  column: ColumnId;
  nameColors: Record<string, string>;
  knownNames: string[];
  onDragStart: (e: React.DragEvent, projectId: string) => void;
}) {
  const projectTasks = tasks.filter(t => t.projectId === project.id);
  const doneTasks = projectTasks.filter(t => t.status === 'done').length;
  const completion = projectTasks.length > 0 ? Math.round((doneTasks / projectTasks.length) * 100) : 0;
  const priority = priorityConfig[project.priority] || priorityConfig.medium;
  const badge = phaseBadgeConfig[project.phase] || phaseBadgeConfig.active;

  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState(project.description || '');

  const saveDescription = () => {
    updateProject(project.id, { description: descDraft.trim() });
    setEditingDesc(false);
  };

  const statusCounts = {
    planning: projectTasks.filter(t => t.status === 'planning').length,
    backlog: projectTasks.filter(t => t.status === 'backlog').length,
    inProgress: projectTasks.filter(t => t.status === 'in-progress').length,
    review: projectTasks.filter(t => t.status === 'review').length,
    done: projectTasks.filter(t => t.status === 'done').length,
  };

  // Editable description block (shared across columns)
  const descriptionBlock = editingDesc ? (
    <div className="mb-3" onClick={e => e.stopPropagation()}>
      <textarea
        value={descDraft}
        onChange={e => setDescDraft(e.target.value)}
        rows={3}
        autoFocus
        className="w-full bg-[var(--bg-secondary)] border border-[var(--border-strong)] rounded-[var(--radius-sm)] px-2.5 py-1.5 text-[var(--text-xs)] text-[var(--text-secondary)] leading-relaxed resize-none focus:outline-none focus:border-[var(--accent-primary)]"
        onKeyDown={e => { if (e.key === 'Escape') { setEditingDesc(false); setDescDraft(project.description || ''); } if (e.key === 'Enter' && e.metaKey) saveDescription(); }}
      />
      <div className="flex gap-1.5 mt-1.5">
        <button onClick={saveDescription} className="text-[10px] px-2 py-1 bg-[var(--accent-primary)] text-white rounded-[var(--radius-sm)] hover:bg-[var(--accent-hover)] transition-colors font-medium">Save</button>
        <button onClick={() => { setEditingDesc(false); setDescDraft(project.description || ''); }} className="text-[10px] px-2 py-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">Cancel</button>
      </div>
    </div>
  ) : (
    <div className="group/desc relative mb-3 cursor-pointer" onClick={e => { e.stopPropagation(); setDescDraft(project.description || ''); setEditingDesc(true); }}>
      {project.description ? (
        <p className="text-[var(--text-xs)] text-[var(--text-tertiary)] leading-relaxed line-clamp-2 pr-5">{project.description}</p>
      ) : (
        <p className="text-[var(--text-xs)] text-[var(--text-muted)] italic opacity-50 pr-5">Add description…</p>
      )}
      <Pencil size={11} className="absolute top-0.5 right-0 text-[var(--text-muted)] opacity-0 group-hover/desc:opacity-60 transition-opacity" />
    </div>
  );

  // --- Archived: compact, dimmed ---
  if (column === 'archived') {
    return (
      <div
        draggable
        onDragStart={e => onDragStart(e, project.id)}
        className="opacity-60 bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-md)] px-3 py-2.5 cursor-grab active:cursor-grabbing hover:opacity-80 transition-all group"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-[var(--text-sm)] font-semibold text-[var(--text-secondary)] truncate">{project.name}</span>
          <span className={clsx('text-[10px] font-medium px-1.5 py-0.5 rounded-full shrink-0', badge.cls)}>{badge.label}</span>
        </div>
        <div className="flex items-center gap-2 mt-1 text-[var(--text-xs)] text-[var(--text-muted)]">
          <span className={nameColors[project.owner] || 'text-[var(--text-tertiary)]'}>{project.owner}</span>
          {projectTasks.length > 0 && <span>· {projectTasks.length} task{projectTasks.length !== 1 ? 's' : ''}</span>}
        </div>
      </div>
    );
  }

  // --- Ideation: lightweight ---
  if (column === 'ideation') {
    return (
      <div
        draggable
        onDragStart={e => onDragStart(e, project.id)}
        className={clsx(
          'bg-[var(--card)] border border-dashed border-amber-400/20 rounded-[var(--radius-md)] p-4',
          'cursor-grab active:cursor-grabbing hover:border-amber-400/40 transition-all group',
          'shadow-[var(--shadow-sm)]'
        )}
      >
        <div className="flex items-start justify-between gap-2 mb-2">
          <h4 className="text-[var(--text-sm)] font-bold text-[var(--text-primary)] leading-tight">{project.name}</h4>
          <GripVertical size={14} className="text-[var(--text-muted)] opacity-0 group-hover:opacity-60 transition-opacity shrink-0 mt-0.5" />
        </div>
        {descriptionBlock}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-[var(--text-xs)] text-[var(--text-muted)]">
            <select
              value={project.owner}
              onChange={e => { e.stopPropagation(); updateProject(project.id, { owner: e.target.value }); }}
              onClick={e => e.stopPropagation()}
              className={clsx(
                'bg-transparent border-none outline-none cursor-pointer font-semibold text-[var(--text-xs)] p-0',
                nameColors[project.owner] || 'text-[var(--text-tertiary)]'
              )}
            >
              {knownNames.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
            <span className={priority.color}>· {priority.label}</span>
          </div>
        </div>
        <p className="text-[10px] text-[var(--text-muted)] italic mt-2.5 opacity-70">Drag to Active when ready →</p>
      </div>
    );
  }

  // --- Active: full metadata ---
  return (
    <div
      draggable
      onDragStart={e => onDragStart(e, project.id)}
      className={clsx(
        'bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-md)] p-4',
        'cursor-grab active:cursor-grabbing hover:border-[var(--border-strong)] transition-all group',
        'shadow-[var(--shadow-sm)]'
      )}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <h4 className="text-[var(--text-sm)] font-bold text-[var(--text-primary)] leading-tight">{project.name}</h4>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className={clsx('text-[10px] font-medium px-1.5 py-0.5 rounded-full', badge.cls)}>{badge.label}</span>
          <GripVertical size={14} className="text-[var(--text-muted)] opacity-0 group-hover:opacity-60 transition-opacity" />
        </div>
      </div>

      {descriptionBlock}

      {/* Progress bar */}
      {projectTasks.length > 0 && (
        <div className="mb-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wide">Progress</span>
            <span className="text-[var(--text-xs)] font-bold text-[var(--text-secondary)]">{completion}%</span>
          </div>
          <div className="h-1.5 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
            <div
              className="h-full bg-[var(--accent-primary)] rounded-full transition-all duration-500"
              style={{ width: `${completion}%` }}
            />
          </div>
        </div>
      )}

      {/* Status counts */}
      {projectTasks.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-3 text-[10px]">
          {statusCounts.inProgress > 0 && <span className="text-[var(--warning)]">● {statusCounts.inProgress} in progress</span>}
          {statusCounts.review > 0 && <span className="text-purple-400">● {statusCounts.review} review</span>}
          {statusCounts.planning > 0 && <span className="text-[var(--info)]">● {statusCounts.planning} planning</span>}
          {statusCounts.backlog > 0 && <span className="text-[var(--text-muted)]">● {statusCounts.backlog} backlog</span>}
          {statusCounts.done > 0 && <span className="text-[var(--success)]">● {statusCounts.done} done</span>}
        </div>
      )}

      {/* Footer: owner, priority, task link */}
      <div className="flex items-center justify-between pt-2.5 border-t border-[var(--border-subtle)]">
        <div className="flex items-center gap-2 text-[var(--text-xs)] text-[var(--text-muted)]">
          <select
            value={project.owner}
            onChange={e => { e.stopPropagation(); updateProject(project.id, { owner: e.target.value }); }}
            onClick={e => e.stopPropagation()}
            className={clsx(
              'bg-transparent border-none outline-none cursor-pointer font-semibold text-[var(--text-xs)] p-0',
              nameColors[project.owner] || 'text-[var(--text-tertiary)]'
            )}
          >
            {knownNames.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
          <span className={priority.color}>· {priority.label}</span>
        </div>
        <Link
          href={`/context?project=${project.id}`}
          onClick={e => e.stopPropagation()}
          className="flex items-center gap-1 text-[var(--text-xs)] font-medium text-[var(--accent-primary)] hover:text-[var(--accent-hover)] transition-colors"
        >
          {projectTasks.length > 0
            ? <>{projectTasks.length} task{projectTasks.length !== 1 ? 's' : ''}</>
            : <>Add tasks</>
          }
          <ArrowRight size={12} />
        </Link>
      </div>
    </div>
  );
}

// --- Add Idea Form ---

function AddIdeaForm({ onAdd, onCancel }: { onAdd: (name: string, description: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  return (
    <div className="bg-[var(--card)] border border-amber-400/30 rounded-[var(--radius-md)] p-4 shadow-[var(--shadow-sm)]">
      <input
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="Idea name…"
        autoFocus
        className="w-full bg-[var(--bg-secondary)] border border-[var(--border-strong)] rounded-[var(--radius-sm)] px-3 py-2 text-[var(--text-sm)] text-[var(--text-primary)] font-bold focus:outline-none focus:border-amber-400/50 mb-2"
        onKeyDown={e => { if (e.key === 'Enter' && name.trim()) { onAdd(name.trim(), description.trim()); } if (e.key === 'Escape') onCancel(); }}
      />
      <textarea
        value={description}
        onChange={e => setDescription(e.target.value)}
        placeholder="Brief description (optional)…"
        rows={2}
        className="w-full bg-[var(--bg-secondary)] border border-[var(--border-strong)] rounded-[var(--radius-sm)] px-3 py-2 text-[var(--text-xs)] text-[var(--text-tertiary)] leading-relaxed resize-none focus:outline-none focus:border-amber-400/50 mb-3"
        onKeyDown={e => { if (e.key === 'Escape') onCancel(); }}
      />
      <div className="flex gap-2">
        <button
          onClick={() => { if (name.trim()) onAdd(name.trim(), description.trim()); }}
          disabled={!name.trim()}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] bg-amber-400/15 text-amber-400 text-[var(--text-xs)] font-medium hover:bg-amber-400/25 transition-colors disabled:opacity-40"
        >
          <Check size={12} /> Add
        </button>
        <button
          onClick={onCancel}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] bg-[var(--bg-tertiary)] text-[var(--text-muted)] text-[var(--text-xs)] font-medium hover:text-[var(--text-primary)] transition-colors"
        >
          <X size={12} /> Cancel
        </button>
      </div>
    </div>
  );
}

// --- Main Page ---

export default function VisionPage() {
  const storeData = useWSData<any>('store') as any;
  const projects: Project[] = storeData?.projects || [];
  const tasks: Task[] = storeData?.tasks || [];
  const loading = !storeData;
  const teammates: Teammate[] = storeData?.settings?.teammates || [];
  const nameColors = useMemo(() => buildNameColorMap(teammates), [teammates]);
  const knownNames = useMemo(() => teammates.map(t => t.name), [teammates]);

  // Drag state
  const [dragOverColumn, setDragOverColumn] = useState<ColumnId | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  // Add form state
  const [showAddForm, setShowAddForm] = useState(false);

  // Toast state
  const [toast, setToast] = useState<string | null>(null);

  // Group projects by column, sorted by sortOrder
  const columnProjects = useMemo(() => {
    const grouped: Record<ColumnId, Project[]> = { ideation: [], active: [], archived: [] };
    for (const p of projects) {
      const col = phaseToColumn(p.phase);
      grouped[col].push(p);
    }
    // Sort each column by sortOrder
    for (const key of Object.keys(grouped) as ColumnId[]) {
      grouped[key].sort((a, b) => (a.sortOrder ?? a.createdAt) - (b.sortOrder ?? b.createdAt));
    }
    return grouped;
  }, [projects]);

  const handleDragStart = useCallback((e: React.DragEvent, projectId: string) => {
    e.dataTransfer.setData('projectId', projectId);
    e.dataTransfer.setData('sourceCol', phaseToColumn(projects.find(p => p.id === projectId)?.phase || 'inspiration'));
    e.dataTransfer.effectAllowed = 'move';
    setDraggingId(projectId);
  }, [projects]);

  const handleDragOver = useCallback((e: React.DragEvent, columnId: ColumnId) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverColumn !== columnId) setDragOverColumn(columnId);
  }, [dragOverColumn]);

  const handleDragLeave = useCallback((e: React.DragEvent, columnId: ColumnId) => {
    const relatedTarget = e.relatedTarget as HTMLElement;
    const currentTarget = e.currentTarget as HTMLElement;
    if (!currentTarget.contains(relatedTarget)) {
      setDragOverColumn(prev => prev === columnId ? null : prev);
      setDragOverIndex(null);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, columnId: ColumnId) => {
    e.preventDefault();
    const projectId = e.dataTransfer.getData('projectId');
    const sourceCol = e.dataTransfer.getData('sourceCol') as ColumnId;
    setDragOverColumn(null);
    setDragOverIndex(null);
    setDraggingId(null);

    if (!projectId) return;

    const project = projects.find(p => p.id === projectId);
    if (!project) return;

    const colProjects = columnProjects[columnId];
    const insertIdx = dragOverIndex !== null ? dragOverIndex : colProjects.length;

    if (sourceCol === columnId) {
      // Within-column reorder
      const currentIdx = colProjects.findIndex(p => p.id === projectId);
      if (currentIdx === -1 || currentIdx === insertIdx || currentIdx === insertIdx - 1) return;

      const reordered = [...colProjects];
      const [moved] = reordered.splice(currentIdx, 1);
      const targetIdx = insertIdx > currentIdx ? insertIdx - 1 : insertIdx;
      reordered.splice(targetIdx, 0, moved);

      // Persist new sortOrders
      reordered.forEach((p, i) => {
        const newOrder = (i + 1) * 1000;
        if (p.sortOrder !== newOrder) {
          updateProject(p.id, { sortOrder: newOrder });
        }
      });
    } else {
      // Cross-column move — change phase + position
      const newPhase = COLUMN_PHASES[columnId];
      const newSortOrder = insertIdx < colProjects.length
        ? (colProjects[insertIdx]?.sortOrder ?? colProjects[insertIdx]?.createdAt ?? Date.now()) - 1
        : (colProjects.length > 0 ? (colProjects[colProjects.length - 1]?.sortOrder ?? colProjects[colProjects.length - 1]?.createdAt ?? Date.now()) + 1000 : 1000);

      updateProject(projectId, { phase: newPhase, sortOrder: newSortOrder });

      // Toast when moving to Active from Ideation
      if (columnId === 'active' && sourceCol === 'ideation') {
        setToast('Project activated — add tasks on the Context Board →');
      }
    }
  }, [projects, columnProjects, dragOverIndex]);

  const handleCardDragOver = useCallback((e: React.DragEvent, columnId: ColumnId, idx: number) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const newIdx = e.clientY < midY ? idx : idx + 1;
    if (dragOverColumn !== columnId || dragOverIndex !== newIdx) {
      setDragOverColumn(columnId);
      setDragOverIndex(newIdx);
    }
  }, [dragOverColumn, dragOverIndex]);

  const handleDragEnd = useCallback(() => {
    setDragOverColumn(null);
    setDragOverIndex(null);
    setDraggingId(null);
  }, []);

  const handleAddIdea = useCallback(async (name: string, description: string) => {
    await addProject({
      name,
      description,
      owner: knownNames[0] || '',
      phase: 'inspiration',
      priority: 'medium',
      createdBy: 'user',
    });
    setShowAddForm(false);
  }, [knownNames]);

  if (loading) {
    return (
      <div className="space-y-8">
        <PageHeader title="Vision Board" description="Loading..." />
      </div>
    );
  }

  return (
    <div className="space-y-6 h-full flex flex-col">
      <PageHeader
        title="Vision Board"
        description="From idea to execution. Start here, drag to Active."
      />

      {/* Kanban columns */}
      <div className="flex gap-5 flex-1 min-h-0 overflow-x-auto pb-2">
        {COLUMNS.map(col => {
          const colProjects = columnProjects[col.id];
          const isDropTarget = dragOverColumn === col.id;
          const isIdeation = col.id === 'ideation';
          const isArchived = col.id === 'archived';
          const Icon = col.icon;

          // Split active column into in-progress vs complete
          const isActiveCol = col.id === 'active';
          const activeProjects = isActiveCol ? colProjects.filter(p => {
            const pTasks = tasks.filter(t => t.projectId === p.id);
            return pTasks.length === 0 || pTasks.filter(t => t.status === 'done').length < pTasks.length;
          }) : colProjects;
          const completeProjects = isActiveCol ? colProjects.filter(p => {
            const pTasks = tasks.filter(t => t.projectId === p.id);
            return pTasks.length > 0 && pTasks.filter(t => t.status === 'done').length === pTasks.length;
          }) : [];

          const displayProjects = isActiveCol ? activeProjects : colProjects;

          return (
            <div
              key={col.id}
              className={clsx(
                'flex flex-col rounded-[var(--radius-lg)] border transition-all duration-200 shrink-0',
                isIdeation ? 'w-[420px]' : isActiveCol ? 'w-[400px]' : 'w-[360px]',
                // Column styling
                isIdeation
                  ? 'border-dashed border-amber-400/30 bg-amber-400/[0.03]'
                  : isArchived
                    ? 'border-[var(--border-default)] bg-[var(--bg-secondary)]/50'
                    : 'border-[var(--border-default)] bg-[var(--bg-secondary)]/30',
                // Drop target highlight
                isDropTarget && 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/[0.04] shadow-[0_0_20px_rgba(var(--accent-rgb,255,92,92),0.08)]',
                isDropTarget && isIdeation && 'border-amber-400/60 bg-amber-400/[0.06]',
              )}
              onDragOver={e => handleDragOver(e, col.id)}
              onDragLeave={e => handleDragLeave(e, col.id)}
              onDrop={e => handleDrop(e, col.id)}
            >
              {/* Column header */}
              <div className={clsx(
                'px-4 pt-4 pb-3 border-b',
                isIdeation ? 'border-amber-400/15' : 'border-[var(--border-subtle)]'
              )}>
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span className="text-base">{col.emoji}</span>
                    <h3 className={clsx(
                      'text-[var(--text-sm)] font-bold uppercase tracking-wide',
                      isIdeation ? 'text-amber-400' : isArchived ? 'text-[var(--text-muted)]' : 'text-[var(--text-secondary)]'
                    )}>
                      {col.label}
                    </h3>
                    <span className="text-[10px] font-medium text-[var(--text-muted)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded-full">
                      {colProjects.length}
                    </span>
                  </div>
                </div>
                <p className="text-[10px] text-[var(--text-muted)]">{col.tagline}</p>

                {/* New Idea button — only in Ideation */}
                {isIdeation && !showAddForm && (
                  <button
                    onClick={() => setShowAddForm(true)}
                    className="mt-3 w-full flex items-center justify-center gap-2 px-3 py-2 rounded-[var(--radius-sm)] border border-dashed border-amber-400/30 text-amber-400 text-[var(--text-xs)] font-medium hover:bg-amber-400/10 hover:border-amber-400/50 transition-all"
                  >
                    <Plus size={14} /> New Idea
                  </button>
                )}
              </div>

              {/* Column body — scrollable */}
              <div className="flex-1 overflow-y-auto p-3 space-y-0 min-h-[120px]">
                {/* Inline add form */}
                {isIdeation && showAddForm && (
                  <div className="mb-2.5">
                    <AddIdeaForm
                      onAdd={handleAddIdea}
                      onCancel={() => setShowAddForm(false)}
                    />
                  </div>
                )}

                {/* Cards with vertical drag-and-drop */}
                {displayProjects.map((project, idx) => (
                  <div key={project.id}>
                    {/* Drop indicator line */}
                    {dragOverColumn === col.id && dragOverIndex === idx && (
                      <div className={clsx(
                        'h-0.5 rounded-full mx-1 my-1',
                        isIdeation ? 'bg-amber-400' : isActiveCol ? 'bg-[var(--accent-primary)]' : 'bg-[var(--border-strong)]'
                      )} />
                    )}
                    <div
                      className={clsx(
                        'py-1 transition-opacity duration-200',
                        draggingId === project.id && 'opacity-40'
                      )}
                      onDragOver={e => handleCardDragOver(e, col.id, idx)}
                      onDragEnd={handleDragEnd}
                    >
                      <KanbanCard
                        project={project}
                        tasks={tasks}
                        column={col.id}
                        nameColors={nameColors}
                        knownNames={knownNames}
                        onDragStart={handleDragStart}
                      />
                    </div>
                  </div>
                ))}
                {/* Drop indicator at end of list */}
                {dragOverColumn === col.id && dragOverIndex === displayProjects.length && (
                  <div className={clsx(
                    'h-0.5 rounded-full mx-1 my-1',
                    isIdeation ? 'bg-amber-400' : isActiveCol ? 'bg-[var(--accent-primary)]' : 'bg-[var(--border-strong)]'
                  )} />
                )}

                {/* Complete sub-section — Active column only */}
                {isActiveCol && completeProjects.length > 0 && (
                  <>
                    {/* Divider */}
                    <div className="flex items-center gap-3 my-3 px-1">
                      <div className="flex-1 h-px bg-[var(--success)]/30" />
                      <span className="text-[10px] font-semibold text-[var(--success)] uppercase tracking-wide flex items-center gap-1.5">
                        <Check size={12} /> Complete
                      </span>
                      <div className="flex-1 h-px bg-[var(--success)]/30" />
                    </div>

                    {/* Complete project cards — success border accent */}
                    {completeProjects.map(project => (
                      <div
                        key={project.id}
                        className={clsx(
                          'py-1 transition-opacity duration-200',
                          draggingId === project.id && 'opacity-40'
                        )}
                        onDragEnd={handleDragEnd}
                      >
                        <div className="border-l-2 border-[var(--success)]/50 rounded-[var(--radius-md)]">
                          <KanbanCard
                            project={project}
                            tasks={tasks}
                            column={col.id}
                            nameColors={nameColors}
                            knownNames={knownNames}
                            onDragStart={handleDragStart}
                          />
                        </div>
                      </div>
                    ))}
                  </>
                )}

                {/* Empty state */}
                {colProjects.length === 0 && !(isIdeation && showAddForm) && (
                  <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
                    <span className="text-2xl mb-2">{isIdeation ? '💡' : isArchived ? '📦' : '🚀'}</span>
                    <p className="text-[var(--text-xs)] font-semibold text-[var(--text-secondary)] mb-1">
                      {isIdeation ? 'Where ideas start' : isArchived ? 'Nothing archived yet' : 'Your active projects'}
                    </p>
                    <p className="text-[var(--text-xs)] text-[var(--text-muted)] leading-relaxed max-w-[180px]">
                      {isIdeation ? 'Click "New Idea" above to capture your first concept.' : isArchived ? 'Completed or shelved projects will appear here.' : 'Drag an idea here when it\'s ready to build.'}
                    </p>
                  </div>
                )}

                {/* Drop zone indicator when column is empty */}
                {isDropTarget && colProjects.length === 0 && (
                  <div className="border-2 border-dashed border-[var(--accent-primary)]/30 rounded-[var(--radius-md)] h-16 flex items-center justify-center text-[var(--text-xs)] text-[var(--text-muted)]">
                    Drop here
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Toast */}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}
