'use client';

import { useEffect, useState, useMemo } from 'react';
import { useWSData } from '@/lib/ws';
import { clsx } from 'clsx';
import TeamHealthSection from '@/components/TeamHealthSection';
import QualityScorecardSection from '@/components/QualityScorecardSection';
import CulturalAlignmentSection from '@/components/CulturalAlignmentSection';
import AgentComparisonSection from '@/components/AgentComparisonSection';
import WeeklyDigestSection from '@/components/WeeklyDigestSection';
import { CoachingInsight } from '@/lib/coaching-insights';
import { agentOwnedSections } from '@/lib/section-access';

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
  const [coachingInsights, setCoachingInsights] = useState<CoachingInsight[] | null>(null);
  const [coachingLoading, setCoachingLoading] = useState(false);
  const [selectedProject, setSelectedProject] = useState<string>('all');
  const [filterSection, setFilterSection] = useState<string>('');  // '' = All (agent-wide)
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
      setCoachingInsights(null);
      return;
    }
    setAgentLoading(true);
    const sectionParam = filterSection ? `&sectionId=${encodeURIComponent(filterSection)}` : '';
    fetch(`/api/metrics/${selectedAgent}?limit=30${sectionParam}`)
      .then(res => res.json())
      .then(data => {
        setAgentMetrics((data.metrics || []).reverse()); // oldest first for charts
        setAgentLoading(false);
      })
      .catch(() => setAgentLoading(false));

    // Fetch coaching insights
    setCoachingLoading(true);
    setCoachingInsights(null);
    fetch(`/api/metrics/coaching-insights?agent=${selectedAgent}`)
      .then(res => res.json())
      .then(data => {
        setCoachingInsights(data.insights || []);
        setCoachingLoading(false);
      })
      .catch(() => setCoachingLoading(false));
  }, [selectedAgent, filterSection]);

  const teammates: Teammate[] = storeData?.settings?.teammates || [];

  const teammateMap = useMemo(() => {
    const map: Record<string, Teammate> = {};
    for (const t of teammates) {
      if (t.agentId) map[t.agentId] = t;
      if (t.name) map[t.name.toLowerCase()] = t;
    }
    return map;
  }, [teammates]);

  // Compute available sections across all active projects
  const sectionOptions = useMemo(() => {
    const projects = (storeData?.projects || []).filter((p: any) => !p.isArchived && p.phase !== 'complete');
    const options: Array<{ id: string; label: string }> = [];
    let hasNonDefault = false;
    for (const project of projects) {
      const sections = project.sections || [];
      if (sections.length <= 1) continue; // Only Main — skip
      for (const section of sections) {
        // Skip the default Main section from the dropdown (it's included in 'All')
        const isDefault = section.id === `sec-main-${project.id}` || (sections.length === 1 && section.name === 'Main');
        if (!isDefault) hasNonDefault = true;
        options.push({ id: section.id, label: `${project.name} — ${section.name}` });
      }
    }
    return hasNonDefault ? options : [];
  }, [storeData]);

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
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-3xl font-bold text-[var(--text-primary)]">Performance</h1>
            <p className="text-sm text-[var(--text-muted)] mt-1">Agent delivery metrics</p>
          </div>
          {sectionOptions.length > 0 && (
            <select
              value={filterSection}
              onChange={(e) => setFilterSection(e.target.value)}
              className="px-3 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
            >
              <option value="">All sections</option>
              {sectionOptions.map(opt => (
                <option key={opt.id} value={opt.id}>{opt.label}</option>
              ))}
            </select>
          )}
        </div>

        {/* Weekly Digest */}
        <WeeklyDigestSection />

        {/* Team Health Section */}
        <TeamHealthSection />

        {/* Quality Scorecard */}
        <QualityScorecardSection />

        {/* Cultural Alignment */}
        <CulturalAlignmentSection />

        {/* Agent Comparison Table */}
        <AgentComparisonSection />

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
                  projects={storeData?.projects || []}
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

                {/* Roadmap vs Adhoc split — #698 */}
                {agentMetrics.some(m => m.roadmapThroughput || m.adhocThroughput) && (
                  <div className="bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-lg p-4">
                    <h4 className="text-xs font-semibold text-[var(--text-muted)] mb-2">Roadmap vs Adhoc</h4>
                    <div className="flex items-center gap-6 text-sm">
                      <div>
                        <span className="text-[var(--accent-primary)] font-bold text-lg">
                          {agentMetrics.reduce((s, m) => s + (m.roadmapThroughput || 0), 0)}
                        </span>
                        <span className="text-[var(--text-muted)] ml-1">🗺️ roadmap</span>
                      </div>
                      <div>
                        <span className="text-[var(--text-primary)] font-bold text-lg">
                          {agentMetrics.reduce((s, m) => s + (m.adhocThroughput || 0), 0)}
                        </span>
                        <span className="text-[var(--text-muted)] ml-1">⚡ adhoc</span>
                      </div>
                    </div>
                  </div>
                )}

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

            {/* Coaching Insights */}
            <CoachingInsightsPanel
              agentName={teammateMap[selectedAgent]?.name || selectedAgent}
              insights={coachingInsights}
              loading={coachingLoading}
            />
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
  projects,
  selected,
  onClick,
}: {
  metrics: AgentMetrics;
  teammate?: Teammate;
  projects?: any[];
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

  // Section badges
  const agentName = teammate?.name || metrics.agentId;
  const owned = projects && projects.length > 0
    ? agentOwnedSections(projects.filter((p: any) => !p.isArchived), agentName)
    : [];
  // Filter out default Main sections — only show non-trivial sections
  const nonDefaultOwned = owned.filter(o => o.section.id !== `sec-main-${o.project.id}`);
  const maxBadges = 3;
  const visibleBadges = nonDefaultOwned.slice(0, maxBadges);
  const overflowCount = nonDefaultOwned.length - maxBadges;

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
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-[var(--text-primary)]">
            {teammate?.name || metrics.agentId}
          </h3>
          <p className="text-xs text-[var(--text-muted)]">{teammate?.domain || ''}</p>
          {visibleBadges.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {visibleBadges.map(o => (
                <span
                  key={o.section.id}
                  className="inline-block text-[10px] px-1.5 py-0.5 rounded border border-[var(--border-subtle)] text-[var(--text-muted)] bg-[var(--bg-secondary)] truncate max-w-[120px]"
                  title={`${o.project.name} — ${o.section.name}`}
                >
                  {o.section.name}
                </span>
              ))}
              {overflowCount > 0 && (
                <span className="inline-block text-[10px] px-1.5 py-0.5 text-[var(--text-muted)]">
                  +{overflowCount}
                </span>
              )}
            </div>
          )}
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

function insightIcon(type: CoachingInsight['type']): string {
  if (type === 'warning') return '⚠️';
  if (type === 'celebration') return '🎉';
  if (type === 'improvement') return '📈';
  return '💡';
}

function SeverityBar({ severity }: { severity: number }) {
  return (
    <div className="flex gap-0.5" title={`Severity: ${severity}/5`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className={clsx(
            'w-2.5 h-2 rounded-sm',
            i < severity ? 'bg-[var(--text-muted)] opacity-80' : 'bg-[var(--bg-tertiary)]'
          )}
        />
      ))}
    </div>
  );
}

function CoachingInsightsPanel({
  agentName,
  insights,
  loading,
}: {
  agentName: string;
  insights: CoachingInsight[] | null;
  loading: boolean;
}) {
  const borderColor = (type: CoachingInsight['type']) => {
    if (type === 'warning') return 'border-l-red-400 dark:border-l-red-600';
    if (type === 'celebration' || type === 'improvement') return 'border-l-green-400 dark:border-l-green-600';
    return 'border-l-blue-400 dark:border-l-blue-600';
  };

  const rowBg = (type: CoachingInsight['type']) => {
    if (type === 'warning') return 'bg-red-50 dark:bg-red-950/20';
    if (type === 'celebration' || type === 'improvement') return 'bg-green-50 dark:bg-green-950/20';
    return 'bg-blue-50 dark:bg-blue-950/20';
  };

  return (
    <div className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-md)] p-5 space-y-3">
      <h3 className="text-sm font-semibold text-[var(--text-primary)]">
        📋 Coaching Insights for {agentName}
      </h3>

      {loading && (
        <p className="text-sm text-[var(--text-muted)]">Generating insights...</p>
      )}

      {!loading && insights && insights.length === 0 && (
        <p className="text-sm text-[var(--text-muted)]">No insights available yet.</p>
      )}

      {!loading && insights && insights.map((insight, i) => (
        <div
          key={i}
          className={clsx(
            'flex items-start gap-3 px-4 py-3 rounded-[var(--radius-md)] border-l-4',
            borderColor(insight.type),
            rowBg(insight.type)
          )}
        >
          <span className="text-base mt-0.5 shrink-0">{insightIcon(insight.type)}</span>
          <div className="flex-1 min-w-0">
            <span className="font-semibold text-sm text-[var(--text-primary)]">{insight.title}</span>
            <span className="text-sm text-[var(--text-secondary)] ml-2">— {insight.message}</span>
          </div>
          <div className="shrink-0 flex flex-col items-end gap-1">
            <SeverityBar severity={insight.severity} />
            <span className="text-[10px] text-[var(--text-muted)]">{insight.severity}/5</span>
          </div>
        </div>
      ))}
    </div>
  );
}
