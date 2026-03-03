'use client';

import { PageHeader } from '@/components/PageHeader';
import { getProjects, getTasks, getProjectCompletion, type Project, type Task } from '@/lib/store';
import { FolderKanban, ArrowRight, Circle } from 'lucide-react';
import { clsx } from 'clsx';
import { useState, useEffect } from 'react';
import Link from 'next/link';

const phaseConfig: Record<string, { label: string; color: string }> = {
  active:   { label: 'Active',   color: 'text-[var(--success)] bg-[var(--success-subtle)] border-[rgba(34,197,94,0.3)]' },
  planning: { label: 'Planning', color: 'text-[var(--info)] bg-[var(--info-subtle)] border-[rgba(59,130,246,0.3)]' },
  paused:   { label: 'Paused',   color: 'text-[var(--warning)] bg-[var(--warning-subtle)] border-[rgba(245,158,11,0.3)]' },
  complete: { label: 'Complete', color: 'text-[var(--text-muted)] bg-[var(--bg-tertiary)] border-[var(--border-default)]' },
};

const priorityConfig: Record<string, { label: string; color: string }> = {
  high:   { label: 'High',   color: 'text-[var(--error)]' },
  medium: { label: 'Medium', color: 'text-[var(--warning)]' },
  low:    { label: 'Low',    color: 'text-[var(--text-muted)]' },
};

function ProjectCard({ project, tasks, stagger }: { project: Project; tasks: Task[]; stagger: number }) {
  const projectTasks = tasks.filter(t => t.projectId === project.id);
  const completion = getProjectCompletion(project.id);
  const daysAgo = Math.floor((Date.now() - project.createdAt) / 86400000);
  const phase = phaseConfig[project.phase] || phaseConfig.active;
  const priority = priorityConfig[project.priority] || priorityConfig.medium;

  const statusCounts = {
    backlog: projectTasks.filter(t => t.status === 'backlog').length,
    todo: projectTasks.filter(t => t.status === 'todo').length,
    inProgress: projectTasks.filter(t => t.status === 'in-progress').length,
    review: projectTasks.filter(t => t.status === 'review').length,
    done: projectTasks.filter(t => t.status === 'done').length,
  };

  return (
    <div className={clsx(
      'animate-rise bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-5',
      'hover:border-[var(--border-strong)] transition-all duration-200',
      'shadow-[var(--shadow-sm),inset_0_1px_0_var(--card-highlight)]',
      `stagger-${stagger}`
    )}>
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <FolderKanban size={16} className="text-[var(--accent-primary)]" />
          <h3 className="text-[15px] font-bold text-[var(--text-primary)] tracking-tight">{project.name}</h3>
        </div>
        <span className={clsx('text-[10px] font-semibold px-2 py-0.5 rounded-full border', phase.color)}>
          {phase.label}
        </span>
      </div>

      <p className="text-xs text-[var(--text-tertiary)] leading-relaxed mb-4">{project.description}</p>

      {/* Progress bar */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wide">Progress</span>
          <span className="text-[11px] font-bold text-[var(--text-secondary)]">{completion}%</span>
        </div>
        <div className="h-1.5 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
          <div
            className="h-full bg-[var(--accent-primary)] rounded-full transition-all duration-500"
            style={{ width: `${completion}%` }}
          />
        </div>
      </div>

      {/* Task breakdown */}
      <div className="flex items-center gap-3 mb-4 text-[10px]">
        {statusCounts.inProgress > 0 && <span className="text-[var(--warning)]">● {statusCounts.inProgress} in progress</span>}
        {statusCounts.review > 0 && <span className="text-purple-400">● {statusCounts.review} review</span>}
        {statusCounts.todo > 0 && <span className="text-[var(--info)]">● {statusCounts.todo} to do</span>}
        {statusCounts.backlog > 0 && <span className="text-[var(--text-muted)]">● {statusCounts.backlog} backlog</span>}
        {statusCounts.done > 0 && <span className="text-[var(--success)]">● {statusCounts.done} done</span>}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between pt-3 border-t border-[var(--border-subtle)]">
        <div className="flex items-center gap-3 text-[10px] text-[var(--text-muted)]">
          <span>Owner: <strong className="text-[var(--text-tertiary)]">{project.owner}</strong></span>
          <span>Priority: <strong className={priority.color}>{priority.label}</strong></span>
        </div>
        <span className="text-[10px] text-[var(--text-muted)]">
          Created {daysAgo}d ago by {project.createdBy}
        </span>
      </div>

      {/* Link to tasks */}
      <Link href={`/tasks?project=${project.id}`}
        className="mt-3 flex items-center gap-1 text-[11px] font-medium text-[var(--accent-primary)] hover:text-[var(--accent-hover)] transition-colors">
        View tasks <ArrowRight size={12} />
      </Link>
    </div>
  );
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);

  useEffect(() => {
    setProjects(getProjects());
    setTasks(getTasks());
  }, []);

  const activeProjects = projects.filter(p => p.phase === 'active');
  const otherProjects = projects.filter(p => p.phase !== 'active');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Projects"
        description={`${projects.length} projects · ${tasks.length} total tasks`}
      />

      {/* Active projects */}
      <div>
        <h2 className="text-[11px] uppercase tracking-[0.04em] font-semibold text-[var(--text-muted)] mb-3">
          Active ({activeProjects.length})
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {activeProjects.map((proj, i) => (
            <ProjectCard key={proj.id} project={proj} tasks={tasks} stagger={Math.min(i + 1, 6)} />
          ))}
        </div>
      </div>

      {/* Other projects */}
      {otherProjects.length > 0 && (
        <div>
          <h2 className="text-[11px] uppercase tracking-[0.04em] font-semibold text-[var(--text-muted)] mb-3">
            Other ({otherProjects.length})
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {otherProjects.map((proj, i) => (
              <ProjectCard key={proj.id} project={proj} tasks={tasks} stagger={Math.min(i + 1, 6)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
