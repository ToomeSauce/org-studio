'use client';

/**
 * CostAnalyticsSection — #1644 (T4) token/cost rollup panel on /performance.
 *
 * Renders GET /api/observability/costs: totals, cost by agent, model table
 * (with cache hit rate), trigger-source + project attribution, daily trend,
 * and week-over-week anomaly chips. Unmetered work (non-reporting runtimes)
 * is counted but excluded from cost sums, and called out explicitly.
 */

import { useEffect, useState } from 'react';
import { clsx } from 'clsx';

interface Bucket {
  key: string;
  calls: number;
  meteredCalls: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
}

interface CostData {
  windowDays: number;
  totals: Bucket & {
    unmeteredCalls: number;
    cacheReadTokens: number;
    cacheHitRate: number | null;
    dispatches: number;
    unmeteredDispatches: number;
  };
  byAgent: Bucket[];
  byModel: Array<Bucket & { cacheHitRate: number | null }>;
  bySource: Bucket[];
  byProject: Array<Bucket & { projectName: string | null }>;
  byTicketType: Bucket[];
  trend: Array<{ day: string; calls: number; tokensIn: number; tokensOut: number; cost: number }>;
  anomalies: Array<{
    agentId: string;
    currentAvgCost: number;
    priorAvgCost: number;
    ratio: number;
    direction: 'up' | 'down';
  }>;
  queryMs: number;
}

const WINDOWS = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
];

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtCost(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

export default function CostAnalyticsSection() {
  const [data, setData] = useState<CostData | null>(null);
  const [windowDays, setWindowDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/observability/costs?windowDays=${windowDays}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e?.message || 'Failed to load'))
      .finally(() => setLoading(false));
  }, [windowDays]);

  const maxAgentCost = Math.max(0.0001, ...(data?.byAgent || []).map((a) => a.cost));

  return (
    <section className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-5 space-y-4 shadow-[var(--shadow-sm),inset_0_1px_0_var(--card-highlight)]">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">
            Token & Cost Analytics
          </h2>
          <p className="text-[var(--text-xs)] text-[var(--text-tertiary)] mt-0.5">
            Model usage attributed to the served model. Unmetered work is counted but excluded from cost sums.
          </p>
        </div>
        <div className="flex gap-1">
          {WINDOWS.map((w) => (
            <button
              key={w.days}
              onClick={() => setWindowDays(w.days)}
              className={clsx(
                'px-2.5 py-1 min-h-[36px] rounded-[var(--radius-md)] text-[var(--text-xs)] font-medium border transition-all',
                windowDays === w.days
                  ? 'bg-[var(--accent-primary)] text-white border-[var(--accent-primary)]'
                  : 'bg-[var(--bg-primary)] text-[var(--text-secondary)] border-[var(--border-default)] hover:text-[var(--text-primary)]',
              )}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p className="text-[var(--text-xs)] text-[var(--text-muted)]">Loading cost data…</p>
      ) : error ? (
        <p className="text-[var(--text-xs)] text-[var(--text-muted)]">
          Cost analytics unavailable ({error}).
        </p>
      ) : !data || data.totals.calls === 0 ? (
        <div className="px-4 py-6 rounded-[var(--radius-md)] bg-[var(--bg-primary)] border border-[var(--border-subtle)] text-center">
          <p className="text-[var(--text-sm)] text-[var(--text-secondary)]">No model-call data in this window yet.</p>
          <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-1">
            Token capture began with the dispatch ledger (#1641) — data accrues as agents complete dispatched turns.
            {data && data.totals.dispatches > 0 && (
              <> {data.totals.dispatches} dispatch(es) recorded, {data.totals.unmeteredDispatches} unmetered.</>
            )}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Anomaly chips */}
          {data.anomalies.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {data.anomalies.map((a) => (
                <span
                  key={a.agentId}
                  className={clsx(
                    'px-2 py-1 rounded-[var(--radius-md)] text-[var(--text-xs)] font-medium border',
                    a.direction === 'up'
                      ? 'bg-[color-mix(in_srgb,var(--error)_10%,transparent)] text-[var(--error)] border-[color-mix(in_srgb,var(--error)_30%,var(--border-default))]'
                      : 'bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] text-[var(--warning)] border-[color-mix(in_srgb,var(--warning)_30%,var(--border-default))]',
                  )}
                  title={`avg cost/dispatch: ${fmtCost(a.priorAvgCost)} → ${fmtCost(a.currentAvgCost)} week-over-week`}
                >
                  {a.direction === 'up' ? '▲' : '▼'} {a.agentId} {a.ratio}x
                </span>
              ))}
            </div>
          )}

          {/* Totals */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="px-3 py-2.5 rounded-[var(--radius-md)] bg-[var(--bg-primary)] border border-[var(--border-subtle)]">
              <p className="text-[var(--text-xs)] text-[var(--text-tertiary)]">Est. cost</p>
              <p className="text-[var(--text-lg)] font-semibold text-[var(--text-primary)]">{fmtCost(data.totals.cost)}</p>
            </div>
            <div className="px-3 py-2.5 rounded-[var(--radius-md)] bg-[var(--bg-primary)] border border-[var(--border-subtle)]">
              <p className="text-[var(--text-xs)] text-[var(--text-tertiary)]">Tokens in / out</p>
              <p className="text-[var(--text-lg)] font-semibold text-[var(--text-primary)]">
                {fmtTokens(data.totals.tokensIn)} / {fmtTokens(data.totals.tokensOut)}
              </p>
            </div>
            <div className="px-3 py-2.5 rounded-[var(--radius-md)] bg-[var(--bg-primary)] border border-[var(--border-subtle)]">
              <p className="text-[var(--text-xs)] text-[var(--text-tertiary)]">Cache hit rate</p>
              <p className="text-[var(--text-lg)] font-semibold text-[var(--text-primary)]">
                {data.totals.cacheHitRate != null ? `${Math.round(data.totals.cacheHitRate * 100)}%` : '—'}
              </p>
            </div>
            <div className="px-3 py-2.5 rounded-[var(--radius-md)] bg-[var(--bg-primary)] border border-[var(--border-subtle)]">
              <p className="text-[var(--text-xs)] text-[var(--text-tertiary)]">Unmetered</p>
              <p className="text-[var(--text-lg)] font-semibold text-[var(--text-primary)]">
                {data.totals.unmeteredCalls} <span className="text-[var(--text-xs)] font-normal text-[var(--text-muted)]">calls</span>
              </p>
              {data.totals.unmeteredDispatches > 0 && (
                <p className="text-[10px] text-[var(--text-muted)]">+{data.totals.unmeteredDispatches} dispatches w/o usage</p>
              )}
            </div>
          </div>

          {/* Cost by agent (bars) */}
          {data.byAgent.length > 0 && (
            <div>
              <h3 className="text-[var(--text-xs)] font-medium text-[var(--text-secondary)] mb-2">Cost by agent</h3>
              <div className="space-y-1.5">
                {data.byAgent.slice(0, 10).map((a) => (
                  <div key={a.key} className="flex items-center gap-2">
                    <span className="w-20 shrink-0 text-[var(--text-xs)] text-[var(--text-secondary)] truncate">{a.key}</span>
                    <div className="flex-1 h-4 bg-[var(--bg-primary)] rounded overflow-hidden">
                      <div
                        className="h-full bg-[var(--accent-primary)] opacity-70 rounded"
                        style={{ width: `${Math.max(2, (a.cost / maxAgentCost) * 100)}%` }}
                      />
                    </div>
                    <span className="w-16 shrink-0 text-right text-[var(--text-xs)] font-mono text-[var(--text-secondary)]">{fmtCost(a.cost)}</span>
                    <span className="w-14 shrink-0 text-right text-[10px] text-[var(--text-muted)]">{fmtTokens(a.tokensIn + a.tokensOut)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Model table */}
          {data.byModel.length > 0 && (
            <div>
              <h3 className="text-[var(--text-xs)] font-medium text-[var(--text-secondary)] mb-2">By served model</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-[var(--text-xs)]">
                  <thead>
                    <tr className="text-left text-[var(--text-muted)]">
                      <th className="pb-1 pr-3 font-medium">Model</th>
                      <th className="pb-1 pr-3 font-medium text-right">Calls</th>
                      <th className="pb-1 pr-3 font-medium text-right">Tokens in</th>
                      <th className="pb-1 pr-3 font-medium text-right">Tokens out</th>
                      <th className="pb-1 pr-3 font-medium text-right">Cache hit</th>
                      <th className="pb-1 font-medium text-right">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byModel.map((m) => (
                      <tr key={m.key} className="border-t border-[var(--border-subtle)] text-[var(--text-secondary)]">
                        <td className="py-1.5 pr-3 font-mono truncate max-w-[200px]" title={m.key}>{m.key}</td>
                        <td className="py-1.5 pr-3 text-right">
                          {m.calls}
                          {m.meteredCalls < m.calls && (
                            <span className="text-[var(--text-muted)]" title={`${m.calls - m.meteredCalls} unmetered`}> ({m.calls - m.meteredCalls}u)</span>
                          )}
                        </td>
                        <td className="py-1.5 pr-3 text-right font-mono">{fmtTokens(m.tokensIn)}</td>
                        <td className="py-1.5 pr-3 text-right font-mono">{fmtTokens(m.tokensOut)}</td>
                        <td className="py-1.5 pr-3 text-right">{m.cacheHitRate != null ? `${Math.round(m.cacheHitRate * 100)}%` : '—'}</td>
                        <td className="py-1.5 text-right font-mono">{fmtCost(m.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Source + project split */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {data.bySource.length > 0 && (
              <div>
                <h3 className="text-[var(--text-xs)] font-medium text-[var(--text-secondary)] mb-2">By trigger source</h3>
                <div className="space-y-1">
                  {data.bySource.map((s) => (
                    <div key={s.key} className="flex justify-between text-[var(--text-xs)] text-[var(--text-secondary)]">
                      <span className="font-mono">{s.key}</span>
                      <span className="font-mono">{fmtCost(s.cost)} · {s.calls} calls</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {data.byProject.length > 0 && (
              <div>
                <h3 className="text-[var(--text-xs)] font-medium text-[var(--text-secondary)] mb-2">By project</h3>
                <div className="space-y-1">
                  {data.byProject.slice(0, 8).map((p) => (
                    <div key={p.key} className="flex justify-between text-[var(--text-xs)] text-[var(--text-secondary)]">
                      <span className="truncate max-w-[160px]" title={p.key}>{p.projectName || p.key}</span>
                      <span className="font-mono">{fmtCost(p.cost)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Trend sparkline (simple bar strip) */}
          {data.trend.length > 1 && (
            <div>
              <h3 className="text-[var(--text-xs)] font-medium text-[var(--text-secondary)] mb-2">Daily cost trend</h3>
              <div className="flex items-end gap-[2px] h-12">
                {data.trend.map((t) => {
                  const maxCost = Math.max(0.0001, ...data.trend.map((x) => x.cost));
                  return (
                    <div
                      key={t.day}
                      className="flex-1 bg-[var(--accent-primary)] opacity-60 rounded-t min-w-[3px]"
                      style={{ height: `${Math.max(4, (t.cost / maxCost) * 100)}%` }}
                      title={`${t.day}: ${fmtCost(t.cost)} · ${t.calls} calls`}
                    />
                  );
                })}
              </div>
            </div>
          )}

          <p className="text-[10px] text-[var(--text-muted)]">
            Window: {data.windowDays}d · query {data.queryMs}ms · cost attributed to served model (never requested)
          </p>
        </div>
      )}
    </section>
  );
}
