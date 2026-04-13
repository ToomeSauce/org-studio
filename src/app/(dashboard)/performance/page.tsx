'use client';

import { useEffect, useState, useMemo } from 'react';
import { useWSData } from '@/lib/ws';
import { clsx } from 'clsx';

interface Teammate {
  agentId?: string;
  name?: string;
  emoji?: string;
  domain?: string;
}

interface AgentMetrics {
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
}

export default function PerformancePage() {
  const storeData = useWSData<any>('store');
  const [teamMetrics, setTeamMetrics] = useState<AgentMetrics[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/metrics/team')
      .then(res => res.json())
      .then(data => {
        setTeamMetrics(data.metrics || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const teammates: Teammate[] = storeData?.settings?.teammates || [];

  const teammateMap = useMemo(() => {
    const map: Record<string, Teammate> = {};
    for (const t of teammates) {
      if (t.agentId) map[t.agentId] = t;
      if (t.name) map[t.name.toLowerCase()] = t;
    }
    return map;
  }, [teammates]);

  // Team totals
  const totals = useMemo(() => {
    const totalCompleted = teamMetrics.reduce((sum, m) => sum + m.totalCompleted, 0);
    const totalDays = teamMetrics.reduce((sum, m) => sum + m.activeDays, 0);
    const metricsWithThroughput = teamMetrics.filter(m => m.avgThroughput);
    const avgThroughput =
      metricsWithThroughput.length > 0
        ? metricsWithThroughput.reduce((sum, m) => sum + (m.avgThroughput || 0), 0) /
          metricsWithThroughput.length
        : 0;
    const totalBounces = teamMetrics.reduce((sum, m) => sum + m.totalBounces, 0);
    return { totalCompleted, totalDays, avgThroughput, totalBounces };
  }, [teamMetrics]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-[var(--text-muted)]">Loading metrics...</div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto bg-[var(--bg-primary)]">
      <div className="max-w-6xl mx-auto p-6 space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold text-[var(--text-primary)]">Performance</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">Agent delivery metrics</p>
        </div>

        {/* Team Summary */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <SummaryCard label="Tasks Completed" value={totals.totalCompleted} />
          <SummaryCard label="Active Agent-Days" value={totals.totalDays} />
          <SummaryCard label="Avg Throughput" value={`${totals.avgThroughput.toFixed(1)}/hr`} />
          <SummaryCard label="Total Bounces" value={totals.totalBounces} />
        </div>

        {/* Agent Cards */}
        {teamMetrics.length === 0 ? (
          <div className="p-8 border border-[var(--border-default)] rounded-[var(--radius-md)] text-center">
            <p className="text-[var(--text-muted)]">
              No metrics data yet. Metrics are computed daily at midnight.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {teamMetrics.map(metrics => {
              const tm =
                teammateMap[metrics.agentId] ||
                teammateMap[metrics.agentId.toLowerCase()];
              return <AgentCard key={metrics.agentId} metrics={metrics} teammate={tm} />;
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="p-4 bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-md)]">
      <p className="text-xs text-[var(--text-muted)] mb-1">{label}</p>
      <p className="text-2xl font-bold text-[var(--text-primary)]">{value}</p>
    </div>
  );
}

function AgentCard({ metrics, teammate }: { metrics: AgentMetrics; teammate?: Teammate }) {
  const throughputColor =
    (metrics.avgThroughput || 0) > 2
      ? 'text-green-500'
      : (metrics.avgThroughput || 0) > 1
      ? 'text-amber-500'
      : 'text-red-500';

  const firstPassPct =
    metrics.avgFirstPass != null ? Math.round(metrics.avgFirstPass * 100) : null;
  const chainPct =
    metrics.avgChainRate != null ? Math.round(metrics.avgChainRate * 100) : null;

  return (
    <div className="p-5 bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-md)] space-y-4 hover:border-[var(--border-strong)] transition-colors">
      {/* Agent Header */}
      <div className="flex items-center gap-3">
        <span className="text-2xl">{teammate?.emoji || '🤖'}</span>
        <div>
          <h3 className="font-semibold text-[var(--text-primary)]">
            {teammate?.name || metrics.agentId}
          </h3>
          <p className="text-xs text-[var(--text-muted)]">{teammate?.domain || ''}</p>
        </div>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-2 gap-3">
        <MetricItem label="Tasks Done" value={metrics.totalCompleted} />
        <MetricItem
          label="Throughput"
          value={`${metrics.avgThroughput?.toFixed(1) || '—'}/hr`}
          className={throughputColor}
        />
        <MetricItem label="First Pass" value={firstPassPct != null ? `${firstPassPct}%` : '—'} />
        <MetricItem label="Chain Rate" value={chainPct != null ? `${chainPct}%` : '—'} />
        <MetricItem label="Active Days" value={metrics.activeDays} />
        <MetricItem
          label="Bounces"
          value={metrics.totalBounces}
          className={metrics.totalBounces > 0 ? 'text-amber-500' : ''}
        />
      </div>

      {/* Secondary Metrics */}
      <div className="flex gap-4 text-xs text-[var(--text-muted)] border-t border-[var(--border-subtle)] pt-3">
        <span>💬 {metrics.totalComments} comments</span>
        <span>⭐ {metrics.totalKudos} kudos</span>
        {metrics.totalFlags > 0 && <span>🚩 {metrics.totalFlags} flags</span>}
      </div>
    </div>
  );
}

function MetricItem({
  label,
  value,
  className,
}: {
  label: string;
  value: string | number;
  className?: string;
}) {
  return (
    <div>
      <p className="text-xs text-[var(--text-muted)]">{label}</p>
      <p className={clsx('text-lg font-semibold text-[var(--text-primary)]', className)}>
        {value}
      </p>
    </div>
  );
}
