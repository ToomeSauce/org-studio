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
