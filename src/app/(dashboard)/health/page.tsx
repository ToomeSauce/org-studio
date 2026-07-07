'use client';

import { useEffect, useState, useCallback } from 'react';
import { useWSConnected } from '@/lib/ws';
import { clsx } from 'clsx';
import Link from 'next/link';

// ---------- types ----------

interface RuntimeInfo {
  id: string;
  name: string;
  connected: boolean;
  detail: string | null;
}

interface StuckAgent {
  agentId: string;
  loopId: string | null;
  lastHeartbeat: string;
  minutesStale: number;
}

interface StuckTask {
  id: string;
  title: string;
  assignee: string | null;
  status: string;
  minutesInStatus: number;
  projectId: string | null;
  projectName: string | null;
}

interface Incident {
  id: string;
  timestamp: string;
  type: string;
  agentId: string;
  message: string;
  context: any;
}

interface HealthData {
  runtimes: RuntimeInfo[];
  gateway: null; // handled client-side
  listen: { healthy: boolean; detail?: string };
  stuckAgents: StuckAgent[];
  stuckTasks: StuckTask[];
  incidents: Incident[];
  now: number;
  degradedMode?: string;
}

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

function formatTimestamp(ts: string | number): string {
  return new Date(ts).toLocaleString();
}

const TYPE_COLORS: Record<string, string> = {
  watchdog_restart: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
  outbox_dead_letter: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
  gateway_disconnect: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400',
  listen_stale: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400',
  dead_letter_backlog: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-400',
  stuck_task: 'bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-400',
};

function typeBadgeClass(type: string): string {
  return TYPE_COLORS[type] || 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
}

// ---------- components ----------

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={clsx(
        'inline-block w-2.5 h-2.5 rounded-full shrink-0',
        ok ? 'bg-green-500' : 'bg-red-500',
      )}
    />
  );
}

function Panel({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        'border border-[var(--border-default)] rounded-[var(--radius-md)] bg-[var(--card)] overflow-hidden',
        className,
      )}
    >
      <div className="px-4 py-3 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h2>
      </div>
      <div className="px-4 py-3">{children}</div>
    </div>
  );
}

function StaleLabel({ minutes }: { minutes: number }) {
  const color =
    minutes > 60
      ? 'text-red-500'
      : minutes > 15
        ? 'text-amber-500'
        : 'text-[var(--text-secondary)]';
  return <span className={clsx('font-medium tabular-nums', color)}>{minutes}m</span>;
}

function RoadmapReconcileStatus() {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch('/api/health/roadmap')
        .then((r) => r.json())
        .then((d) => { if (!cancelled) setData(d); })
        .catch(() => {});
    load();
    const iv = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, []);

  if (!data) {
    return <p className="text-sm text-[var(--text-muted)]">Checking…</p>;
  }
  if (!data.enabled) {
    return (
      <div className="flex items-center gap-2.5 text-sm">
        <StatusDot ok={false} />
        <span className="font-medium text-[var(--text-primary)]">Not initialized</span>
        {data.detail && <span className="text-[var(--text-muted)]">— {data.detail}</span>}
      </div>
    );
  }

  const last = data.last;
  const intervalMin = Math.round((data.intervalMs || 0) / 60_000);

  if (!last) {
    return (
      <div className="space-y-1.5 text-sm">
        <div className="flex items-center gap-2.5">
          <StatusDot ok={true} />
          <span className="font-medium text-[var(--text-primary)]">Pending first run</span>
        </div>
        <p className="text-xs text-[var(--text-muted)]">
          Cron interval: {intervalMin}min. Awaiting startup reconcile (~30s after boot).
        </p>
      </div>
    );
  }

  const s = last.summary;
  const changed = s ? (s.flipped || 0) + (s.shipped || 0) + (s.advanced || 0) : 0;
  return (
    <div className="space-y-1.5 text-sm">
      <div className="flex items-center gap-2.5">
        <StatusDot ok={last.ok} />
        <span className="font-medium text-[var(--text-primary)]">
          {last.ok ? (changed > 0 ? 'Drift corrected' : 'Clean') : 'Errored'}
        </span>
        <span className="text-[var(--text-muted)]">
          — last run {relativeTime(last.finishedAt)} ({last.trigger}, {last.durationMs}ms)
        </span>
      </div>
      {s ? (
        <div className="text-xs text-[var(--text-muted)] tabular-nums">
          scanned {s.scanned} · flipped {s.flipped} · shipped {s.shipped} · advanced {s.advanced}
          {s.skippedAdvance > 0 ? ` · skipped ${s.skippedAdvance}` : ''}
        </div>
      ) : last.error ? (
        <div className="text-xs text-red-500">{last.error}</div>
      ) : null}
      <div className="text-xs text-[var(--text-muted)]">
        Cron interval: {intervalMin}min · history: {data.history?.length || 0} runs
      </div>
    </div>
  );
}

function PubSubStatus() {
  const [ps, setPs] = useState<any>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => fetch('/api/health/pubsub').then(r => r.json()).then(d => { if (!cancelled) setPs(d); }).catch(() => {});
    load();
    const iv = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, []);
  if (!ps) return null;
  const connected = ps.connected && !ps.stale;
  return (
    <div className="flex items-center gap-2.5 text-sm">
      <StatusDot ok={connected} />
      <span className="font-medium text-[var(--text-primary)]">
        PubSub {connected ? 'Connected' : ps.stale ? 'Stale' : 'Disconnected'}
      </span>
      <span className="text-[var(--text-muted)]">
        {ps.lastHeartbeatAt ? `— last heartbeat ${relativeTime(ps.lastHeartbeatAt)}` : '— no heartbeat yet'}
        {ps.reconnectCount > 0 ? ` · ${ps.reconnectCount} reconnect${ps.reconnectCount > 1 ? 's' : ''}` : ''}
      </span>
    </div>
  );
}

// #1642 — Schedules panel: unified inventory + drift findings.
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

// #1650 — Observability panel: dispatch ledger + breaker/budget + failure counters (#1641/#1643).
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

// ---------- page ----------

export default function HealthPage() {
  const [data, setData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastFetch, setLastFetch] = useState<number | null>(null);
  const [expandedIncident, setExpandedIncident] = useState<string | null>(null);
  const wsConnected = useWSConnected();

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch('/api/health');
      if (res.ok) {
        const json: HealthData = await res.json();
        setData(json);
        setLastFetch(Date.now());
      }
    } catch {
      // swallow
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHealth();
    const timer = setInterval(fetchHealth, 30000);
    return () => clearInterval(timer);
  }, [fetchHealth]);

  if (loading && !data) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-[var(--text-muted)]">Loading health data...</div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto bg-[var(--bg-primary)]">
      <div className="max-w-6xl mx-auto p-6 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-[var(--text-primary)]">🩺 System Health</h1>
            <p className="text-sm text-[var(--text-muted)] mt-1">
              Real-time operational status — auto-refreshes every 30s
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
            {lastFetch && <span>Updated {relativeTime(lastFetch)}</span>}
            <button
              onClick={fetchHealth}
              className="px-2.5 py-1 rounded-[var(--radius-md)] border border-[var(--border-default)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] transition-colors"
            >
              ↻ Refresh
            </button>
          </div>
        </div>

        {/* Degraded mode banner */}
        {data?.degradedMode && (
          <div className="px-4 py-3 rounded-[var(--radius-md)] bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300 text-sm">
            ⚠️ Running in <strong>file mode</strong> — database-backed panels (stuck agents, incidents) are unavailable.
          </div>
        )}

        {/* ── 1. Runtimes ── */}
        <Panel title="Runtimes">
          {!data?.runtimes?.length ? (
            <p className="text-sm text-[var(--text-muted)]">No runtimes configured.</p>
          ) : (
            <div className="flex flex-wrap gap-4">
              {data.runtimes.map((rt) => (
                <div key={rt.id} className="flex items-center gap-2.5 text-sm">
                  <StatusDot ok={rt.connected} />
                  <span className="font-medium text-[var(--text-primary)]">{rt.name}</span>
                  <span className="text-[var(--text-muted)]">
                    {rt.connected ? 'Connected' : 'Disconnected'}
                    {rt.detail ? ` — ${rt.detail}` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Panel>

        {/* ── 2. Gateway WS ── */}
        <Panel title="Gateway WebSocket">
          <div className="flex items-center gap-2.5 text-sm">
            <StatusDot ok={wsConnected} />
            <span className="font-medium text-[var(--text-primary)]">
              {wsConnected ? 'Connected' : 'Disconnected'}
            </span>
            <span className="text-[var(--text-muted)]">
              (browser → Gateway WS)
            </span>
          </div>
        </Panel>

        {/* ── 3. Postgres LISTEN ── */}
        <Panel title="Postgres LISTEN">
          {data ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2.5 text-sm">
                <StatusDot ok={data.listen.healthy} />
                <span className="font-medium text-[var(--text-primary)]">
                  {data.listen.healthy ? 'Healthy' : 'Unhealthy'}
                </span>
                {data.listen.detail && (
                  <span className="text-[var(--text-muted)]">— {data.listen.detail}</span>
                )}
              </div>
              <PubSubStatus />
            </div>
          ) : (
            <p className="text-sm text-[var(--text-muted)]">Checking...</p>
          )}
        </Panel>

        {/* ── 3b. Roadmap Reconcile (#982) ── */}
        <Panel title="Roadmap Reconcile">
          <RoadmapReconcileStatus />
        </Panel>

        {/* ── 3c. Schedules (#1642) ── */}
        <Panel title="Schedules">
          <SchedulesPanel />
        </Panel>

        {/* ── 3d. Observability (#1650: dispatch ledger #1641 + breaker #1643) ── */}
        <Panel title="Observability">
          <ObservabilityPanel />
        </Panel>

        {/* ── 4. Stuck Agents ── */}
        <Panel title="Stuck Agents" className="min-h-[120px]">
          {!data?.stuckAgents?.length ? (
            <p className="text-sm text-[var(--text-muted)]">
              No stuck agents — all systems nominal ✅
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--border-subtle)]">
                    <th className="text-left py-2 pr-4 text-xs font-semibold text-[var(--text-muted)]">Agent</th>
                    <th className="text-left py-2 pr-4 text-xs font-semibold text-[var(--text-muted)]">Loop</th>
                    <th className="text-left py-2 pr-4 text-xs font-semibold text-[var(--text-muted)]">Last Heartbeat</th>
                    <th className="text-right py-2 text-xs font-semibold text-[var(--text-muted)]">Stale</th>
                  </tr>
                </thead>
                <tbody>
                  {data.stuckAgents.map((a) => (
                    <tr key={a.agentId} className="border-b border-[var(--border-subtle)] last:border-0">
                      <td className="py-2 pr-4 text-[var(--text-primary)] font-medium">{a.agentId}</td>
                      <td className="py-2 pr-4 text-[var(--text-secondary)] font-mono text-xs">{a.loopId || '—'}</td>
                      <td className="py-2 pr-4 text-[var(--text-secondary)]" title={formatTimestamp(a.lastHeartbeat)}>
                        {relativeTime(a.lastHeartbeat)}
                      </td>
                      <td className="py-2 text-right">
                        <StaleLabel minutes={a.minutesStale} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* ── 5. Stuck Tasks ── */}
        <Panel title="Stuck Tasks" className="min-h-[120px]">
          {!data?.stuckTasks?.length ? (
            <p className="text-sm text-[var(--text-muted)]">
              No stuck tasks — all work flowing ✅
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--border-subtle)]">
                    <th className="text-left py-2 pr-4 text-xs font-semibold text-[var(--text-muted)]">Task</th>
                    <th className="text-left py-2 pr-4 text-xs font-semibold text-[var(--text-muted)]">Project</th>
                    <th className="text-left py-2 pr-4 text-xs font-semibold text-[var(--text-muted)]">Assignee</th>
                    <th className="text-right py-2 text-xs font-semibold text-[var(--text-muted)]">In Progress</th>
                  </tr>
                </thead>
                <tbody>
                  {data.stuckTasks.map((t) => (
                    <tr key={t.id} className="border-b border-[var(--border-subtle)] last:border-0">
                      <td className="py-2 pr-4 text-[var(--text-primary)]">
                        <Link
                          href={`/context?task=${t.id}`}
                          className="font-medium hover:text-[var(--accent-primary)] hover:underline transition-colors"
                        >
                          {t.title}
                        </Link>
                      </td>
                      <td className="py-2 pr-4 text-[var(--text-secondary)]">{t.projectName || '—'}</td>
                      <td className="py-2 pr-4 text-[var(--text-secondary)]">{t.assignee || '—'}</td>
                      <td className="py-2 text-right">
                        <StaleLabel minutes={t.minutesInStatus} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* ── 6. Recent Incidents ── */}
        <Panel title="Recent Incidents" className="min-h-[160px]">
          {!data?.incidents?.length ? (
            <p className="text-sm text-[var(--text-muted)]">
              No incidents recorded yet 🎉
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--border-subtle)]">
                    <th className="text-left py-2 pr-4 text-xs font-semibold text-[var(--text-muted)]">Time</th>
                    <th className="text-left py-2 pr-4 text-xs font-semibold text-[var(--text-muted)]">Type</th>
                    <th className="text-left py-2 pr-4 text-xs font-semibold text-[var(--text-muted)]">Agent</th>
                    <th className="text-left py-2 text-xs font-semibold text-[var(--text-muted)]">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {data.incidents.map((inc) => {
                    const isExpanded = expandedIncident === inc.id;
                    const msgTruncated =
                      inc.message && inc.message.length > 120
                        ? inc.message.slice(0, 120) + '…'
                        : inc.message;

                    return (
                      <tr
                        key={inc.id}
                        className="border-b border-[var(--border-subtle)] last:border-0 hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
                        onClick={() => setExpandedIncident(isExpanded ? null : inc.id)}
                      >
                        <td
                          className="py-2 pr-4 text-[var(--text-secondary)] whitespace-nowrap"
                          title={formatTimestamp(inc.timestamp)}
                        >
                          {relativeTime(inc.timestamp)}
                        </td>
                        <td className="py-2 pr-4">
                          <span
                            className={clsx(
                              'inline-block px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap',
                              typeBadgeClass(inc.type),
                            )}
                          >
                            {inc.type}
                          </span>
                        </td>
                        <td className="py-2 pr-4 text-[var(--text-secondary)] whitespace-nowrap">
                          {inc.agentId || '—'}
                        </td>
                        <td className="py-2 text-[var(--text-primary)]">
                          {isExpanded ? (
                            <div className="space-y-2">
                              <div>{inc.message}</div>
                              {inc.context && (
                                <pre className="text-xs bg-[var(--bg-secondary)] p-2 rounded-[var(--radius-md)] overflow-x-auto text-[var(--text-muted)]">
                                  {JSON.stringify(inc.context, null, 2)}
                                </pre>
                              )}
                            </div>
                          ) : (
                            <span title={inc.message}>{msgTruncated}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
