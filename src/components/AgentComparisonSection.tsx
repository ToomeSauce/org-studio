'use client';

import { useEffect, useState, useMemo } from 'react';
import { useWSData } from '@/lib/ws';
import { clsx } from 'clsx';

interface Sparklines {
  tasksCompleted: number[];
  throughput: number[];
  firstPassRate: number[];
}

interface AgentComparison {
  agentId: string;
  totalCompleted: number;
  totalStarted: number;
  avgDuration: number | null;
  avgChainRate: number | null;
  avgThroughput: number | null;
  avgFirstPass: number | null;
  totalBounces: number;
  totalStalls: number;
  totalComments: number;
  totalKudos: number;
  totalFlags: number;
  activeDays: number;
  sparklines: Sparklines;
}

interface Teammate {
  agentId?: string;
  name?: string;
  emoji?: string;
}

type SortColumn =
  | 'agentId'
  | 'totalCompleted'
  | 'totalStarted'
  | 'avgThroughput'
  | 'avgFirstPass'
  | 'totalBounces'
  | 'avgDuration'
  | 'totalComments'
  | 'activeDays';

type SortDirection = 'asc' | 'desc';

// ---------------------------------------------------------------------------
// SVG Sparkline
// ---------------------------------------------------------------------------
function Sparkline({
  data,
  color,
  width = 80,
  height = 24,
}: {
  data: number[];
  color: string;
  width?: number;
  height?: number;
}) {
  if (!data || data.length === 0) {
    // Flat grey line
    return (
      <svg width={width} height={height}>
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="#6b7280"
          strokeWidth={1.5}
          opacity={0.4}
        />
      </svg>
    );
  }

  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min === 0 ? 1 : max - min;

  const padding = 2;
  const chartH = height - padding * 2;

  const points = data.map((v, i) => {
    const x = data.length === 1 ? width / 2 : (i / (data.length - 1)) * width;
    const y = padding + chartH - ((v - min) / range) * chartH;
    return [x, y] as [number, number];
  });

  const lineD = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  // Fill path: line + close back along bottom
  const fillD =
    lineD +
    ` L${points[points.length - 1][0].toFixed(1)},${height} L${points[0][0].toFixed(1)},${height} Z`;

  return (
    <svg width={width} height={height} style={{ overflow: 'visible' }}>
      <path d={fillD} fill={color} fillOpacity={0.1} stroke="none" />
      <path d={lineD} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------
function fmtDuration(min: number | null): string {
  if (min == null) return '—';
  if (min < 60) return `${Math.round(min)}m`;
  return `${(min / 60).toFixed(1)}h`;
}

function fmtThroughput(v: number | null): string {
  if (v == null) return '—';
  return `${v.toFixed(1)}/hr`;
}

// ---------------------------------------------------------------------------
// Export to CSV
// ---------------------------------------------------------------------------
function exportCSV(agents: AgentComparison[], teammateMap: Record<string, Teammate>) {
  const headers = [
    'Agent',
    'Done',
    'Started',
    'Throughput',
    'First Pass %',
    'Bounces',
    'Avg Duration (min)',
    'Comments',
    'Active Days',
  ];

  const rows = agents.map((a) => {
    const tm = teammateMap[a.agentId];
    const name = tm?.name || a.agentId;
    const firstPassPct =
      a.avgFirstPass != null ? Math.round(a.avgFirstPass * 100).toString() : '';
    return [
      name,
      a.totalCompleted,
      a.totalStarted,
      a.avgThroughput?.toFixed(1) ?? '',
      firstPassPct,
      a.totalBounces,
      a.avgDuration?.toFixed(1) ?? '',
      a.totalComments,
      a.activeDays,
    ]
      .map((v) => `"${v}"`)
      .join(',');
  });

  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const today = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `agent-comparison-${today}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Column header component
// ---------------------------------------------------------------------------
function ColHeader({
  label,
  col,
  sortColumn,
  sortDirection,
  onSort,
  align = 'right',
  sortable = true,
}: {
  label: string;
  col: SortColumn | null;
  sortColumn: SortColumn;
  sortDirection: SortDirection;
  onSort: (c: SortColumn) => void;
  align?: 'left' | 'right';
  sortable?: boolean;
}) {
  const isActive = col !== null && sortColumn === col;
  const baseClass = clsx(
    'px-3 py-3 text-xs font-semibold text-[var(--text-muted)] select-none',
    align === 'right' ? 'text-right' : 'text-left',
    sortable && col !== null
      ? 'cursor-pointer hover:text-[var(--text-secondary)]'
      : ''
  );
  return (
    <th
      className={baseClass}
      onClick={sortable && col !== null ? () => onSort(col) : undefined}
    >
      {label}
      {isActive && (
        <span className="ml-1 text-[var(--accent-primary)]">
          {sortDirection === 'desc' ? '▼' : '▲'}
        </span>
      )}
    </th>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function AgentComparisonSection() {
  const storeData = useWSData<any>('store');
  const [agents, setAgents] = useState<AgentComparison[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortColumn, setSortColumn] = useState<SortColumn>('totalCompleted');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  useEffect(() => {
    fetch('/api/metrics/agent-comparison')
      .then((r) => r.json())
      .then((data) => {
        setAgents(data.agents || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const teammates: Teammate[] = storeData?.settings?.teammates || [];
  const teammateMap = useMemo(() => {
    const map: Record<string, Teammate> = {};
    for (const t of teammates) {
      if (t.agentId) map[t.agentId] = t;
    }
    return map;
  }, [teammates]);

  const handleSort = (col: SortColumn) => {
    if (sortColumn === col) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(col);
      setSortDirection('desc');
    }
  };

  const sorted = useMemo(() => {
    return [...agents].sort((a, b) => {
      const av = a[sortColumn] ?? -Infinity;
      const bv = b[sortColumn] ?? -Infinity;
      if (typeof av === 'string' && typeof bv === 'string') {
        return sortDirection === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      const an = av as number;
      const bn = bv as number;
      return sortDirection === 'asc' ? an - bn : bn - an;
    });
  }, [agents, sortColumn, sortDirection]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">Agent Comparison</h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            Side-by-side metrics with trends — click column headers to sort
          </p>
        </div>
        <button
          onClick={() => exportCSV(agents, teammateMap)}
          disabled={loading || agents.length === 0}
          className="px-3 py-1.5 text-xs font-medium bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Export CSV
        </button>
      </div>

      {loading ? (
        <div className="p-6 border border-[var(--border-default)] rounded-[var(--radius-md)] text-center">
          <p className="text-sm text-[var(--text-muted)]">Loading comparison data…</p>
        </div>
      ) : agents.length === 0 ? (
        <div className="p-6 border border-[var(--border-default)] rounded-[var(--radius-md)] text-center">
          <p className="text-sm text-[var(--text-muted)]">No data available yet.</p>
        </div>
      ) : (
        <div className="border border-[var(--border-default)] rounded-[var(--radius-md)] overflow-hidden overflow-x-auto">
          <table className="w-full text-sm min-w-max">
            <thead>
              <tr className="bg-[var(--bg-secondary)] border-b border-[var(--border-default)]">
                <ColHeader
                  label="Agent"
                  col="agentId"
                  sortColumn={sortColumn}
                  sortDirection={sortDirection}
                  onSort={handleSort}
                  align="left"
                />
                <ColHeader
                  label="Done"
                  col="totalCompleted"
                  sortColumn={sortColumn}
                  sortDirection={sortDirection}
                  onSort={handleSort}
                />
                <ColHeader
                  label="Started"
                  col="totalStarted"
                  sortColumn={sortColumn}
                  sortDirection={sortDirection}
                  onSort={handleSort}
                />
                <ColHeader
                  label="Throughput"
                  col="avgThroughput"
                  sortColumn={sortColumn}
                  sortDirection={sortDirection}
                  onSort={handleSort}
                />
                <ColHeader
                  label="First Pass"
                  col="avgFirstPass"
                  sortColumn={sortColumn}
                  sortDirection={sortDirection}
                  onSort={handleSort}
                />
                <ColHeader
                  label="Bounces"
                  col="totalBounces"
                  sortColumn={sortColumn}
                  sortDirection={sortDirection}
                  onSort={handleSort}
                />
                <ColHeader
                  label="Avg Duration"
                  col="avgDuration"
                  sortColumn={sortColumn}
                  sortDirection={sortDirection}
                  onSort={handleSort}
                />
                <ColHeader
                  label="Comments"
                  col="totalComments"
                  sortColumn={sortColumn}
                  sortDirection={sortDirection}
                  onSort={handleSort}
                />
                <ColHeader
                  label="Active Days"
                  col="activeDays"
                  sortColumn={sortColumn}
                  sortDirection={sortDirection}
                  onSort={handleSort}
                />
                {/* Non-sortable sparkline columns */}
                <th className="px-3 py-3 text-xs font-semibold text-[var(--text-muted)] text-center">
                  Completed Trend
                </th>
                <th className="px-3 py-3 text-xs font-semibold text-[var(--text-muted)] text-center">
                  Throughput Trend
                </th>
                <th className="px-3 py-3 text-xs font-semibold text-[var(--text-muted)] text-center">
                  First Pass Trend
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((agent) => {
                const tm = teammateMap[agent.agentId];
                const name = tm?.name || agent.agentId;
                const emoji = tm?.emoji || '🤖';

                const firstPassPct =
                  agent.avgFirstPass != null ? Math.round(agent.avgFirstPass * 100) : null;
                const firstPassColor =
                  firstPassPct == null
                    ? 'text-[var(--text-muted)]'
                    : firstPassPct >= 90
                    ? 'text-green-500'
                    : firstPassPct >= 70
                    ? 'text-amber-500'
                    : 'text-red-500';

                return (
                  <tr
                    key={agent.agentId}
                    className="border-b border-[var(--border-subtle)] hover:bg-[var(--bg-secondary)] transition-colors last:border-b-0"
                  >
                    {/* Agent */}
                    <td className="px-3 py-3 text-left">
                      <span className="flex items-center gap-2">
                        <span className="text-lg leading-none">{emoji}</span>
                        <span className="font-medium text-[var(--text-primary)]">{name}</span>
                      </span>
                    </td>
                    {/* Done */}
                    <td className="px-3 py-3 text-right tabular-nums text-[var(--text-secondary)]">
                      {agent.totalCompleted}
                    </td>
                    {/* Started */}
                    <td className="px-3 py-3 text-right tabular-nums text-[var(--text-secondary)]">
                      {agent.totalStarted}
                    </td>
                    {/* Throughput */}
                    <td className="px-3 py-3 text-right tabular-nums text-[var(--text-secondary)]">
                      {fmtThroughput(agent.avgThroughput)}
                    </td>
                    {/* First Pass */}
                    <td className={clsx('px-3 py-3 text-right tabular-nums font-medium', firstPassColor)}>
                      {firstPassPct != null ? `${firstPassPct}%` : '—'}
                    </td>
                    {/* Bounces */}
                    <td
                      className={clsx(
                        'px-3 py-3 text-right tabular-nums',
                        agent.totalBounces > 0 ? 'text-amber-500' : 'text-[var(--text-secondary)]'
                      )}
                    >
                      {agent.totalBounces}
                    </td>
                    {/* Avg Duration */}
                    <td className="px-3 py-3 text-right tabular-nums text-[var(--text-secondary)]">
                      {fmtDuration(agent.avgDuration)}
                    </td>
                    {/* Comments */}
                    <td className="px-3 py-3 text-right tabular-nums text-[var(--text-secondary)]">
                      {agent.totalComments}
                    </td>
                    {/* Active Days */}
                    <td className="px-3 py-3 text-right tabular-nums text-[var(--text-secondary)]">
                      {agent.activeDays}
                    </td>
                    {/* Completed Trend */}
                    <td className="px-3 py-3 text-center">
                      <Sparkline data={agent.sparklines.tasksCompleted} color="var(--accent-primary)" />
                    </td>
                    {/* Throughput Trend */}
                    <td className="px-3 py-3 text-center">
                      <Sparkline data={agent.sparklines.throughput} color="#22c55e" />
                    </td>
                    {/* First Pass Trend */}
                    <td className="px-3 py-3 text-center">
                      <Sparkline data={agent.sparklines.firstPassRate} color="#3b82f6" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
