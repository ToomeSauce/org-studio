'use client';

import { useEffect, useState } from 'react';
import { clsx } from 'clsx';

// ---- Types ----
interface PactValue {
  slug: string;
  title: string;
  icon: string;
  letter: string;
  kudosCount: number;
  flagsCount: number;
  total: number;
  ratio: number;
}

interface AgentValueCounts {
  kudos: number;
  flags: number;
}

interface AgentBreakdown {
  agentId: string;
  values: Record<string, AgentValueCounts>;
  totalKudos: number;
  totalFlags: number;
}

interface TimelineWeek {
  week: string;
  kudos: number;
  flags: number;
  values: Record<string, number>;
}

interface Principle {
  text: string;
  type: 'strength' | 'opportunity' | 'concern' | 'trend';
}

interface CulturalAlignmentData {
  pactValues: PactValue[];
  agentBreakdown: AgentBreakdown[];
  timeline: TimelineWeek[];
  principles: Principle[];
  totals: { kudos: number; flags: number; total: number };
}

// ---- Color config ----
const VALUE_COLORS: Record<string, string> = {
  'people-first': '#f59e0b',
  'autonomy': 'var(--accent-primary)',
  'curiosity': '#3b82f6',
  'teamwork': '#22c55e',
};

const PRINCIPLE_META: Record<
  string,
  { icon: string; borderClass: string; bgClass: string }
> = {
  strength: { icon: '💪', borderClass: 'border-l-green-500', bgClass: 'bg-green-500/5' },
  opportunity: { icon: '🌱', borderClass: 'border-l-amber-500', bgClass: 'bg-amber-500/5' },
  concern: { icon: '⚠️', borderClass: 'border-l-red-500', bgClass: 'bg-red-500/5' },
  trend: { icon: '📈', borderClass: 'border-l-blue-500', bgClass: 'bg-blue-500/5' },
};

// ---- Helper: extract week label e.g. "2026-W13" → "W13" ----
function weekLabel(w: string): string {
  return w.split('-')[1] || w;
}

// ---- Sub-component: PACT Value Card ----
function PactValueCard({ pv }: { pv: PactValue }) {
  const barColor =
    pv.ratio >= 0.75 ? '#22c55e' : pv.ratio >= 0.5 ? '#f59e0b' : '#ef4444';
  return (
    <div className="relative bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-md)] p-4 flex flex-col gap-2 overflow-hidden">
      {/* Title */}
      <div className="flex items-center gap-2">
        <span className="text-xl">{pv.icon}</span>
        <span className="font-semibold text-[var(--text-primary)] text-sm">{pv.title}</span>
      </div>
      {/* Count */}
      {pv.total === 0 ? (
        <p className="text-[var(--text-muted)] text-xs">No signals yet</p>
      ) : (
        <>
          <p className="text-3xl font-bold text-[var(--text-primary)]">{pv.kudosCount}</p>
          <p className="text-xs text-[var(--text-secondary)]">
            {pv.kudosCount} kudos · {pv.flagsCount} flags
          </p>
        </>
      )}
      {/* Ratio bar */}
      <div className="absolute bottom-0 left-0 right-0 h-1 bg-[var(--bg-tertiary)]">
        <div
          className="h-full transition-all duration-500"
          style={{
            width: `${Math.round(pv.ratio * 100)}%`,
            backgroundColor: barColor,
          }}
        />
      </div>
    </div>
  );
}

// ---- Sub-component: Agent×Value Heatmap ----
function AgentHeatmap({
  breakdown,
  pactValues,
}: {
  breakdown: AgentBreakdown[];
  pactValues: PactValue[];
}) {
  const maxKudos = Math.max(
    ...breakdown.flatMap((a) =>
      Object.values(a.values).map((v) => v.kudos)
    ),
    1
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr>
            {/* Agent column */}
            <th className="text-left pb-2 pr-3 text-xs font-semibold text-[var(--text-muted)] w-28">
              Agent
            </th>
            {pactValues.map((pv) => (
              <th
                key={pv.slug}
                className="text-center pb-2 px-1 text-xs font-semibold text-[var(--text-muted)] min-w-[52px]"
              >
                <span>{pv.icon}</span>
                <span className="ml-0.5">{pv.letter}</span>
              </th>
            ))}
            <th className="text-right pb-2 pl-3 text-xs font-semibold text-[var(--text-muted)]">
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {breakdown.map((agent) => (
            <tr
              key={agent.agentId}
              className="border-t border-[var(--border-subtle)] hover:bg-[var(--bg-secondary)] transition-colors"
            >
              {/* Agent name */}
              <td className="py-2 pr-3 text-[var(--text-secondary)] font-medium whitespace-nowrap">
                {agent.agentId}
              </td>
              {/* Value cells */}
              {pactValues.map((pv) => {
                const cell = agent.values[pv.slug] || { kudos: 0, flags: 0 };
                const intensity = cell.kudos / maxKudos;
                const hasFlag = cell.flags > 0;
                return (
                  <td key={pv.slug} className="py-2 px-1 text-center">
                    <div className="relative inline-flex items-center justify-center w-10 h-8 rounded text-xs font-medium"
                      style={{
                        backgroundColor:
                          intensity > 0
                            ? `color-mix(in srgb, var(--accent-primary) ${Math.round(intensity * 70 + 15)}%, transparent)`
                            : 'transparent',
                        color: intensity > 0.5 ? '#fff' : 'var(--text-secondary)',
                      }}
                    >
                      {cell.kudos > 0 ? cell.kudos : (
                        <span className="text-[var(--text-muted)] opacity-30">·</span>
                      )}
                      {hasFlag && (
                        <span
                          className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-red-500"
                          title={`${cell.flags} flag${cell.flags > 1 ? 's' : ''}`}
                        />
                      )}
                    </div>
                  </td>
                );
              })}
              {/* Total */}
              <td className="py-2 pl-3 text-right text-[var(--text-secondary)] font-semibold">
                {agent.totalKudos}
                {agent.totalFlags > 0 && (
                  <span className="text-red-400 text-xs ml-1">+{agent.totalFlags}🚩</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- Sub-component: Timeline Bar Chart ----
function TimelineChart({
  timeline,
  pactValues,
}: {
  timeline: TimelineWeek[];
  pactValues: PactValue[];
}) {
  const [tooltip, setTooltip] = useState<{
    week: TimelineWeek;
    x: number;
    y: number;
  } | null>(null);

  if (timeline.length <= 1) {
    return (
      <p className="text-sm text-[var(--text-muted)] py-4">
        Not enough data for trend — check back once you have 2+ weeks of recognition.
      </p>
    );
  }

  const maxTotal = Math.max(...timeline.map((w) => w.kudos + w.flags), 1);

  return (
    <div className="relative">
      {/* Bars */}
      <div className="flex items-end gap-1 h-32">
        {timeline.map((week, i) => {
          const total = week.kudos + week.flags;
          const totalHeight = total > 0 ? (total / maxTotal) * 100 : 0;

          // Stack segments by value
          const segments: { slug: string; count: number; pct: number }[] = pactValues
            .map((pv) => ({
              slug: pv.slug,
              count: week.values[pv.slug] || 0,
              pct: total > 0 ? ((week.values[pv.slug] || 0) / total) * totalHeight : 0,
            }))
            .filter((s) => s.count > 0);

          return (
            <div
              key={week.week}
              className="flex-1 flex flex-col-reverse items-center group relative cursor-pointer"
              onMouseEnter={(e) => {
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setTooltip({ week, x: rect.left, y: rect.top });
              }}
              onMouseLeave={() => setTooltip(null)}
            >
              {/* Stacked bar */}
              <div
                className="w-full flex flex-col-reverse rounded-t overflow-hidden transition-all"
                style={{ height: `${Math.max(totalHeight, total > 0 ? 2 : 0)}%` }}
              >
                {segments.map((seg) => (
                  <div
                    key={seg.slug}
                    style={{
                      height: `${(seg.pct / totalHeight) * 100}%`,
                      backgroundColor: VALUE_COLORS[seg.slug] || '#888',
                      minHeight: seg.count > 0 ? 2 : 0,
                    }}
                  />
                ))}
                {segments.length === 0 && total > 0 && (
                  <div
                    style={{ height: '100%', backgroundColor: 'var(--accent-primary)' }}
                  />
                )}
              </div>
              {/* Tooltip */}
              {tooltip?.week.week === week.week && (
                <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded px-3 py-2 text-xs shadow-lg z-20 whitespace-nowrap min-w-[120px]">
                  <div className="font-semibold text-[var(--text-primary)] mb-1">{week.week}</div>
                  <div className="text-[var(--text-secondary)]">{week.kudos} kudos · {week.flags} flags</div>
                  {pactValues.map((pv) =>
                    (week.values[pv.slug] || 0) > 0 ? (
                      <div key={pv.slug} className="flex items-center gap-1 mt-0.5">
                        <span
                          className="w-2 h-2 rounded-sm inline-block"
                          style={{ backgroundColor: VALUE_COLORS[pv.slug] }}
                        />
                        <span className="text-[var(--text-muted)]">
                          {pv.title}: {week.values[pv.slug]}
                        </span>
                      </div>
                    ) : null
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {/* X-axis labels */}
      <div className="flex gap-1 mt-1">
        {timeline.map((week) => (
          <div key={week.week} className="flex-1 text-center">
            <span className="text-[10px] text-[var(--text-muted)]">{weekLabel(week.week)}</span>
          </div>
        ))}
      </div>
      {/* Legend */}
      <div className="flex flex-wrap gap-3 mt-3">
        {pactValues.map((pv) => (
          <div key={pv.slug} className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
            <span
              className="w-2.5 h-2.5 rounded-sm inline-block"
              style={{ backgroundColor: VALUE_COLORS[pv.slug] }}
            />
            {pv.title}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Sub-component: Operating Principles ----
function PrinciplesPanel({ principles }: { principles: Principle[] }) {
  return (
    <div className="space-y-2">
      {principles.map((p, i) => {
        const meta = PRINCIPLE_META[p.type] || PRINCIPLE_META.strength;
        return (
          <div
            key={i}
            className={clsx(
              'flex items-start gap-3 px-4 py-3 rounded-[var(--radius-md)] border-l-4',
              meta.borderClass,
              meta.bgClass,
              'bg-[var(--card)] border border-[var(--border-default)]'
            )}
          >
            <span className="text-base mt-0.5 shrink-0">{meta.icon}</span>
            <p className="text-sm text-[var(--text-secondary)] leading-relaxed">{p.text}</p>
          </div>
        );
      })}
    </div>
  );
}

// ---- Main Component ----
export default function CulturalAlignmentSection() {
  const [data, setData] = useState<CulturalAlignmentData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/metrics/cultural-alignment')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((err) => {
        console.error('[CulturalAlignment] fetch failed:', err);
        setError(err.message);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-10">
        <p className="text-[var(--text-muted)]">Loading cultural data...</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6 border border-[var(--border-default)] rounded-[var(--radius-md)] text-center">
        <p className="text-[var(--text-muted)] text-sm">No data available</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-xl font-bold text-[var(--text-primary)]">Cultural Alignment</h2>
        <p className="text-sm text-[var(--text-muted)] mt-0.5">
          PACT values recognition and operating principles
        </p>
      </div>

      {/* Panel 1: PACT Value Breakdown — 4 cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {data.pactValues.map((pv) => (
          <PactValueCard key={pv.slug} pv={pv} />
        ))}
      </div>

      {/* Panels 2 & 3 — 2-column on lg */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Panel 2: Agent × Value Heatmap */}
        <div className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-md)] p-5 space-y-3">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Agent × Value</h3>
          {data.agentBreakdown.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">No agent data yet.</p>
          ) : (
            <AgentHeatmap
              breakdown={data.agentBreakdown}
              pactValues={data.pactValues}
            />
          )}
        </div>

        {/* Panel 3: Timeline Chart */}
        <div className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-md)] p-5 space-y-3">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Weekly Trend</h3>
          <TimelineChart timeline={data.timeline} pactValues={data.pactValues} />
        </div>
      </div>

      {/* Panel 4: Operating Principles */}
      <div className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-md)] p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Operating Principles</h3>
          <span className="text-xs text-[var(--text-muted)]">
            {data.totals.kudos} kudos · {data.totals.flags} flags · {data.totals.total} total
          </span>
        </div>
        <PrinciplesPanel principles={data.principles} />
      </div>
    </div>
  );
}
