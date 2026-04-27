'use client';

/**
 * Project dashboard — operations console.
 *
 * Default view at /projects/[id]. The editorial Studio Ledger view lives at
 * /projects/[id]/ledger. This page is built for the daily "is v0.16.2 done
 * yet" check, not for end-to-end reading. Three legibility-first fixes
 * relative to the ledger:
 *   1. Body type ≥14px, headlines 18–24px (no 38px hero copy).
 *   2. Information-dense rows; no per-version hero cards.
 *   3. Current version is the first thing on the page, not buried.
 *
 * Data hooks mirror LedgerProjectPage exactly — same store, same helpers,
 * same Begin Work POST. Only the JSX/styling is rewritten.
 */

import { useMemo, useState, Suspense, useCallback } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowUpRight, CheckCircle2, Circle, Clock, Play, AlertTriangle } from 'lucide-react';
import { useWSData } from '@/lib/ws';
import {
  getEffectiveComponents,
  getComponentVersions,
  getComponentApprovedThrough,
  getComponentIcon,
  type ComponentLike,
} from '@/lib/component-helpers';
import { isVersionInHorizon } from '@/lib/version-utils';
import { TaskDetailPanel } from '@/components/TaskDetailPanel';
import { ActivityTimeline } from '@/components/ActivityTimeline';
import { updateTask, addComment as addTaskComment, deleteTask } from '@/lib/store';

/* -------------------------------------------------------------------------- */
/* Status colors — one accent palette across the page                         */
/* -------------------------------------------------------------------------- */

type StatusKind = 'shipped' | 'current' | 'planned' | 'blocked';

function statusColor(kind: StatusKind): { fg: string; bg: string; border: string; dot: string } {
  switch (kind) {
    case 'shipped':
      return {
        fg: '#34d399',
        bg: 'rgba(52, 211, 153, 0.10)',
        border: 'rgba(52, 211, 153, 0.35)',
        dot: '#34d399',
      };
    case 'current':
      return {
        fg: '#fbbf24',
        bg: 'rgba(251, 191, 36, 0.10)',
        border: 'rgba(251, 191, 36, 0.40)',
        dot: '#fbbf24',
      };
    case 'blocked':
      return {
        fg: '#ff5c5c',
        bg: 'rgba(255, 92, 92, 0.10)',
        border: 'rgba(255, 92, 92, 0.40)',
        dot: '#ff5c5c',
      };
    case 'planned':
    default:
      return {
        fg: 'var(--text-tertiary)',
        bg: 'rgba(255, 255, 255, 0.03)',
        border: 'var(--border-default)',
        dot: 'var(--text-muted)',
      };
  }
}

function classifyVersion(v: any): StatusKind {
  const s = (v?.status as string) || '';
  if (s === 'shipped') return 'shipped';
  if (s === 'current' || s === 'in-progress') return 'current';
  if (s === 'blocked') return 'blocked';
  return 'planned';
}

/* -------------------------------------------------------------------------- */
/* Pill                                                                       */
/* -------------------------------------------------------------------------- */

function StatusPill({ kind, children }: { kind: StatusKind; children: React.ReactNode }) {
  const c = statusColor(kind);
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] uppercase tracking-[0.08em] font-medium"
      style={{
        color: c.fg,
        background: c.bg,
        border: '1px solid ' + c.border,
        fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
      }}
    >
      <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: c.dot }} />
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Progress bar — thin, accent fill                                           */
/* -------------------------------------------------------------------------- */

function ProgressBar({
  done,
  total,
  height = 4,
  tone = 'accent',
}: {
  done: number;
  total: number;
  height?: number;
  tone?: 'accent' | 'shipped' | 'current';
}) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const fill =
    tone === 'shipped' ? '#34d399' : tone === 'current' ? '#fbbf24' : 'var(--accent)';
  return (
    <div
      className="w-full rounded-full overflow-hidden"
      style={{ height, background: 'rgba(255,255,255,0.05)' }}
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full transition-all"
        style={{
          width: pct + '%',
          background: fill,
          minWidth: pct > 0 ? 2 : 0,
        }}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* doneWhen item helpers                                                      */
/* -------------------------------------------------------------------------- */

function doneWhenStats(items: any[], taskById: Map<string, any>): { done: number; total: number } {
  const total = items.length;
  let done = 0;
  for (const it of items) {
    const t = it.taskId ? taskById.get(it.taskId) : null;
    const isDone = (t?.status === 'done') || it.done === true;
    if (isDone) done++;
  }
  return { done, total };
}

/* -------------------------------------------------------------------------- */
/* Owner avatar                                                               */
/* -------------------------------------------------------------------------- */

function OwnerChip({ name }: { name?: string }) {
  if (!name) return null;
  const initial = name.trim().charAt(0).toUpperCase();
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)]">
      <span
        className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-semibold"
        style={{
          background: 'var(--card-highlight)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border-default)',
        }}
      >
        {initial}
      </span>
      <span className="truncate">{name}</span>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Inner page                                                                 */
/* -------------------------------------------------------------------------- */

function ProjectDashboardPageInner() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = params?.id as string;

  const storeData = useWSData<any>('store');
  const activityStatus = useWSData<any>('activity-status');

  const project = useMemo<any>(() => {
    if (!storeData?.projects) return null;
    return storeData.projects.find((p: any) => p.id === projectId) || null;
  }, [storeData, projectId]);

  const components = useMemo<ComponentLike[]>(
    () => (project ? getEffectiveComponents(project).filter((c) => !(c as any).archived) : []),
    [project]
  );

  const allTasks: any[] = (storeData?.tasks || []) as any[];
  const taskById = useMemo(() => {
    const m = new Map<string, any>();
    for (const t of allTasks) m.set(t.id, t);
    return m;
  }, [allTasks]);

  // Active component from ?component= query, falling back to first component.
  const activeId = useMemo(() => {
    const fromQuery = searchParams?.get('component');
    if (fromQuery && components.some((c) => c.id === fromQuery)) return fromQuery;
    return components[0]?.id ?? null;
  }, [searchParams, components]);
  const activeComp = components.find((c) => c.id === activeId) ?? components[0] ?? null;

  // Versions + horizon for the active component.
  const compVersions = useMemo<any[]>(
    () => (activeComp ? (getComponentVersions(project as any, activeComp.id) as any[]) : []),
    [project, activeComp]
  );
  const compHorizon = useMemo<string | null>(
    () => (activeComp ? (getComponentApprovedThrough(project as any, activeComp.id) ?? null) : null),
    [project, activeComp]
  );

  // The "current" version: prefer status==='current', else first non-shipped
  // in-horizon version, else last shipped.
  const currentVersion = useMemo<any | null>(() => {
    const explicit = compVersions.find((v) => v.status === 'current');
    if (explicit) return explicit;
    if (compHorizon) {
      const next = compVersions.find(
        (v) => v.status !== 'shipped' && isVersionInHorizon(v.version, compHorizon)
      );
      if (next) return next;
    }
    const shipped = [...compVersions].filter((v) => v.status === 'shipped');
    return shipped[shipped.length - 1] ?? compVersions[0] ?? null;
  }, [compVersions, compHorizon]);

  // The "begin work" target — first unshipped, in-horizon (same as ledger).
  const beginTarget = useMemo<any | null>(() => {
    if (!compHorizon) return null;
    return (
      compVersions.find(
        (v) => v.status !== 'shipped' && isVersionInHorizon(v.version, compHorizon)
      ) || null
    );
  }, [compVersions, compHorizon]);

  // Previous shipped + next planned for the roadmap stepper context.
  const previousShipped = useMemo<any | null>(() => {
    const shipped = compVersions.filter((v) => v.status === 'shipped');
    return shipped[shipped.length - 1] ?? null;
  }, [compVersions]);
  const nextPlanned = useMemo<any | null>(() => {
    if (!currentVersion) return null;
    const idx = compVersions.findIndex((v) => v.version === currentVersion.version);
    for (let i = idx + 1; i < compVersions.length; i++) {
      if (compVersions[i].status !== 'shipped') return compVersions[i];
    }
    return null;
  }, [compVersions, currentVersion]);

  // Task panel
  const [selectedTask, setSelectedTask] = useState<any | null>(null);
  const [showDetailPanel, setShowDetailPanel] = useState(false);
  const [expandedVersion, setExpandedVersion] = useState<string | null>(null);

  const onPickTask = useCallback(
    (taskId?: string) => {
      if (!taskId) return;
      const t = taskById.get(taskId);
      if (!t) return;
      setSelectedTask(t);
      setShowDetailPanel(true);
    },
    [taskById]
  );

  const onBeginWork = useCallback(async () => {
    if (!beginTarget || !projectId) return;
    const draftItems = (beginTarget.items || []).filter((it: any) => !it.taskId);
    if (draftItems.length > 0) {
      alert(
        'Cannot start v' +
          beginTarget.version +
          ': ' +
          draftItems.length +
          ' item(s) need planning tickets first.'
      );
      return;
    }
    const resp = await fetch('/api/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'promoteVersion',
        projectId,
        targetVersion: beginTarget.version,
      }),
    });
    const result = await resp.json().catch(() => ({}));
    if (!result.ok && result.reason) alert('Cannot start: ' + result.reason);
  }, [beginTarget, projectId]);

  const onSelectComponent = useCallback(
    (id: string) => {
      router.replace('/projects/' + projectId + '?component=' + id, { scroll: false });
    },
    [router, projectId]
  );

  if (!storeData) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-[var(--text-muted)]">
        Loading…
      </div>
    );
  }
  if (!project) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-[var(--text-muted)]">
        Project not found
      </div>
    );
  }

  const monoFont =
    'var(--font-mono, ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace)';

  /* ---------------- Render ---------------- */

  return (
    <div className="flex-1 overflow-auto overflow-x-clip" style={{ background: 'var(--bg-primary)' }}>
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-10 pb-24">
        {/* HEADER STRIP — sticky */}
        <header
          className="sticky top-0 z-30 flex items-center justify-between gap-4 py-3 -mx-4 sm:-mx-6 lg:-mx-10 px-4 sm:px-6 lg:px-10"
          style={{
            background: 'rgba(19, 21, 28, 0.92)',
            backdropFilter: 'blur(8px)',
            borderBottom: '1px solid var(--border-default)',
            minHeight: 56,
          }}
        >
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="flex items-center gap-2 text-[12px] uppercase tracking-[0.1em] text-[var(--text-muted)]"
              style={{ fontFamily: monoFont }}
            >
              <Link href="/projects" className="hover:text-[var(--text-primary)] transition-colors">
                Projects
              </Link>
              <span>/</span>
            </div>
            <h1
              className="text-[18px] font-semibold text-[var(--text-primary)] truncate"
              style={{ letterSpacing: '-0.01em' }}
            >
              {project.name}
            </h1>
            {currentVersion && (
              <StatusPill kind={classifyVersion(currentVersion)}>
                v{currentVersion.version}
              </StatusPill>
            )}
            {project.state && (
              <span
                className="hidden md:inline text-[12px] text-[var(--text-tertiary)] uppercase tracking-[0.1em]"
                style={{ fontFamily: monoFont }}
              >
                {project.state}
              </span>
            )}
            {project.owner && (
              <span className="hidden lg:inline text-[12px] text-[var(--text-tertiary)]">
                · owned by {project.owner}
              </span>
            )}
          </div>
          <Link
            href={'/projects/' + projectId + '/ledger'}
            className="inline-flex items-center gap-1.5 text-[12px] uppercase tracking-[0.1em] text-[var(--text-tertiary)] hover:text-[var(--accent)] transition-colors whitespace-nowrap"
            style={{ fontFamily: monoFont }}
          >
            Read as Ledger
            <ArrowUpRight size={14} />
          </Link>
        </header>

        {/* SUB-HEADER — currently viewing component:version */}
        {activeComp && currentVersion && (
          <div
            className="sticky z-20 flex items-center gap-3 py-2 -mx-4 sm:-mx-6 lg:-mx-10 px-4 sm:px-6 lg:px-10 text-[12px] overflow-x-auto whitespace-nowrap"
            style={{
              top: 56,
              background: 'rgba(19, 21, 28, 0.85)',
              backdropFilter: 'blur(6px)',
              borderBottom: '1px solid var(--border-default)',
              fontFamily: monoFont,
              color: 'var(--text-tertiary)',
            }}
          >
            <span className="uppercase tracking-[0.12em] text-[var(--text-muted)]">Viewing</span>
            <span className="text-[var(--text-secondary)]">
              {getComponentIcon((activeComp as any).role)} {activeComp.name}
            </span>
            <span className="text-[var(--text-muted)]">→</span>
            <span className="text-[var(--text-primary)]">v{currentVersion.version}</span>
            <StatusPill kind={classifyVersion(currentVersion)}>{currentVersion.status}</StatusPill>
          </div>
        )}

        {/* CURRENT VERSION HERO */}
        {activeComp && currentVersion ? (
          <CurrentVersionHero
            project={project}
            component={activeComp}
            version={currentVersion}
            taskById={taskById}
            beginTarget={beginTarget}
            onBeginWork={onBeginWork}
            onPickTask={onPickTask}
            monoFont={monoFont}
          />
        ) : (
          <div
            className="mt-8 p-6 rounded-md border text-[14px] text-[var(--text-tertiary)]"
            style={{ background: 'var(--card)', borderColor: 'var(--border-default)' }}
          >
            {components.length === 0
              ? 'This project has no components yet.'
              : 'No active version for the selected component.'}
          </div>
        )}

        {/* COMPONENT GRID */}
        {components.length > 0 && (
          <section className="mt-10">
            <SectionHeader title="Components" subtitle={components.length + ' active'} mono={monoFont} />
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
              {components.map((c) => {
                const versions = (getComponentVersions(project as any, c.id) as any[]) || [];
                const explicitCurrent = versions.find((v) => v.status === 'current');
                const horizon = getComponentApprovedThrough(project as any, c.id) ?? null;
                const fallbackCurrent =
                  explicitCurrent ??
                  (horizon
                    ? versions.find(
                        (v) => v.status !== 'shipped' && isVersionInHorizon(v.version, horizon)
                      )
                    : null) ??
                  versions.filter((v) => v.status === 'shipped').slice(-1)[0] ??
                  versions[0] ??
                  null;
                const stats = doneWhenStats(fallbackCurrent?.items || [], taskById);
                const idx = versions.findIndex((v) => v.version === fallbackCurrent?.version);
                const upNext = versions
                  .slice(Math.max(idx, 0) + 1)
                  .find((v) => v.status !== 'shipped');
                const isActive = c.id === activeId;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => onSelectComponent(c.id)}
                    className="text-left rounded-md p-4 transition-colors group"
                    style={{
                      background: isActive ? 'var(--card-highlight)' : 'var(--card)',
                      border: '1px solid ' + (isActive ? 'var(--accent)' : 'var(--border-default)'),
                      boxShadow: isActive ? '0 0 0 1px var(--accent) inset' : 'none',
                    }}
                  >
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[18px] leading-none">
                          {getComponentIcon((c as any).role)}
                        </span>
                        <span className="text-[15px] font-medium text-[var(--text-primary)] truncate">
                          {c.name}
                        </span>
                      </div>
                      {fallbackCurrent && (
                        <StatusPill kind={classifyVersion(fallbackCurrent)}>
                          v{fallbackCurrent.version}
                        </StatusPill>
                      )}
                    </div>
                    <div className="flex items-center justify-between gap-3 mb-2">
                      <OwnerChip name={(c as any).owner} />
                      <span
                        className="text-[12px] text-[var(--text-tertiary)] tabular-nums"
                        style={{ fontFamily: monoFont }}
                      >
                        {stats.done}/{stats.total} done
                      </span>
                    </div>
                    <ProgressBar
                      done={stats.done}
                      total={stats.total}
                      tone={
                        fallbackCurrent?.status === 'shipped'
                          ? 'shipped'
                          : fallbackCurrent?.status === 'current'
                          ? 'current'
                          : 'accent'
                      }
                    />
                    {upNext && (
                      <div
                        className="mt-3 text-[12px] text-[var(--text-muted)]"
                        style={{ fontFamily: monoFont }}
                      >
                        Next up: <span className="text-[var(--text-secondary)]">v{upNext.version}</span>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* ROADMAP STRIP */}
        {activeComp && compVersions.length > 0 && (
          <section className="mt-10 min-w-0">
            <SectionHeader
              title="Roadmap"
              subtitle={activeComp.name + ' · ' + compVersions.length + ' versions'}
              mono={monoFont}
            />
            <div className="mt-3 rounded-md overflow-hidden" style={{ border: '1px solid var(--border-default)' }}>
              <div
                className="flex items-stretch overflow-x-auto"
                style={{ background: 'var(--card)' }}
              >
                {compVersions.map((v, i) => {
                  const kind = classifyVersion(v);
                  const c = statusColor(kind);
                  const isCurrent = v.version === currentVersion?.version;
                  const isLast = i === compVersions.length - 1;
                  const stats = doneWhenStats(v.items || [], taskById);
                  const isExpanded = expandedVersion === v.version;
                  return (
                    <div
                      key={v.version}
                      className="flex-shrink-0 min-w-[200px] flex flex-col"
                      style={{
                        borderRight: isLast ? 'none' : '1px solid var(--border-default)',
                        background: isCurrent ? c.bg : 'transparent',
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => setExpandedVersion(isExpanded ? null : v.version)}
                        className="text-left px-4 py-3 hover:bg-[var(--card-highlight)] transition-colors"
                      >
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span
                            className="text-[14px] tabular-nums font-medium"
                            style={{
                              color: isCurrent ? c.fg : kind === 'shipped' ? c.fg : 'var(--text-secondary)',
                              fontFamily: monoFont,
                              opacity: kind === 'planned' && !isCurrent ? 0.7 : 1,
                            }}
                          >
                            v{v.version}
                          </span>
                          <span
                            className="text-[10px] uppercase tracking-[0.12em]"
                            style={{ color: c.fg, fontFamily: monoFont, opacity: kind === 'planned' && !isCurrent ? 0.6 : 1 }}
                          >
                            {kind === 'shipped' ? '✓' : kind === 'current' ? '●' : '○'} {v.status}
                          </span>
                        </div>
                        {v.owner && (
                          <div
                            className="text-[11px] text-[var(--text-muted)] mb-1.5"
                            style={{ fontFamily: monoFont }}
                          >
                            {v.owner}
                          </div>
                        )}
                        <div
                          className="text-[11px] text-[var(--text-tertiary)] tabular-nums mb-1.5"
                          style={{ fontFamily: monoFont }}
                        >
                          {stats.done}/{stats.total} doneWhen
                        </div>
                        <ProgressBar
                          done={stats.done}
                          total={stats.total}
                          height={3}
                          tone={kind === 'shipped' ? 'shipped' : kind === 'current' ? 'current' : 'accent'}
                        />
                      </button>
                      {isExpanded && (v.items || []).length > 0 && (
                        <div
                          className="px-4 py-2 border-t"
                          style={{ borderColor: 'var(--border-default)', background: 'var(--bg-primary)' }}
                        >
                          <ul className="space-y-1">
                            {(v.items || []).map((it: any, idx: number) => {
                              const t = it.taskId ? taskById.get(it.taskId) : null;
                              const title = t?.title ?? it.title ?? '(untitled)';
                              const done = t?.status === 'done' || it.done === true;
                              return (
                                <li
                                  key={it.id ?? v.version + '-' + idx}
                                  className="flex items-start gap-2 text-[12px] leading-snug"
                                >
                                  {done ? (
                                    <CheckCircle2
                                      size={12}
                                      className="mt-[3px] flex-shrink-0"
                                      style={{ color: '#34d399' }}
                                    />
                                  ) : (
                                    <Circle
                                      size={12}
                                      className="mt-[3px] flex-shrink-0"
                                      style={{ color: 'var(--text-muted)' }}
                                    />
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => onPickTask(it.taskId)}
                                    disabled={!it.taskId}
                                    className="text-left flex-1 hover:text-[var(--accent)] transition-colors disabled:cursor-default"
                                    style={{
                                      color: done
                                        ? 'var(--text-muted)'
                                        : 'var(--text-secondary)',
                                      textDecoration: done ? 'line-through' : 'none',
                                    }}
                                  >
                                    {title}
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            {/* Stepper context line */}
            <div
              className="mt-2 flex items-center gap-2 text-[12px] text-[var(--text-muted)]"
              style={{ fontFamily: monoFont }}
            >
              {previousShipped && (
                <>
                  <span>prev shipped</span>
                  <span className="text-[var(--text-secondary)]">v{previousShipped.version}</span>
                  <span>·</span>
                </>
              )}
              {currentVersion && (
                <>
                  <span>current</span>
                  <span style={{ color: '#fbbf24' }}>v{currentVersion.version}</span>
                </>
              )}
              {nextPlanned && (
                <>
                  <span>·</span>
                  <span>next</span>
                  <span className="text-[var(--text-secondary)]">v{nextPlanned.version}</span>
                </>
              )}
            </div>
          </section>
        )}

        {/* ACTIVITY TIMELINE */}
        <section className="mt-10">
          <SectionHeader title="Activity" subtitle="Recent task movement" mono={monoFont} />
          <div
            className="mt-3 rounded-md p-4"
            style={{ background: 'var(--card)', border: '1px solid var(--border-default)' }}
          >
            <ActivityTimeline
              tasks={(allTasks as any[]).filter((t) => t.projectId === projectId)}
              teammates={storeData?.settings?.teammates || []}
              activityStatuses={activityStatus || {}}
            />
          </div>
        </section>
      </div>

      {/* TASK DETAIL PANEL */}
      {showDetailPanel && selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          projects={storeData?.projects || []}
          agents={storeData?.settings?.teammates?.map((t: any) => t.name) || []}
          nameColors={{}}
          qaLead={project?.qaLead}
          onUpdate={async (id, updates) => {
            await updateTask(id, updates);
          }}
          onDelete={async (id) => {
            await deleteTask(id);
          }}
          onAddComment={async (taskId, comment) => addTaskComment(taskId, comment)}
          onClose={() => setShowDetailPanel(false)}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Section header                                                             */
/* -------------------------------------------------------------------------- */

function SectionHeader({
  title,
  subtitle,
  mono,
}: {
  title: string;
  subtitle?: string;
  mono: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2
        className="text-[14px] uppercase tracking-[0.14em] text-[var(--text-secondary)] font-semibold"
        style={{ fontFamily: mono }}
      >
        {title}
      </h2>
      {subtitle && (
        <span
          className="text-[12px] text-[var(--text-muted)]"
          style={{ fontFamily: mono }}
        >
          {subtitle}
        </span>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Current version hero                                                       */
/* -------------------------------------------------------------------------- */

function CurrentVersionHero({
  project,
  component,
  version,
  taskById,
  beginTarget,
  onBeginWork,
  onPickTask,
  monoFont,
}: {
  project: any;
  component: ComponentLike;
  version: any;
  taskById: Map<string, any>;
  beginTarget: any | null;
  onBeginWork: () => void;
  onPickTask: (taskId?: string) => void;
  monoFont: string;
}) {
  const items: any[] = version.items || [];
  const stats = doneWhenStats(items, taskById);
  const kind = classifyVersion(version);
  const c = statusColor(kind);
  const showBeginWork =
    beginTarget && beginTarget.version === version.version && version.status !== 'current';

  // Started / ETA hints
  const startedAt = (version as any).startedAt;
  const eta = (version as any).eta || (version as any).targetDate;
  const vibe = (version as any).vibe || (version as any).goal;

  return (
    <section className="mt-6">
      <div
        className="rounded-md overflow-hidden"
        style={{
          background: 'var(--card)',
          border: '1px solid ' + (kind === 'current' ? c.border : 'var(--border-default)'),
          boxShadow: kind === 'current' ? '0 0 0 1px ' + c.border + ' inset' : 'none',
        }}
      >
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px]">
          {/* Left: version + items */}
          <div className="p-5 lg:p-6">
            <div className="flex flex-wrap items-center gap-3 mb-2">
              <span
                className="text-[11px] uppercase tracking-[0.16em] text-[var(--text-muted)]"
                style={{ fontFamily: monoFont }}
              >
                {getComponentIcon((component as any).role)} {component.name} · current
              </span>
              <StatusPill kind={kind}>{version.status}</StatusPill>
              {(version as any).owner && (component as any).owner !== (version as any).owner && (
                <span
                  className="text-[11px] uppercase tracking-[0.12em] text-[var(--accent)]"
                  style={{ fontFamily: monoFont }}
                  title={'Version owner override: ' + (version as any).owner}
                >
                  owner: {(version as any).owner}
                </span>
              )}
            </div>
            <div className="flex items-baseline gap-3 mb-4">
              <h2
                className="text-[24px] font-semibold tabular-nums text-[var(--text-primary)]"
                style={{ fontFamily: monoFont, letterSpacing: '-0.01em' }}
              >
                v{version.version}
              </h2>
              {(version as any).label && (
                <span className="text-[14px] text-[var(--text-tertiary)]">
                  {(version as any).label}
                </span>
              )}
            </div>

            {/* Progress + label */}
            <div className="flex items-center gap-3 mb-4">
              <div className="flex-1">
                <ProgressBar
                  done={stats.done}
                  total={stats.total}
                  tone={kind === 'shipped' ? 'shipped' : kind === 'current' ? 'current' : 'accent'}
                />
              </div>
              <span
                className="text-[13px] tabular-nums text-[var(--text-secondary)] whitespace-nowrap"
                style={{ fontFamily: monoFont }}
              >
                {stats.done}/{stats.total} doneWhen
              </span>
            </div>

            {/* doneWhen items */}
            {items.length === 0 ? (
              <p className="text-[13px] italic text-[var(--text-muted)] m-0">
                No doneWhen items defined.
              </p>
            ) : (
              <ul className="grid gap-1">
                {items.map((it, idx) => {
                  const t = it.taskId ? taskById.get(it.taskId) : null;
                  const title = t?.title ?? it.title ?? '(untitled)';
                  const taskStatus = t?.status as string | undefined;
                  const done = taskStatus === 'done' || it.done === true;
                  const isPlanning = !it.taskId && !done;
                  const blocked = taskStatus === 'blocked';
                  let label = '';
                  if (done) label = '';
                  else if (taskStatus) label = taskStatus;
                  else if (isPlanning) label = 'planning';

                  return (
                    <li
                      key={it.id ?? version.version + '-' + idx}
                      className="grid grid-cols-[16px_1fr_auto] items-center gap-3 py-1.5 px-2 -mx-2 rounded hover:bg-[var(--card-highlight)] transition-colors"
                    >
                      {done ? (
                        <CheckCircle2 size={14} style={{ color: '#34d399' }} />
                      ) : blocked ? (
                        <AlertTriangle size={14} style={{ color: '#ff5c5c' }} />
                      ) : (
                        <Circle size={14} style={{ color: 'var(--text-muted)' }} />
                      )}
                      <button
                        type="button"
                        onClick={() => onPickTask(it.taskId)}
                        disabled={!it.taskId}
                        className="text-left text-[14px] leading-snug bg-transparent border-0 p-0 m-0 cursor-pointer disabled:cursor-default truncate"
                        style={{
                          color: done ? 'var(--text-muted)' : 'var(--text-primary)',
                          textDecoration: done ? 'line-through' : 'none',
                        }}
                      >
                        {title}
                      </button>
                      {label && (
                        <span
                          className="text-[10px] uppercase tracking-[0.14em] whitespace-nowrap"
                          style={{
                            color: isPlanning
                              ? '#fbbf24'
                              : blocked
                              ? '#ff5c5c'
                              : 'var(--text-muted)',
                            fontFamily: monoFont,
                          }}
                        >
                          {label}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {/* Begin Work CTA */}
            {showBeginWork && (
              <div className="mt-5">
                <button
                  type="button"
                  onClick={onBeginWork}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded text-[13px] font-medium transition-all hover:opacity-90 active:scale-[0.99]"
                  style={{
                    background: 'var(--accent)',
                    color: 'var(--accent-contrast)',
                    border: 'none',
                  }}
                >
                  <Play size={14} />
                  Begin work on v{version.version}
                </button>
              </div>
            )}
          </div>

          {/* Right rail: ETA / started / vibe / owner */}
          <aside
            className="p-5 lg:p-6 grid gap-4 content-start"
            style={{
              background: 'rgba(255,255,255,0.02)',
              borderTop: '1px solid var(--border-default)',
              borderLeft: 'none',
            }}
          >
            <RailItem mono={monoFont} label="Owner" value={(version as any).owner || (component as any).owner || project?.owner || '—'} />
            {startedAt && (
              <RailItem
                mono={monoFont}
                label="Started"
                value={
                  <span className="inline-flex items-center gap-1.5">
                    <Clock size={12} /> {fmtDate(startedAt)}
                  </span>
                }
              />
            )}
            {eta && <RailItem mono={monoFont} label="ETA" value={typeof eta === 'number' ? fmtDate(eta) : String(eta)} />}
            {vibe && <RailItem mono={monoFont} label="Vibe" value={String(vibe)} multiline />}
            {(version as any).waitsFor && (
              <RailItem
                mono={monoFont}
                label="Waits on"
                value={
                  (version as any).waitsFor.componentId +
                  ' v' +
                  (version as any).waitsFor.version
                }
              />
            )}
          </aside>
        </div>
      </div>
    </section>
  );
}

function RailItem({
  label,
  value,
  mono,
  multiline,
}: {
  label: string;
  value: React.ReactNode;
  mono: string;
  multiline?: boolean;
}) {
  return (
    <div>
      <div
        className="text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted)] mb-1"
        style={{ fontFamily: mono }}
      >
        {label}
      </div>
      <div
        className={
          'text-[13px] text-[var(--text-secondary)] ' + (multiline ? 'leading-snug' : 'truncate')
        }
      >
        {value}
      </div>
    </div>
  );
}

function fmtDate(ms?: number | string): string {
  if (ms == null) return '—';
  const t = typeof ms === 'number' ? ms : Date.parse(ms);
  if (!Number.isFinite(t)) return String(ms);
  return new Date(t).toLocaleDateString('en-US', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/* -------------------------------------------------------------------------- */
/* Outer Suspense boundary                                                    */
/* -------------------------------------------------------------------------- */

export default function ProjectDashboardPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-full text-sm text-[var(--text-muted)]">
          Loading…
        </div>
      }
    >
      <ProjectDashboardPageInner />
    </Suspense>
  );
}
