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
import dynamic from 'next/dynamic';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowUpRight, Clock, Play, Loader2, Square, AlertTriangle } from 'lucide-react';

// Lazy-loaded — heavy editor with optimistic write logic. Keeps the dashboard
// shell snappy and matches the dynamic() pattern used by the legacy page.
const RoadmapWithApprovalHorizon = dynamic(
  () => import('@/components/RoadmapWithApprovalHorizon').then(mod => mod.RoadmapWithApprovalHorizon),
  { ssr: false }
);
import { useWSData } from '@/lib/ws';
import {
  getEffectiveComponents,
  getComponentVersions,
  getComponentApprovedThrough,
  getComponentIcon,
  getOrphanBlockedTasks,
  type ComponentLike,
} from '@/lib/component-helpers';
import { isVersionInHorizon, compareVersions } from '@/lib/version-utils';
import { TaskDetailPanel } from '@/components/TaskDetailPanel';
import { ActivityTimeline } from '@/components/ActivityTimeline';
import DispatchHealthBanner from '@/components/dashboard/DispatchHealthBanner';
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

/**
 * Per-status breakdown for the summary card. Mirrors the labelling logic used
 * by the per-ticket list (done / blocked / planning / inProgress) so the
 * summary numbers match what the roadmap shows item-by-item.
 */
function doneWhenBreakdown(
  items: any[],
  taskById: Map<string, any>,
): { done: number; blocked: number; planning: number; inProgress: number; total: number } {
  let done = 0;
  let blocked = 0;
  let planning = 0;
  let inProgress = 0;
  for (const it of items) {
    const t = it.taskId ? taskById.get(it.taskId) : null;
    const status = t?.status as string | undefined;
    const isDone = status === 'done' || it.done === true;
    if (isDone) {
      done++;
    } else if (status === 'blocked') {
      blocked++;
    } else if (!it.taskId) {
      // No backing task yet → still in planning.
      planning++;
    } else {
      inProgress++;
    }
  }
  return { done, blocked, planning, inProgress, total: items.length };
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

/**
 * #1216: click-to-edit owner select. Shared by component-owner (right rail of
 * CurrentVersionHero) and per-version owner (roadmap row). Renders the current
 * value as a chip; clicking swaps to a teammate <select>. Save fires the
 * provided onSave callback (which is responsible for optimistic update +
 * persistence). Esc / blur outside cancels.
 *
 * Mirrors the same teammate-source pattern as RoadmapTaskCreator: roster comes
 * from settings.teammates[].name, passed in via the `teammates` prop.
 */
function OwnerSelect({
  value,
  teammates,
  onSave,
  placeholder,
  inheritedHint,
  monoFont,
}: {
  value?: string;
  teammates: string[];
  onSave: (next: string) => void | Promise<void>;
  placeholder?: string;
  inheritedHint?: boolean;
  monoFont?: string;
}) {
  const [editing, setEditing] = useState(false);
  const display = value && value.trim().length > 0 ? value : (placeholder || '—');
  if (!editing) {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setEditing(true); }}
        className="inline-flex items-center gap-1.5 text-[13px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
        title="Click to change owner"
        style={inheritedHint ? { fontStyle: 'italic', opacity: 0.85 } : undefined}
      >
        <span className="truncate">{display}</span>
        {inheritedHint && (
          <span
            className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)]"
            style={monoFont ? { fontFamily: monoFont } : undefined}
          >
            (inherited)
          </span>
        )}
      </button>
    );
  }
  // Build options: include current value (even if not in roster) so we don't
  // silently drop a stale assignment when the picker opens.
  const options = Array.from(new Set([
    ...(value ? [value] : []),
    ...teammates,
  ]));
  return (
    <select
      autoFocus
      defaultValue={value || ''}
      onClick={(e) => e.stopPropagation()}
      onChange={async (e) => {
        const next = e.target.value;
        setEditing(false);
        if (next !== (value || '')) {
          await onSave(next);
        }
      }}
      onBlur={() => setEditing(false)}
      className="px-2 py-1 rounded text-[12px] bg-[var(--card-highlight)] text-[var(--text-primary)] outline-none"
      style={{ border: '1px solid var(--border-default)' }}
    >
      <option value="">— unassigned —</option>
      {options.map((t) => (
        <option key={t} value={t}>{t}</option>
      ))}
    </select>
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

  // #1216: roster of teammate names for owner pickers (component owner +
  // per-version owner in the roadmap below). Sourced from settings.teammates;
  // a casing-fix lands earlier today so trust the canonical names.
  const teammates: string[] = useMemo(
    () =>
      (storeData?.settings?.teammates || [])
        .map((t: any) => (typeof t === 'string' ? t : t?.name))
        .filter((n: any): n is string => typeof n === 'string' && n.length > 0),
    [storeData],
  );

  // #1216: optimistic local override for component.owner. Cleared once the
  // upstream prop catches up (next store WS push).
  const [optimisticComponentOwner, setOptimisticComponentOwner] =
    useState<{ componentId: string; owner: string } | null>(null);
  const saveComponentOwner = useCallback(
    async (componentId: string, nextOwner: string) => {
      const prev = optimisticComponentOwner;
      setOptimisticComponentOwner({ componentId, owner: nextOwner });
      try {
        const resp = await fetch('/api/store', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'updateComponent',
            projectId,
            componentId,
            updates: { owner: nextOwner },
          }),
        });
        if (!resp.ok) throw new Error('updateComponent failed');
      } catch (e) {
        console.error('Failed to update component owner:', e);
        setOptimisticComponentOwner(prev);
      }
    },
    [projectId, optimisticComponentOwner],
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
  // Semver-aware ascending copy. Used everywhere we need to pick "first/next/last"
  // by semantic version order rather than by raw store order. Keeps store-order
  // separate so UI list rendering stays untouched.
  const sortedCompVersions = useMemo<any[]>(
    () => [...compVersions].sort((a, b) => compareVersions(a.version, b.version)),
    [compVersions]
  );
  const compHorizon = useMemo<string | null>(
    () => (activeComp ? (getComponentApprovedThrough(project as any, activeComp.id) ?? null) : null),
    [project, activeComp]
  );

  // The "current" version: prefer status==='current', else first non-shipped
  // in-horizon version (semver-asc), else last shipped (semver-asc).
  const currentVersion = useMemo<any | null>(() => {
    const explicit = compVersions.find((v) => v.status === 'current');
    if (explicit) return explicit;
    if (compHorizon) {
      const next = sortedCompVersions.find(
        (v) => v.status !== 'shipped' && isVersionInHorizon(v.version, compHorizon)
      );
      if (next) return next;
    }
    const shipped = sortedCompVersions.filter((v) => v.status === 'shipped');
    return shipped[shipped.length - 1] ?? compVersions[0] ?? null;
  }, [compVersions, sortedCompVersions, compHorizon]);

  // The "begin work" target — first unshipped, in-horizon (same as ledger),
  // semver-ascending.
  const beginTarget = useMemo<any | null>(() => {
    if (!compHorizon) return null;
    return (
      sortedCompVersions.find(
        (v) => v.status !== 'shipped' && isVersionInHorizon(v.version, compHorizon)
      ) || null
    );
  }, [sortedCompVersions, compHorizon]);

  // Previous shipped + next planned for the roadmap stepper context.
  const previousShipped = useMemo<any | null>(() => {
    const shipped = sortedCompVersions.filter((v) => v.status === 'shipped');
    return shipped[shipped.length - 1] ?? null;
  }, [sortedCompVersions]);
  const nextPlanned = useMemo<any | null>(() => {
    if (!currentVersion) return null;
    const idx = sortedCompVersions.findIndex((v) => v.version === currentVersion.version);
    if (idx < 0) return null;
    for (let i = idx + 1; i < sortedCompVersions.length; i++) {
      if (sortedCompVersions[i].status !== 'shipped') return sortedCompVersions[i];
    }
    return null;
  }, [sortedCompVersions, currentVersion]);

  // Task panel
  const [selectedTask, setSelectedTask] = useState<any | null>(null);
  const [showDetailPanel, setShowDetailPanel] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [stateBusy, setStateBusy] = useState(false);

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

  /* ---------------- Launch / Start / Stop (restored from pre-cutover page) ---
   * Mirrors the legacy `handleLaunch` exactly: pick the primary component
   * (no role, or role !== 'qa'/'support'), find the first unshipped version
   * within that component's `approvedThrough` horizon, gate on planning
   * tickets, then POST `promoteVersion` to /api/store. Component-scoped —
   * the approval-horizon write path matches RoadmapWithApprovalHorizon's
   * own writes.
   */
  const primaryComponent = useMemo<ComponentLike | null>(() => {
    if (components.length === 0) return null;
    return (
      components.find((c: any) => !c.role || (c.role !== 'qa' && c.role !== 'support')) ??
      components[0]
    );
  }, [components]);

  const launchTarget = useMemo<any | null>(() => {
    if (!project) return null;
    if (!primaryComponent) return null;
    // #1224: launch target = first unshipped version on the primary
    // component that's in approvedVersions[]. No project-level fallback.
    const approved: string[] = Array.isArray((primaryComponent as any).approvedVersions)
      ? (primaryComponent as any).approvedVersions
      : [];
    if (approved.length === 0) return null;
    const compVers = (getComponentVersions(project as any, primaryComponent.id) as any[]) || [];
    const sortedCompVers = [...compVers].sort((a, b) =>
      compareVersions(a.version, b.version)
    );
    return (
      sortedCompVers.find(
        (v) => v.status !== 'shipped' && approved.includes(v.version),
      ) || null
    );
  }, [project, primaryComponent]);

  // #1185 rename: 'stopped' → 'inactive'. Accept both during transition.
  const projectStopped =
    (project as any)?.state === 'inactive' || (project as any)?.state === 'stopped';
  const projectCurrentVersion = (project as any)?.currentVersion as string | undefined;

  const handleLaunch = useCallback(async () => {
    if (!projectId || !launchTarget) return;
    const draftItems = (launchTarget.items || []).filter((it: any) => !it.taskId);
    if (draftItems.length > 0) {
      alert(
        'Cannot start v' +
          launchTarget.version +
          ': ' +
          draftItems.length +
          ' item(s) need planning tickets before launch.'
      );
      return;
    }
    setLaunching(true);
    try {
      const resp = await fetch('/api/store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'promoteVersion',
          projectId,
          targetVersion: launchTarget.version,
        }),
      });
      const result = await resp.json().catch(() => ({}));
      if (!result.ok && result.reason) alert('Cannot start: ' + result.reason);
    } catch (e) {
      console.error('Launch failed:', e);
    } finally {
      setLaunching(false);
    }
  }, [projectId, launchTarget]);

  const setProjectState = useCallback(
    async (state: 'active' | 'inactive') => {
      if (!projectId) return;
      setStateBusy(true);
      try {
        await fetch('/api/store', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'updateProject',
            id: projectId,
            updates: { state },
          }),
        });
      } catch (e) {
        console.error('Failed to update project state:', e);
      } finally {
        setStateBusy(false);
      }
    },
    [projectId]
  );

  const onStartProject = useCallback(async () => {
    // #1185 rename: 'started' → 'active'. Activate the project; if no
    // currentVersion (or stale junk), also promote the next approved version.
    await setProjectState('active');
    const versionExistsOnActiveComponent = (v: string) =>
      compVersions.some((x) => x.version === v);
    if (!projectCurrentVersion || !versionExistsOnActiveComponent(projectCurrentVersion)) {
      await handleLaunch();
    }
  }, [setProjectState, projectCurrentVersion, handleLaunch, compVersions]);

  const onStopProject = useCallback(
    () => setProjectState('inactive'),
    [setProjectState]
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
          className="sticky top-0 z-30 flex flex-wrap md:flex-nowrap items-center justify-between gap-x-4 gap-y-2 py-3 -mx-4 sm:-mx-6 lg:-mx-10 px-4 sm:px-6 lg:px-10"
          style={{
            background: 'rgba(19, 21, 28, 0.92)',
            backdropFilter: 'blur(8px)',
            borderBottom: '1px solid var(--border-default)',
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
          <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
            {/* Two-state project toggle (ticket roto54ammou4arq8 / 2026-05-06).
             *
             * Replaces the legacy three-button surface (Activate / Launch vX /
             * Deactivate). The middle "Launch vX" state was the awkward third
             * stop — "approved but not yet launched" — and now collapses into
             * approval itself: ticking a version into approvedVersions[] on an
             * active project auto-promotes via the updateComponent handler in
             * src/app/api/store/route.ts.
             *
             * Behavior:
             *   - Active   → click to deactivate (scheduler skips, approvals queue)
             *   - Inactive → click to activate (auto-promote runs on transition)
             */}
            {(() => {
              const active = !projectStopped;
              const noWork = !projectCurrentVersion && !launchTarget;
              const disabled = stateBusy || launching || (!active && noWork);
              const onClick = active ? onStopProject : onStartProject;
              const label = active ? 'Active' : 'Inactive';
              const title = active
                ? 'Click to deactivate — scheduler will skip this project. Approvals stay queued.'
                : noWork
                  ? 'Approve a version on a component roadmap below to enable activation'
                  : 'Click to activate — dispatcher will pick up backlog work and auto-launch any approved version.';
              const accent = active
                ? { fg: '#34d399', bg: 'rgba(52, 211, 153, 0.14)', border: 'rgba(52, 211, 153, 0.45)' }
                : noWork
                  ? { fg: 'var(--text-muted)', bg: 'var(--card-highlight)', border: 'var(--border-default)' }
                  : { fg: '#94a3b8', bg: 'rgba(148, 163, 184, 0.10)', border: 'rgba(148, 163, 184, 0.40)' };
              return (
                <button
                  type="button"
                  onClick={onClick}
                  disabled={disabled}
                  title={title}
                  aria-pressed={active}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] uppercase tracking-[0.1em] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{
                    fontFamily: monoFont,
                    background: accent.bg,
                    color: accent.fg,
                    border: '1px solid ' + accent.border,
                  }}
                >
                  {stateBusy || launching ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : active ? (
                    <Square size={13} />
                  ) : (
                    <Play size={13} />
                  )}
                  {stateBusy || launching ? 'Working…' : label}
                </button>
              );
            })()}
            <Link
              href={'/projects/' + projectId + '/ledger'}
              className="inline-flex items-center gap-1.5 text-[12px] uppercase tracking-[0.1em] text-[var(--text-tertiary)] hover:text-[var(--accent)] transition-colors whitespace-nowrap"
              style={{ fontFamily: monoFont }}
            >
              Read as Ledger
              <ArrowUpRight size={14} />
            </Link>
          </div>
        </header>

        {/* #1184 — dispatch-fizzle visibility banner. Renders only when at
         * least one assigned-to-this-project agent has staleBacklog === true.
         */}
        {storeData && (
          <DispatchHealthBanner store={storeData} projectId={projectId} />
        )}

        {/* #1235 — Orphan blocked tasks. Tasks with status='blocked' that are
         * not anchored to any component (sectionId), roadmap item, or parent
         * task wouldn't otherwise be reachable from this dashboard. The
         * project-list "X blocked" badge counts them, but the per-version
         * breakdowns only see roadmap-anchored tasks, leaving orphans
         * invisible. Surface them here, clickable to open the detail panel,
         * so users can find every task that contributes to the blocked count.
         *
         * Render only when at least one orphan exists — no empty section.
         */}
        {(() => {
          const orphanBlocked = getOrphanBlockedTasks(allTasks, projectId);
          if (orphanBlocked.length === 0) return null;
          return (
            <section className="mt-6">
              <div
                className="rounded-md p-4 sm:p-5"
                style={{
                  background: 'rgba(255, 92, 92, 0.06)',
                  border: '1px solid rgba(255, 92, 92, 0.30)',
                }}
              >
                <div className="flex items-start gap-3">
                  <AlertTriangle
                    size={16}
                    style={{ color: '#ff5c5c', marginTop: 2, flexShrink: 0 }}
                  />
                  <div className="flex-1 min-w-0">
                    <div
                      className="text-[11px] uppercase tracking-[0.16em] mb-1"
                      style={{ color: '#ff5c5c', fontFamily: monoFont }}
                    >
                      {orphanBlocked.length} orphan blocked task
                      {orphanBlocked.length === 1 ? '' : 's'}
                    </div>
                    <div className="text-[12px] text-[var(--text-tertiary)] mb-3">
                      Blocked tasks not anchored to any component or roadmap
                      item. They count toward the project blocked total but
                      live outside the roadmap below — click through to
                      unblock or re-home them.
                    </div>
                    <ul className="flex flex-col gap-1.5">
                      {orphanBlocked.map((t) => (
                        <li key={t.id}>
                          <button
                            type="button"
                            onClick={() => onPickTask(t.id)}
                            className="w-full text-left rounded px-3 py-2 text-[13px] transition-colors hover:bg-[var(--card-highlight)]"
                            style={{
                              background: 'var(--card)',
                              border: '1px solid var(--border-default)',
                              color: 'var(--text-primary)',
                            }}
                            title="Open task"
                          >
                            <div className="flex items-center gap-2 flex-wrap">
                              <span style={{ color: '#ff5c5c', fontSize: 11 }}>
                                🚫
                              </span>
                              <span className="truncate">{t.title || '(untitled)'}</span>
                              {t.assignee && (
                                <span
                                  className="text-[11px]"
                                  style={{ color: 'var(--text-tertiary)', fontFamily: monoFont }}
                                >
                                  · {t.assignee}
                                </span>
                              )}
                              {t.blockedReason && (
                                <span
                                  className="text-[11px] truncate"
                                  style={{ color: 'var(--text-tertiary)' }}
                                >
                                  — {t.blockedReason}
                                </span>
                              )}
                            </div>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            </section>
          );
        })()}

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
            component={
              optimisticComponentOwner && optimisticComponentOwner.componentId === activeComp.id
                ? { ...(activeComp as any), owner: optimisticComponentOwner.owner }
                : activeComp
            }
            version={currentVersion}
            taskById={taskById}
            beginTarget={beginTarget}
            onBeginWork={onBeginWork}
            onPickTask={onPickTask}
            monoFont={monoFont}
            teammates={teammates}
            onSaveComponentOwner={(next) => saveComponentOwner(activeComp.id, next)}
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

        {/* COMPONENT GRID
         *
         * Hidden for single-component projects: the grid is a tab-picker for
         * the Roadmap section below, so with one component it's a 1-tab
         * tab-bar that just duplicates the version pill + progress shown
         * inside the Roadmap header. Show it only when there's something
         * to switch between (>= 2 components).
         */}
        {components.length > 1 && (
          <section className="mt-10">
            <SectionHeader title="Components" subtitle={components.length + ' active'} mono={monoFont} />
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
              {components.map((c) => {
                const versions = (getComponentVersions(project as any, c.id) as any[]) || [];
                // Semver-aware ascending copy for any "first/next/last" picks.
                // Keep `versions` (store order) untouched for any UI listing.
                const sortedVersions = [...versions].sort((a, b) =>
                  compareVersions(a.version, b.version)
                );
                const explicitCurrent = versions.find((v) => v.status === 'current');
                const horizon = getComponentApprovedThrough(project as any, c.id) ?? null;
                const fallbackCurrent =
                  explicitCurrent ??
                  (horizon
                    ? sortedVersions.find(
                        (v) => v.status !== 'shipped' && isVersionInHorizon(v.version, horizon)
                      )
                    : null) ??
                  sortedVersions.filter((v) => v.status === 'shipped').slice(-1)[0] ??
                  versions[0] ??
                  null;
                const stats = doneWhenStats(fallbackCurrent?.items || [], taskById);
                const idx = sortedVersions.findIndex(
                  (v) => v.version === fallbackCurrent?.version
                );
                const upNext = sortedVersions
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

        {/* ROADMAP + APPROVAL HORIZON
         * Restored from pre-cutover page (commit 838e05c). The dashboard
         * was display-only after the Studio Ledger cutover — you could
         * see the horizon but couldn't change it. RoadmapWithApprovalHorizon
         * brings back click-to-set-horizon UX and per-component scoped
         * writes (componentId + component props → components[i].approvedThrough
         * instead of project-wide autonomy.approvedThrough).
         *
         * This replaces the static stepper that lived here. The component
         * renders versions, items, status badges, AND the editable approval
         * banner — strict superset of the stepper view, so we drop the
         * stepper. A compact prev/current/next context line still lives
         * below for at-a-glance reading.
         */}
        {activeComp && compVersions.length > 0 && (
          <section className="mt-10 min-w-0">
            <SectionHeader
              title="Roadmap"
              subtitle={activeComp.name + ' · ' + compVersions.length + ' versions'}
              mono={monoFont}
            />
            <div
              id="roadmap-section"
              className="mt-3 rounded-md p-3 sm:p-4 min-w-0"
              style={{
                background: 'var(--card)',
                border: '1px solid var(--border-default)',
                scrollMarginTop: '96px',
              }}
            >
              <RoadmapWithApprovalHorizon
                projectId={projectId}
                project={project as any}
                versions={compVersions as any}
                tasks={allTasks}
                selectedTask={selectedTask}
                onTaskSelect={(task: any) => {
                  setSelectedTask(task);
                  setShowDetailPanel(true);
                }}
                componentId={activeComp.id}
                component={
                  optimisticComponentOwner && optimisticComponentOwner.componentId === activeComp.id
                    ? { ...(activeComp as any), owner: optimisticComponentOwner.owner }
                    : (activeComp as any)
                }
                teammates={teammates}
              />
            </div>
            {/* Stepper context line — at-a-glance prev/current/next. */}
            <div
              className="mt-2 flex items-center gap-2 text-[12px] text-[var(--text-muted)] flex-wrap"
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
/* Summary progress (hero card)                                               */
/* -------------------------------------------------------------------------- */

function SummaryProgress({
  breakdown,
  tone,
  monoFont,
}: {
  breakdown: { done: number; blocked: number; planning: number; inProgress: number; total: number };
  tone: 'accent' | 'shipped' | 'current';
  monoFont: string;
}) {
  const { done, blocked, planning, inProgress, total } = breakdown;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const fill =
    tone === 'shipped' ? '#34d399' : tone === 'current' ? '#fbbf24' : 'var(--accent)';
  const blockedPct = total > 0 ? Math.round((blocked / total) * 100) : 0;

  return (
    <div className="mb-2">
      {/* Progress bar with optional blocked-risk segment on the right edge */}
      <div
        className="relative w-full rounded-full overflow-hidden"
        style={{ height: 6, background: 'var(--surface-2, rgba(255,255,255,0.05))' }}
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={done + ' of ' + total + ' done'}
      >
        <div
          className="h-full transition-all"
          style={{
            width: pct + '%',
            background: fill,
            minWidth: pct > 0 ? 2 : 0,
          }}
        />
        {blocked > 0 && (
          <div
            className="absolute top-0 right-0 h-full"
            style={{
              width: Math.max(blockedPct, 2) + '%',
              background: 'var(--danger, #ff5c5c)',
              opacity: 0.85,
            }}
            title={blocked + ' blocked'}
          />
        )}
      </div>

      {/* Counts row */}
      <div
        className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] tabular-nums text-[var(--text-secondary)]"
        style={{ fontFamily: monoFont }}
      >
        <span className="text-[var(--text-primary)] font-medium">{pct}%</span>
        <span aria-hidden="true" style={{ color: 'var(--text-muted)' }}>
          ·
        </span>
        <span><span style={{ color: '#34d399' }}>{done}</span> done</span>
        {blocked > 0 && (
          <span><span style={{ color: '#ff5c5c' }}>{blocked}</span> blocked</span>
        )}
        {inProgress > 0 && (
          <span><span style={{ color: 'var(--text-primary)' }}>{inProgress}</span> in progress</span>
        )}
        {planning > 0 && (
          <span><span style={{ color: '#fbbf24' }}>{planning}</span> planning</span>
        )}
        <span style={{ color: 'var(--text-muted)' }}>/ {total} total</span>
      </div>
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
  teammates,
  onSaveComponentOwner,
}: {
  project: any;
  component: ComponentLike;
  version: any;
  taskById: Map<string, any>;
  beginTarget: any | null;
  onBeginWork: () => void;
  onPickTask: (taskId?: string) => void;
  monoFont: string;
  teammates: string[];
  onSaveComponentOwner: (next: string) => void | Promise<void>;
}) {
  const items: any[] = version.items || [];
  const breakdown = doneWhenBreakdown(items, taskById);
  const kind = classifyVersion(version);
  const c = statusColor(kind);
  // Two-state pivot (2026-05-06): showBeginWork retired; per-version "Begin
  // work" CTA was removed in favor of the header Active/Inactive toggle +
  // approval-as-launch. `onBeginWork` prop kept on the contract for now to
  // avoid touching every call site; it is no longer rendered.
  void onBeginWork;
  void beginTarget;

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

            {/* Summary: counts + progress bar (per-ticket detail lives in roadmap section below) */}
            <SummaryProgress
              breakdown={breakdown}
              tone={kind === 'shipped' ? 'shipped' : kind === 'current' ? 'current' : 'accent'}
              monoFont={monoFont}
            />

            <div className="mt-2 mb-4">
              <a
                href="#roadmap-section"
                className="text-[12px] text-[var(--accent)] hover:underline"
                style={{ fontFamily: monoFont }}
                onClick={(e) => {
                  // Prefer smooth scroll; fall back to default jump if not supported.
                  const el = typeof document !== 'undefined'
                    ? document.getElementById('roadmap-section')
                    : null;
                  if (el && typeof el.scrollIntoView === 'function') {
                    e.preventDefault();
                    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    // Update hash without jump for shareable URL.
                    if (typeof history !== 'undefined' && history.replaceState) {
                      history.replaceState(null, '', '#roadmap-section');
                    }
                  }
                }}
              >
                View in roadmap →
              </a>
            </div>

            {/* Two-state pivot (ticket roto54ammou4arq8 / 2026-05-06): the
             * per-version "Begin work on vX" CTA is gone. Approval = launch
             * on an active project (auto-promote runs on approvedVersions[]
             * change). The Active/Inactive toggle in the header is the single
             * control surface for project state.
             */}
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
            <RailItem
              mono={monoFont}
              label="Component owner"
              value={
                <OwnerSelect
                  value={(component as any).owner}
                  teammates={teammates}
                  onSave={onSaveComponentOwner}
                  placeholder="— set owner —"
                  monoFont={monoFont}
                />
              }
            />
            <RailItem
              mono={monoFont}
              label="Version owner"
              value={
                (version as any).owner
                  ? (version as any).owner
                  : ((component as any).owner || project?.owner || '—')
              }
            />
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
