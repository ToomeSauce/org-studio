'use client';

/**
 * Notification Health dashboard (#1516 / #1513-followup-2).
 *
 * Live observability for the comment-notification dispatch path. Backed by
 * GET /api/admin/notification-health (admin-gated; sets Bearer from the user
 * via the admin-token input — same pattern as /api/admin/audit consumers).
 *
 * What it shows:
 *   - p50/p95 source_age_ms for delivered + skipped (latency cards)
 *   - hourly delivered-vs-skipped over the last N hours (bar pair)
 *   - skip-reason breakdown (dedup vs stale-superseded vs self/human)
 *   - last 50 audit rows (live feed)
 *
 * Refresh: button-driven + auto-poll every 30s when 'live' is on.
 * Admin auth: token stored in sessionStorage (cleared on tab close). Page is
 * usable by anyone with the admin Bearer; the API itself is the real gate.
 */
import { useEffect, useState, useCallback, useMemo } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { RefreshCw, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';

interface HealthData {
  ok: true;
  window: { hours: number; from: string; to: string };
  latency: {
    delivered: { p50_ms: number | null; p95_ms: number | null; count: number };
    skipped: { p50_ms: number | null; p95_ms: number | null; count: number };
  };
  hourly: { hour: string; delivered: number; skipped: number }[];
  skipReasons: { reason: string; count: number }[];
  recent: {
    id: string;
    occurred_at: string;
    comment_id: string;
    source_comment_created_at: string | null;
    recipient_agent_id: string;
    scope_kind: string;
    reason: string;
    outcome: string;
    skip_reason: string | null;
    source_age_ms: number | null;
  }[];
}

const TOKEN_KEY = 'org-studio-admin-token';

function fmtMs(v: number | null): string {
  if (v === null) return '—';
  if (v < 1000) return `${Math.round(v)}ms`;
  return `${(v / 1000).toFixed(1)}s`;
}

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  } catch {
    return iso;
  }
}

function fmtHour(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour: '2-digit', hour12: false });
  } catch {
    return iso;
  }
}

export default function NotificationHealthPage() {
  const [token, setToken] = useState('');
  const [hours, setHours] = useState(24);
  const [data, setData] = useState<HealthData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [live, setLive] = useState(false);
  const [lastFetched, setLastFetched] = useState<number | null>(null);

  // Restore token from sessionStorage on mount
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(TOKEN_KEY);
      if (saved) setToken(saved);
    } catch {
      /* sessionStorage unavailable */
    }
  }, []);

  const fetchData = useCallback(async () => {
    if (!token) {
      setError('Admin token required.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/notification-health?hours=${hours}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.message || json?.error || `HTTP ${res.status}`);
        setData(null);
      } else {
        setData(json as HealthData);
        setLastFetched(Date.now());
        try {
          sessionStorage.setItem(TOKEN_KEY, token);
        } catch {
          /* sessionStorage unavailable */
        }
      }
    } catch (e: any) {
      setError(e?.message || 'Network error');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [token, hours]);

  // Auto-poll when live
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => {
      void fetchData();
    }, 30_000);
    return () => clearInterval(id);
  }, [live, fetchData]);

  const maxHourly = useMemo(() => {
    if (!data) return 1;
    let m = 1;
    for (const h of data.hourly) {
      if (h.delivered + h.skipped > m) m = h.delivered + h.skipped;
    }
    return m;
  }, [data]);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <PageHeader
        title="Notification Health"
        description="Comment-notification dispatch observability (#1513 / #1516)"
      />

      {/* Controls */}
      <div className="mt-4 bg-zinc-900 border border-zinc-800 rounded-lg p-4 flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[260px]">
          <label className="block text-xs text-zinc-400 mb-1">Admin Bearer token (sessionStorage only)</label>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="ORG_STUDIO_ADMIN_API_KEY"
            className="w-full px-3 py-2 bg-zinc-950 border border-zinc-700 rounded text-sm font-mono"
          />
        </div>
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Window (hours)</label>
          <select
            value={hours}
            onChange={(e) => setHours(parseInt(e.target.value, 10))}
            className="px-3 py-2 bg-zinc-950 border border-zinc-700 rounded text-sm"
          >
            <option value={1}>1h</option>
            <option value={6}>6h</option>
            <option value={24}>24h</option>
            <option value={72}>72h</option>
            <option value={168}>7d</option>
          </select>
        </div>
        <button
          onClick={() => void fetchData()}
          disabled={loading || !token}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-400 rounded text-sm font-medium flex items-center gap-2"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={live}
            onChange={(e) => setLive(e.target.checked)}
            className="accent-blue-500"
          />
          Live (30s)
        </label>
        {lastFetched && (
          <span className="text-xs text-zinc-500">Updated {fmtTime(new Date(lastFetched).toISOString())}</span>
        )}
      </div>

      {error && (
        <div className="mt-4 bg-red-950/40 border border-red-800/60 rounded-lg p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
          <div>
            <div className="font-medium text-red-200">Error</div>
            <div className="text-sm text-red-300 mt-1">{error}</div>
          </div>
        </div>
      )}

      {!data && !error && !loading && (
        <div className="mt-6 text-center text-zinc-500 text-sm">
          Enter your admin Bearer token and click Refresh to load.
        </div>
      )}

      {data && (
        <>
          {/* Latency cards */}
          <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
            <LatencyCard
              title="Delivered"
              icon={<CheckCircle2 className="w-5 h-5 text-emerald-400" />}
              p50={data.latency.delivered.p50_ms}
              p95={data.latency.delivered.p95_ms}
              count={data.latency.delivered.count}
              accentClass="border-emerald-700/50"
            />
            <LatencyCard
              title="Skipped"
              icon={<XCircle className="w-5 h-5 text-amber-400" />}
              p50={data.latency.skipped.p50_ms}
              p95={data.latency.skipped.p95_ms}
              count={data.latency.skipped.count}
              accentClass="border-amber-700/50"
            />
          </div>

          {/* Hourly bars */}
          <div className="mt-6 bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3">
              Hourly throughput — last {data.window.hours}h
            </h3>
            <div className="flex items-end gap-1 h-32">
              {data.hourly.map((h) => {
                const total = h.delivered + h.skipped;
                const deliveredH = total === 0 ? 0 : Math.round((h.delivered / maxHourly) * 100);
                const skippedH = total === 0 ? 0 : Math.round((h.skipped / maxHourly) * 100);
                return (
                  <div
                    key={h.hour}
                    className="flex-1 flex flex-col justify-end items-center group relative min-w-[8px]"
                    title={`${fmtHour(h.hour)} — delivered ${h.delivered}, skipped ${h.skipped}`}
                  >
                    <div className="w-full flex flex-col justify-end h-full">
                      {skippedH > 0 && (
                        <div className="w-full bg-amber-500/70" style={{ height: `${skippedH}%` }} />
                      )}
                      {deliveredH > 0 && (
                        <div className="w-full bg-emerald-500/70" style={{ height: `${deliveredH}%` }} />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between text-xs text-zinc-500 mt-2">
              <span>{fmtHour(data.window.from)}</span>
              <div className="flex gap-3">
                <span className="flex items-center gap-1">
                  <span className="inline-block w-3 h-3 bg-emerald-500/70" /> delivered
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block w-3 h-3 bg-amber-500/70" /> skipped
                </span>
              </div>
              <span>{fmtHour(data.window.to)}</span>
            </div>
          </div>

          {/* Skip reasons */}
          <div className="mt-6 bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3">
              Skip reasons — last {data.window.hours}h
            </h3>
            {data.skipReasons.length === 0 ? (
              <div className="text-sm text-zinc-500">No skips recorded in this window.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-xs text-zinc-400 uppercase">
                  <tr>
                    <th className="text-left py-1.5">Reason</th>
                    <th className="text-right py-1.5">Count</th>
                  </tr>
                </thead>
                <tbody>
                  {data.skipReasons.map((s) => (
                    <tr key={s.reason} className="border-t border-zinc-800">
                      <td className="py-1.5 font-mono">{s.reason}</td>
                      <td className="py-1.5 text-right tabular-nums">{s.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Recent feed */}
          <div className="mt-6 bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3">Recent dispatches (last 50)</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-zinc-400 uppercase">
                  <tr>
                    <th className="text-left py-1.5 pr-3">Time</th>
                    <th className="text-left py-1.5 pr-3">Recipient</th>
                    <th className="text-left py-1.5 pr-3">Scope</th>
                    <th className="text-left py-1.5 pr-3">Reason</th>
                    <th className="text-left py-1.5 pr-3">Outcome</th>
                    <th className="text-left py-1.5 pr-3">Skip</th>
                    <th className="text-right py-1.5 pr-3">Age</th>
                    <th className="text-left py-1.5">Comment</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.map((r) => (
                    <tr key={r.id} className="border-t border-zinc-800 hover:bg-zinc-800/40">
                      <td className="py-1 pr-3 tabular-nums text-zinc-300">{fmtTime(r.occurred_at)}</td>
                      <td className="py-1 pr-3 font-mono">{r.recipient_agent_id}</td>
                      <td className="py-1 pr-3 text-zinc-400">{r.scope_kind}</td>
                      <td className="py-1 pr-3 text-zinc-400">{r.reason}</td>
                      <td className="py-1 pr-3">
                        <span
                          className={
                            r.outcome === 'delivered'
                              ? 'text-emerald-400'
                              : r.outcome === 'skipped'
                                ? 'text-amber-400'
                                : 'text-zinc-400'
                          }
                        >
                          {r.outcome}
                        </span>
                      </td>
                      <td className="py-1 pr-3 font-mono text-zinc-400">{r.skip_reason || '—'}</td>
                      <td className="py-1 pr-3 text-right tabular-nums text-zinc-300">
                        {fmtMs(r.source_age_ms)}
                      </td>
                      <td className="py-1 font-mono text-zinc-500 text-[10px]">{r.comment_id.slice(0, 12)}…</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function LatencyCard(props: {
  title: string;
  icon: React.ReactNode;
  p50: number | null;
  p95: number | null;
  count: number;
  accentClass: string;
}) {
  return (
    <div className={`bg-zinc-900 border rounded-lg p-4 ${props.accentClass}`}>
      <div className="flex items-center gap-2 mb-3">
        {props.icon}
        <h3 className="text-sm font-semibold text-zinc-200">{props.title}</h3>
        <span className="ml-auto text-xs text-zinc-500 tabular-nums">{props.count.toLocaleString()} events</span>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="text-xs text-zinc-500">p50 source-age</div>
          <div className="text-2xl font-bold tabular-nums mt-0.5">{fmtMs(props.p50)}</div>
        </div>
        <div>
          <div className="text-xs text-zinc-500">p95 source-age</div>
          <div className="text-2xl font-bold tabular-nums mt-0.5">{fmtMs(props.p95)}</div>
        </div>
      </div>
    </div>
  );
}
