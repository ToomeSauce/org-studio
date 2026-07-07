'use client';

/**
 * /system — System Observability (#1651)
 *
 * Everything that taxes the machine, in one place:
 *  - Dispatch ledger + breaker/budget state + breach windows (#1641/#1643)
 *  - Schedule registry + drift findings — crons, loops, zombies (#1642)
 *  - Skill install freshness per agent (#861/#980)
 *
 * /health stays the pure "is anything broken right now" triage page.
 * Token/cost analytics live on /usage.
 */

import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import dynamic from 'next/dynamic';

const SkillFreshnessSection = dynamic(() => import('@/components/SkillFreshnessSection'), {
  ssr: false,
  loading: () => <div className="h-24 animate-pulse bg-[var(--bg-secondary)] rounded-[var(--radius-md)]" />,
});

// ---------- helpers ----------

function relativeTime(ts: string | number): string {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 0) return 'just now';
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={clsx(
        'inline-block w-2.5 h-2.5 rounded-full shrink-0',
        ok ? 'bg-[var(--success)] shadow-[0_0_8px_rgba(52,211,153,0.5)]' : 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]'
      )}
    />
  );
}

function Panel({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={clsx('bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-md)] p-5', className)}>
      <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3">{title}</h2>
      {children}
    </div>
  );
}

function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `$${value.toFixed(2)}`;
}

function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

function formatDurationMs(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value < 1000) return `${Math.round(value)}ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

// ---------- Observability panel (moved from /health, #1650 → #1651) ----------

function ObservabilityPanel() {
  const [snap, setSnap] = useState<any>(null);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [windowMinutes, setWindowMinutes] = useState(1440);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch(`/api/observability?windowMinutes=${windowMinutes}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (cancelled) return;
          if (d) setSnap(d);
          else setFailed(true);
        })
        .catch(() => { if (!cancelled) setFailed(true); });
    load();
    const iv = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [windowMinutes]);

  if (failed && !snap)
    return <p className="text-sm text-[var(--text-muted)]">Observability data unavailable (no DATABASE_URL?).</p>;
  if (!snap) return <p className="text-sm text-[var(--text-muted)]">Checking...</p>;

  const d = snap.dispatches || {};
  const breaker = snap.breaker;
  const failures: any[] = snap.internalCallFailures || [];
  const openWindows: any[] = breaker?.openWindows || [];
  const host = breaker?.hostSamples?.latest;
  const allQuiet = openWindows.length === 0 && failures.length === 0;

  const stat = (label: string, value: string | number) => (
    <div className="px-3 py-2 rounded-[var(--radius-md)] bg-[var(--bg-secondary)] border border-[var(--border-subtle)]">
      <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{label}</div>
      <div className="text-sm font-semibold text-[var(--text-primary)] font-mono">{value}</div>
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2.5 text-sm flex-wrap">
        <StatusDot ok={allQuiet} />
        <span className="font-medium text-[var(--text-primary)]">
          {d.total ?? 0} dispatches in window ({d.perHour ?? 0}/hr)
          {allQuiet ? ' — no open breaches, no internal-call failures' : ''}
        </span>
        {openWindows.length > 0 && (
          <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
            🚨 {openWindows.length} open breach window{openWindows.length > 1 ? 's' : ''}
          </span>
        )}
        {failures.length > 0 && (
          <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
            ⚠ {failures.length} internal-call failure site{failures.length > 1 ? 's' : ''}
          </span>
        )}
        {breaker?.queue?.pending > 0 && (
          <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
            {breaker.queue.pending} dispatch{breaker.queue.pending > 1 ? 'es' : ''} queued by budget
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <select
            value={windowMinutes}
            onChange={(e) => setWindowMinutes(parseInt(e.target.value, 10))}
            className="text-xs bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded px-1.5 py-0.5 text-[var(--text-secondary)]"
          >
            <option value={60}>1h</option>
            <option value={1440}>24h</option>
            <option value={10080}>7d</option>
            <option value={43200}>30d</option>
          </select>
          <button
            onClick={() => setExpanded((e) => !e)}
            className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            {expanded ? 'collapse' : 'details'}
          </button>
        </div>
      </div>

      {/* Stat grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {stat('Dispatches', d.total ?? 0)}
        {stat('Turns last hr', breaker ? `${breaker.turnsLastHour}/${breaker.budget?.maxTurnsPerHour ?? '—'}` : '—')}
        {stat('Max concurrent', d.maxConcurrent ?? '—')}
        {stat('p95 duration', d.p95DurationMs != null ? `${Math.round(d.p95DurationMs / 1000)}s` : '—')}
        {stat('Model calls', `${snap.tokens?.calls ?? 0} ($${(snap.tokens?.costEstimate ?? 0).toFixed(2)})`)}
        {stat('Host load / loop', host ? `${host.load1 ?? '—'} / ${host.eventLoopDelayMs ?? '—'}ms` : '—')}
      </div>

      {/* Open breach windows — always visible when present */}
      {openWindows.length > 0 && (
        <div className="space-y-1.5">
          {openWindows.map((w: any) => (
            <div
              key={`${w.kind}-${w.openedAt}`}
              className="px-3 py-2 rounded-[var(--radius-md)] bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-xs text-red-800 dark:text-red-300"
            >
              <span className="font-semibold uppercase mr-1.5">{w.kind}</span>
              opened {relativeTime(w.openedAt)}{w.details ? ` — ${w.details}` : ''}
            </div>
          ))}
        </div>
      )}

      {/* Internal-call failure counters — always visible when present */}
      {failures.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[var(--text-muted)]">
                <th className="py-1 pr-3 font-medium">Caller</th>
                <th className="py-1 pr-3 font-medium">Target</th>
                <th className="py-1 pr-3 font-medium">Error</th>
                <th className="py-1 pr-3 font-medium">Count</th>
                <th className="py-1 font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {failures.map((f: any, i: number) => (
                <tr key={i} className="border-t border-[var(--border-subtle)] text-[var(--text-secondary)]">
                  <td className="py-1 pr-3 text-[var(--text-primary)] font-mono">{f.caller}</td>
                  <td className="py-1 pr-3 font-mono">{f.target || '—'}</td>
                  <td className="py-1 pr-3">{f.errorKind || '—'}{f.statusCode ? ` (${f.statusCode})` : ''}</td>
                  <td className="py-1 pr-3">{f.count ?? '—'}</td>
                  <td className="py-1">{f.lastSeen ? relativeTime(f.lastSeen) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {expanded && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
          {[
            { label: 'By agent', data: d.byAgent },
            { label: 'By source', data: d.bySource },
            { label: 'By outcome', data: d.byOutcome },
          ].map(({ label, data }) => (
            <div key={label}>
              <div className="font-medium text-[var(--text-muted)] mb-1">{label}</div>
              {data && Object.keys(data).length ? (
                <table className="w-full">
                  <tbody>
                    {Object.entries(data as Record<string, number>)
                      .sort((a, b) => b[1] - a[1])
                      .map(([k, v]) => (
                        <tr key={k} className="border-t border-[var(--border-subtle)] text-[var(--text-secondary)]">
                          <td className="py-0.5 pr-3 font-mono">{k}</td>
                          <td className="py-0.5 text-right font-mono">{v}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              ) : (
                <span className="text-[var(--text-muted)]">—</span>
              )}
            </div>
          ))}
          {snap.tokens?.byModelServed && Object.keys(snap.tokens.byModelServed).length > 0 && (
            <div className="sm:col-span-3">
              <div className="font-medium text-[var(--text-muted)] mb-1">Tokens / cost by served model</div>
              <table className="w-full">
                <thead>
                  <tr className="text-left text-[var(--text-muted)]">
                    <th className="py-1 pr-3 font-medium">Model</th>
                    <th className="py-1 pr-3 font-medium">Calls</th>
                    <th className="py-1 pr-3 font-medium">Tokens in</th>
                    <th className="py-1 pr-3 font-medium">Tokens out</th>
                    <th className="py-1 font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(snap.tokens.byModelServed as Record<string, any>)
                    .sort((a, b) => b[1].cost - a[1].cost)
                    .map(([model, t]) => (
                      <tr key={model} className="border-t border-[var(--border-subtle)] text-[var(--text-secondary)]">
                        <td className="py-0.5 pr-3 font-mono">{model}</td>
                        <td className="py-0.5 pr-3 font-mono">{t.calls}</td>
                        <td className="py-0.5 pr-3 font-mono">{t.tokensIn}</td>
                        <td className="py-0.5 pr-3 font-mono">{t.tokensOut}</td>
                        <td className="py-0.5 font-mono">${t.cost.toFixed(2)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type WorkerLaneMetrics = {
  lane: 'worker' | 'runtime';
  tickets: number;
  dispatches: number;
  costTotalUsd: number | null;
  costPerTicketUsd: number | null;
  ticketsDone: number;
  medianTimeToDoneMs: number | null;
  bounces: number;
  bounceRate: number | null;
};

type WorkerScorecardSnapshot = {
  windowDays: number;
  generatedAt: string;
  worker: WorkerLaneMetrics;
  runtime: WorkerLaneMetrics;
};

function WorkerScorecardPanel() {
  const [snap, setSnap] = useState<WorkerScorecardSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [windowDays, setWindowDays] = useState(14);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch(`/api/observability/worker-scorecard?windowDays=${windowDays}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (cancelled) return;
          if (d) {
            setSnap(d);
            setFailed(false);
          } else {
            setFailed(true);
          }
        })
        .catch(() => { if (!cancelled) setFailed(true); });

    load();
    const iv = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [windowDays]);

  if (failed && !snap) {
    return <p className="text-sm text-[var(--text-muted)]">Worker lane scorecard unavailable (no DATABASE_URL?).</p>;
  }
  if (!snap) return <p className="text-sm text-[var(--text-muted)]">Checking...</p>;

  const hasData = [snap.worker, snap.runtime].some((lane) =>
    lane.tickets > 0 || lane.dispatches > 0 || lane.ticketsDone > 0 || (lane.costTotalUsd ?? 0) > 0,
  );

  const rows = [
    {
      label: 'Cost/ticket',
      worker: formatUsd(snap.worker.costPerTicketUsd),
      runtime: formatUsd(snap.runtime.costPerTicketUsd),
    },
    {
      label: 'Total cost',
      worker: formatUsd(snap.worker.costTotalUsd),
      runtime: formatUsd(snap.runtime.costTotalUsd),
    },
    {
      label: 'Tickets',
      worker: String(snap.worker.tickets),
      runtime: String(snap.runtime.tickets),
    },
    {
      label: 'Done',
      worker: String(snap.worker.ticketsDone),
      runtime: String(snap.runtime.ticketsDone),
    },
    {
      label: 'Median time-to-done',
      worker: formatDurationMs(snap.worker.medianTimeToDoneMs),
      runtime: formatDurationMs(snap.runtime.medianTimeToDoneMs),
    },
    {
      label: 'Bounce rate',
      worker: formatPercent(snap.worker.bounceRate),
      runtime: formatPercent(snap.runtime.bounceRate),
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2.5 text-sm flex-wrap">
        <StatusDot ok={hasData} />
        <span className="font-medium text-[var(--text-primary)]">Worker vs runtime lanes</span>
        <div className="ml-auto flex items-center gap-2">
          <select
            value={windowDays}
            onChange={(e) => setWindowDays(parseInt(e.target.value, 10))}
            className="text-xs bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded px-1.5 py-0.5 text-[var(--text-secondary)]"
          >
            <option value={7}>7d</option>
            <option value={14}>14d</option>
            <option value={30}>30d</option>
          </select>
          <span className="text-xs text-[var(--text-muted)]">updated {relativeTime(snap.generatedAt)}</span>
        </div>
      </div>

      {!hasData ? (
        <p className="text-sm text-[var(--text-muted)]">No lane data yet</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[var(--text-muted)]">
                <th className="py-1 pr-3 font-medium">Metric</th>
                <th className="py-1 pr-3 font-medium">Worker lane</th>
                <th className="py-1 font-medium">Runtime lane</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label} className="border-t border-[var(--border-subtle)] text-[var(--text-secondary)]">
                  <td className="py-1 pr-3 text-[var(--text-primary)]">{row.label}</td>
                  <td className="py-1 pr-3 font-mono">{row.worker}</td>
                  <td className="py-1 font-mono">{row.runtime}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- Schedules panel (moved from /health, #1642 → #1651) ----------

function SchedulesPanel() {
  const [snap, setSnap] = useState<any>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch('/api/observability/schedules')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (!cancelled && d) setSnap(d); })
        .catch(() => {});
    load();
    const iv = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, []);
  if (!snap) return <p className="text-sm text-[var(--text-muted)]">Checking...</p>;

  const findings = snap.findings || [];
  const entries = snap.entries || [];
  const modelCallCount = snap.modelCallScheduleCount || 0;
  const costBadge = (c: string) =>
    c === 'model-call'
      ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
      : c === 'query'
        ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
        : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2.5 text-sm">
        <StatusDot ok={findings.length === 0 && modelCallCount === 0} />
        <span className="font-medium text-[var(--text-primary)]">
          {entries.length} schedules tracked
          {findings.length > 0 ? ` — ${findings.length} drift finding${findings.length > 1 ? 's' : ''}` : ' — no drift'}
        </span>
        {modelCallCount > 0 && (
          <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
            ⚠ {modelCallCount} scheduler-owned model-call schedule{modelCallCount > 1 ? 's' : ''} (#1633 expects 0)
          </span>
        )}
        {snap.operatorModelCallCrons > 0 && (
          <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
            {snap.operatorModelCallCrons} operator model-call cron{snap.operatorModelCallCrons > 1 ? 's' : ''}
          </span>
        )}
        {!snap.gatewayReachable && (
          <span className="text-xs text-amber-500">gateway unreachable — cron inventory incomplete</span>
        )}
        <button
          onClick={() => setExpanded((e) => !e)}
          className="ml-auto text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          {expanded ? 'collapse' : 'details'}
        </button>
      </div>

      {findings.length > 0 && (
        <div className="space-y-1.5">
          {findings.map((f: any) => (
            <div
              key={`${f.kind}-${f.scheduleId}`}
              className="px-3 py-2 rounded-[var(--radius-md)] bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-300"
            >
              <span className="font-semibold uppercase mr-1.5">{f.kind}</span>
              <span className="font-medium">{f.name}</span> — {f.explanation}
            </div>
          ))}
        </div>
      )}

      {expanded && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[var(--text-muted)]">
                <th className="py-1 pr-3 font-medium">Name</th>
                <th className="py-1 pr-3 font-medium">Source</th>
                <th className="py-1 pr-3 font-medium">Owner</th>
                <th className="py-1 pr-3 font-medium">Interval</th>
                <th className="py-1 pr-3 font-medium">Cost</th>
                <th className="py-1 pr-3 font-medium">Enabled</th>
                <th className="py-1 font-medium">Last fire</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e: any) => (
                <tr key={e.id} className="border-t border-[var(--border-subtle)] text-[var(--text-secondary)]">
                  <td className="py-1 pr-3 text-[var(--text-primary)]">{e.name}</td>
                  <td className="py-1 pr-3">{e.source}</td>
                  <td className="py-1 pr-3">{e.owner || '—'}</td>
                  <td className="py-1 pr-3">{e.intervalDescription}</td>
                  <td className="py-1 pr-3">
                    <span className={clsx('px-1.5 py-0.5 rounded font-medium', costBadge(e.costClass))}>
                      {e.costClass}
                    </span>
                  </td>
                  <td className="py-1 pr-3">{e.enabled ? '✓' : 'off'}</td>
                  <td className="py-1">{e.lastFire ? relativeTime(e.lastFire) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- page ----------

export default function SystemPage() {
  return (
    <div className="flex-1 overflow-auto bg-[var(--bg-primary)]">
      <div className="max-w-6xl mx-auto p-6 space-y-4">
        <div>
          <h1 className="text-3xl font-bold text-[var(--text-primary)]">📡 System</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">
            System observability — dispatch load, budgets, schedules, and anything that taxes the machine. Auto-refreshes every 60s.
          </p>
        </div>

        <Panel title="Dispatch & Budgets">
          <ObservabilityPanel />
        </Panel>

        <Panel title="Worker Lane Scorecard (#1661)">
          <WorkerScorecardPanel />
        </Panel>

        <Panel title="Schedules & Drift">
          <SchedulesPanel />
        </Panel>

        <Panel title="Skill Freshness">
          <SkillFreshnessSection />
        </Panel>
      </div>
    </div>
  );
}
