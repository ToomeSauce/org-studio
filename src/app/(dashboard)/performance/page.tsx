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
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [agentMetrics, setAgentMetrics] = useState<any[]>([]);
  const [agentLoading, setAgentLoading] = useState(false);
  const [selectedProject, setSelectedProject] = useState<string>('all');
  const [versionData, setVersionData] = useState<any[]>([]);

  useEffect(() => {
    fetch('/api/metrics/team')
      .then(res => res.json())
      .then(data => {
        setTeamMetrics(data.metrics || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedAgent) {
      setAgentMetrics([]);
      return;
    }
    setAgentLoading(true);
    fetch(`/api/metrics/${selectedAgent}?limit=30`)
      .then(res => res.json())
      .then(data => {
        setAgentMetrics((data.metrics || []).reverse()); // oldest first for charts
        setAgentLoading(false);
      })
      .catch(() => setAgentLoading(false));
  }, [selectedAgent]);

  const teammates: Teammate[] = storeData?.settings?.teammates || [];

  const teammateMap = useMemo(() => {
    const map: Record<string, Teammate> = {};
    for (const t of teammates) {
      if (t.agentId) map[t.agentId] = t;
      if (t.name) map[t.name.toLowerCase()] = t;
    }
    return map;
  }, [teammates]);

  const versionVelocity = useMemo(() => {
    if (!storeData?.tasks || !storeData?.projects) return [];
    const projects = storeData.projects.filter((p: any) => !p.isArchived);
    const tasks = storeData.tasks;
    const results: any[] = [];

    for (const project of projects) {
      if (selectedProject !== 'all' && project.id !== selectedProject) continue;

      const versionMap: Record<string, any[]> = {};
      for (const task of tasks) {
        if (task.projectId !== project.id || !task.version || task.isArchived) continue;
        if (!versionMap[task.version]) versionMap[task.version] = [];
        versionMap[task.version].push(task);
      }

      for (const [version, vTasks] of Object.entries(versionMap)) {
        const doneTasks = (vTasks as any[]).filter((t: any) => t.status === 'done');
        if (doneTasks.length === 0) continue;

        let earliestStart = Infinity;
        let latestDone = 0;
        for (const task of vTasks as any[]) {
          for (const h of (task.statusHistory || [])) {
            if (h.status === 'in-progress' && h.timestamp < earliestStart) {
              earliestStart = h.timestamp;
            }
            if (h.status === 'done' && h.timestamp > latestDone) {
              latestDone = h.timestamp;
            }
          }
        }

        const durationHours =
          earliestStart < Infinity && latestDone > 0
            ? (latestDone - earliestStart) / (1000 * 60 * 60)
            : null;

        results.push({
          projectName: project.name,
          projectId: project.id,
          version,
          totalTasks: (vTasks as any[]).length,
          doneTasks: doneTasks.length,
          durationHours,
          isComplete: doneTasks.length === (vTasks as any[]).length,
        });
      }
    }

    return results.sort((a, b) => {
      if (a.projectId !== b.projectId) return a.projectName.localeCompare(b.projectName);
      return parseFloat(a.version) - parseFloat(b.version);
    });
  }, [storeData, selectedProject]);

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
              return (
                <AgentCard
                  key={metrics.agentId}
                  metrics={metrics}
                  teammate={tm}
                  selected={selectedAgent === metrics.agentId}
                  onClick={() => setSelectedAgent(selectedAgent === metrics.agentId ? null : metrics.agentId)}
                />
              );
            })}
          </div>
        )}

        {/* Version Velocity */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">Version Velocity</h2>
            <select
              value={selectedProject}
              onChange={(e) => setSelectedProject(e.target.value)}
              className="px-3 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
            >
              <option value="all">All Projects</option>
              {(storeData?.projects || [])
                .filter((p: any) => !p.isArchived)
                .map((p: any) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
            </select>
          </div>

          {versionVelocity.length === 0 ? (
            <div className="p-6 border border-[var(--border-default)] rounded-[var(--radius-md)] text-center">
              <p className="text-sm text-[var(--text-muted)]">No version data available.</p>
            </div>
          ) : (
            <div className="border border-[var(--border-default)] rounded-[var(--radius-md)] overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-[var(--bg-secondary)] border-b border-[var(--border-default)]">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-[var(--text-muted)]">Project</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-[var(--text-muted)]">Version</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-[var(--text-muted)]">Tasks</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-[var(--text-muted)]">Duration</th>
                    <th className="px-4 py-3 text-xs font-semibold text-[var(--text-muted)]">Velocity</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-[var(--text-muted)]">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {versionVelocity.map((v, i) => {
                    const durationStr =
                      v.durationHours != null
                        ? v.durationHours < 1
                          ? `${Math.round(v.durationHours * 60)}m`
                          : v.durationHours < 24
                          ? `${v.durationHours.toFixed(1)}h`
                          : `${(v.durationHours / 24).toFixed(1)}d`
                        : '—';
                    const velocity =
                      v.durationHours && v.durationHours > 0
                        ? (v.doneTasks / v.durationHours).toFixed(1)
                        : '—';
                    const maxDuration = Math.max(
                      ...versionVelocity.filter((x: any) => x.durationHours).map((x: any) => x.durationHours),
                      1
                    );
                    const barWidth = v.durationHours ? (v.durationHours / maxDuration) * 100 : 0;

                    return (
                      <tr
                        key={`${v.projectId}-${v.version}`}
                        className="border-b border-[var(--border-subtle)] hover:bg-[var(--bg-secondary)] transition-colors"
                      >
                        <td className="px-4 py-3 text-[var(--text-secondary)]">{v.projectName}</td>
                        <td className="px-4 py-3 font-medium text-[var(--text-primary)]">v{v.version}</td>
                        <td className="px-4 py-3 text-right text-[var(--text-secondary)]">{v.doneTasks}/{v.totalTasks}</td>
                        <td className="px-4 py-3 text-right text-[var(--text-secondary)] tabular-nums">{durationStr}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-2 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
                              <div
                                className="h-full bg-[var(--accent-primary)] rounded-full transition-all"
                                style={{ width: `${Math.min(barWidth, 100)}%` }}
                              />
                            </div>
                            <span className="text-xs text-[var(--text-muted)] tabular-nums w-12 text-right">{velocity}/hr</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-center">
                          {v.isComplete ? (
                            <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 dark:bg-green-950/30 text-green-700 dark:text-green-400">✅ Done</span>
                          ) : (
                            <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400">⚙️ {v.doneTasks}/{v.totalTasks}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Agent Drill-Down */}
        {selectedAgent && (
          <div className="border border-[var(--border-default)] rounded-[var(--radius-md)] bg-[var(--card)] p-6 space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-[var(--text-primary)]">
                {teammateMap[selectedAgent]?.emoji}{' '}
                {teammateMap[selectedAgent]?.name || selectedAgent} — Daily Trends
              </h2>
              <button
                onClick={() => setSelectedAgent(null)}
                className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                Close ✕
              </button>
            </div>

            {agentLoading ? (
              <p className="text-[var(--text-muted)] text-sm">Loading trends...</p>
            ) : agentMetrics.length === 0 ? (
              <p className="text-[var(--text-muted)] text-sm">No daily data available yet.</p>
            ) : (
              <div className="space-y-6">
                {/* Tasks Completed per Day */}
                <TrendChart
                  title="Tasks Completed"
                  data={agentMetrics.map(m => ({ label: formatDate(m.date), value: m.tasksCompleted || 0 }))}
                  color="var(--accent-primary)"
                />

                {/* Throughput per Day */}
                <TrendChart
                  title="Throughput (tasks/hr)"
                  data={agentMetrics.map(m => ({ label: formatDate(m.date), value: m.throughput || 0 }))}
                  color="#22c55e"
                  decimals={1}
                />

                {/* Avg Duration per Day */}
                <TrendChart
                  title="Avg Duration (min)"
                  data={agentMetrics.map(m => ({ label: formatDate(m.date), value: m.avgDurationMin || 0 }))}
                  color="#f59e0b"
                  decimals={1}
                />

                {/* Chain Rate per Day */}
                <TrendChart
                  title="Chain Rate (%)"
                  data={agentMetrics.map(m => ({
                    label: formatDate(m.date),
                    value: m.chainRate ? Math.round(m.chainRate * 100) : 0,
                  }))}
                  color="#3b82f6"
                />

                {/* Comments per Day */}
                <TrendChart
                  title="Comments"
                  data={agentMetrics.map(m => ({ label: formatDate(m.date), value: m.commentsPosted || 0 }))}
                  color="#8b5cf6"
                />
              </div>
            )}
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

function AgentCard({
  metrics,
  teammate,
  selected,
  onClick,
}: {
  metrics: AgentMetrics;
  teammate?: Teammate;
  selected?: boolean;
  onClick?: () => void;
}) {
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
    <div
      onClick={onClick}
      className={clsx(
        'p-5 bg-[var(--card)] border rounded-[var(--radius-md)] space-y-4 transition-colors cursor-pointer',
        selected
          ? 'border-[var(--accent-primary)] ring-1 ring-[var(--accent-primary)]'
          : 'border-[var(--border-default)] hover:border-[var(--border-strong)]'
      )}
    >
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

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function TrendChart({
  title,
  data,
  color,
  decimals,
}: {
  title: string;
  data: { label: string; value: number }[];
  color: string;
  decimals?: number;
}) {
  const maxVal = Math.max(...data.map(d => d.value), 1);
  return (
    <div>
      <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-2">{title}</h3>
      <div className="flex items-end gap-1 h-24">
        {data.map((d, i) => {
          const height = maxVal > 0 ? (d.value / maxVal) * 100 : 0;
          return (
            <div key={i} className="flex-1 flex flex-col items-center group relative">
              <div
                className="w-full rounded-t transition-all"
                style={{
                  height: `${Math.max(height, 2)}%`,
                  backgroundColor: color,
                  opacity: d.value > 0 ? 1 : 0.15,
                }}
              />
              {/* Tooltip on hover */}
              <div className="absolute bottom-full mb-1 hidden group-hover:block bg-[var(--bg-primary)] border border-[var(--border-default)] rounded px-2 py-1 text-xs text-[var(--text-primary)] whitespace-nowrap shadow-lg z-10">
                {d.label}: {decimals ? d.value.toFixed(decimals) : d.value}
              </div>
            </div>
          );
        })}
      </div>
      {/* X-axis labels (show first, middle, last) */}
      <div className="flex justify-between mt-1">
        <span className="text-[10px] text-[var(--text-muted)]">{data[0]?.label || ''}</span>
        {data.length > 2 && (
          <span className="text-[10px] text-[var(--text-muted)]">
            {data[Math.floor(data.length / 2)]?.label || ''}
          </span>
        )}
        <span className="text-[10px] text-[var(--text-muted)]">
          {data[data.length - 1]?.label || ''}
        </span>
      </div>
    </div>
  );
}
