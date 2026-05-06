'use client';
/**
 * DispatchHealthBanner — #1184 phase 2.
 *
 * Surfaces "X backlog tickets aren't dispatching to <agent> — top reason: <Y>"
 * on the project dashboard. Renders only when at least one assigned-to-this-
 * project agent has staleBacklog === true.
 *
 * Polls /api/dispatch-health/{agentId} for every distinct backlog assignee
 * on the project. Cheap: read-only Postgres query, ≤ N agents per project,
 * 60s refresh.
 *
 * Kept dependency-free of the rest of the dashboard: takes raw store +
 * projectId and computes everything itself. Easy to drop into other surfaces
 * (e.g. /team) later.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

interface BannerProps {
  store: any;
  projectId: string;
}

interface HealthRow {
  agentId: string;
  agentName: string;
  staleBacklog: boolean;
  backlogCount: number;
  topBlocker: string;
  topBlockerCount: number;
  lastDispatchAt: string | null;
  lastSkipReason: string | null;
}

const BLOCKER_LABEL: Record<string, string> = {
  'project-stopped': 'project stopped',
  'no-section-version': 'missing section/version',
  // #1224: per-component approval is now an explicit approvedVersions[] set
  // (checkboxes on the roadmap), not a single horizon. The stable enum value
  // 'above-horizon' is preserved in dispatch-attempts rows; only the label
  // changes here.
  'above-horizon': 'version not approved',
  waitsfor: 'waiting on dependency',
  'prior-version-unshipped': 'prior version unshipped',
  unassigned: 'unassigned',
  'archived-or-paused': 'archived or paused',
  'no-backlog': 'no backlog',
  unknown: 'unknown',
};

const BLOCKER_FIX_LABEL: Record<string, string | null> = {
  'project-stopped': 'Start project',
  'above-horizon': 'Approve version',
  'no-section-version': null, // ticket-side fix
  waitsfor: 'View dependency',
  'prior-version-unshipped': 'Ship prior version',
  unassigned: 'Assign owner',
  'archived-or-paused': null,
  'no-backlog': null,
  unknown: null,
};

function reasonLabel(raw: string | null | undefined): string {
  if (!raw) return 'unknown';
  return BLOCKER_LABEL[raw] || raw;
}

export function DispatchHealthBanner({ store, projectId }: BannerProps) {
  const project = useMemo(
    () => (store?.projects || []).find((p: any) => p.id === projectId),
    [store, projectId],
  );

  // Distinct backlog assignees on this project (agent-likes only — match
  // on store.teammates.kind === 'agent' if the field is present, else
  // include everyone and let the API decide).
  const candidateAgents = useMemo(() => {
    if (!project) return [];
    const tasks = (store?.tasks || []).filter(
      (t: any) =>
        t.projectId === projectId &&
        !t.isArchived &&
        t.status === 'backlog' &&
        t.assignee,
    );
    const seen = new Map<string, string>();
    for (const t of tasks) {
      const a = String(t.assignee).toLowerCase();
      if (!seen.has(a)) seen.set(a, t.assignee);
    }
    return Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
  }, [store, projectId, project]);

  const [rows, setRows] = useState<HealthRow[]>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (candidateAgents.length === 0) {
      setRows([]);
      return;
    }
    let cancelled = false;

    const fetchAll = async () => {
      const results: HealthRow[] = [];
      for (const a of candidateAgents) {
        try {
          const res = await fetch(
            `/api/dispatch-health/${encodeURIComponent(a.id)}?windowMinutes=60`,
            { cache: 'no-store' },
          );
          if (!res.ok) continue;
          const j = await res.json();
          // Find the dominant blocker for THIS project (not global).
          // Phase 2.5 idea: have the API accept ?projectId=... and scope the
          // diagnose. For now we use the global byTopBlocker breakdown, which
          // is a good enough first-cut for single-project agents like
          // Mikey/Ana/Gem.
          const breakdown = j.byTopBlocker || {};
          let topBlocker = 'unknown';
          let topCount = 0;
          for (const [k, v] of Object.entries(breakdown) as [string, number][]) {
            if (v > topCount) {
              topCount = v;
              topBlocker = k;
            }
          }
          results.push({
            agentId: a.id,
            agentName: a.name,
            staleBacklog: !!j.staleBacklog,
            backlogCount: 0, // filled below from store
            topBlocker,
            topBlockerCount: topCount,
            lastDispatchAt: j.lastDispatch?.at || null,
            lastSkipReason: j.lastAttempt?.reason || null,
          });
        } catch {
          /* swallow — banner is optional */
        }
      }
      if (cancelled) return;

      // Fill backlogCount from store (avoids extra round-trip).
      for (const r of results) {
        r.backlogCount = (store?.tasks || []).filter(
          (t: any) =>
            t.projectId === projectId &&
            t.status === 'backlog' &&
            !t.isArchived &&
            String(t.assignee || '').toLowerCase() === r.agentId,
        ).length;
      }

      setRows(results.filter((r) => r.staleBacklog && r.backlogCount > 0));
    };

    fetchAll();
    const handle = setInterval(fetchAll, 60_000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [candidateAgents, store, projectId]);

  if (rows.length === 0) return null;

  return (
    <div
      className="rounded-lg border px-4 py-3 mb-4"
      style={{
        background: 'rgba(180, 100, 0, 0.08)',
        borderColor: 'rgba(180, 100, 0, 0.35)',
      }}
    >
      <div className="flex items-start gap-3">
        <span aria-hidden className="text-lg leading-none mt-0.5">⚠️</span>
        <div className="flex-1 min-w-0">
          {rows.length === 1 ? (
            <BannerLine row={rows[0]} projectId={projectId} />
          ) : (
            <div className="text-sm text-[var(--text-primary)]">
              <strong>{rows.length} agents</strong> have backlog tickets that
              aren&apos;t dispatching on this project.{' '}
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="underline hover:no-underline"
              >
                {expanded ? 'Hide' : 'Show details'}
              </button>
            </div>
          )}

          {(rows.length > 1 && expanded) && (
            <div className="mt-2 space-y-1.5">
              {rows.map((r) => (
                <BannerLine key={r.agentId} row={r} projectId={projectId} />
              ))}
            </div>
          )}

          <div className="mt-1.5 text-xs text-[var(--text-tertiary)]">
            <Link
              href={`/api/dispatch-health/${rows[0].agentId}`}
              target="_blank"
              className="hover:underline"
            >
              View dispatch log
            </Link>
            {' · '}
            <span>refreshes every 60s</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function BannerLine({ row, projectId }: { row: HealthRow; projectId: string }) {
  const fix = BLOCKER_FIX_LABEL[row.topBlocker] || null;
  return (
    <div className="text-sm text-[var(--text-primary)]">
      <strong>
        {row.backlogCount} backlog ticket{row.backlogCount === 1 ? '' : 's'}
      </strong>{' '}
      aren&apos;t dispatching to{' '}
      <strong>{row.agentName}</strong>
      {' — top reason: '}
      <span style={{ color: 'rgb(214, 154, 74)' }}>
        {reasonLabel(row.topBlocker)}
      </span>
      {row.topBlockerCount > 0 && row.topBlockerCount < row.backlogCount && (
        <span className="text-[var(--text-tertiary)]">
          {' '}
          ({row.topBlockerCount} of {row.backlogCount} skipped attempts)
        </span>
      )}
      {fix && (
        <span className="ml-2 text-xs">
          [<Link
            href={`/projects/${projectId}#fix-${row.topBlocker}`}
            className="underline hover:no-underline"
          >
            {fix}
          </Link>]
        </span>
      )}
    </div>
  );
}

export default DispatchHealthBanner;
