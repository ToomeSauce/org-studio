'use client';

import { useEffect, useState, useMemo } from 'react';
import { clsx } from 'clsx';

interface VelocityTrendPoint {
  date: string;
  completed: number;
  started: number;
  bounced: number;
}

interface HeatmapCell {
  day: number;
  hour: number;
  count: number;
}

interface StallItem {
  taskId: string;
  title: string;
  assignee: string;
  stalledMinutes: number;
  startedAt: number;
}

interface BottleneckItem {
  taskId: string;
  title: string;
  assignee: string;
  reviewMinutes: number;
}

interface TeamHealthData {
  velocityTrend: VelocityTrendPoint[];
  activeHoursHeatmap: HeatmapCell[];
  stalls: {
    current: StallItem[];
    frequency: {
      last7d: number;
      last30d: number;
      avgStallMinutes: number;
    };
  };
  reviewBottlenecks: {
    avgReviewMinutes: number;
    maxReviewMinutes: number;
    tasksInReview: number;
    recentBottlenecks: BottleneckItem[];
  };
}

export default function TeamHealthSection() {
  const [data, setData] = useState<TeamHealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/metrics/team-health')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        setData(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error('Failed to load team health:', err);
        setError(err.message);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <p className="text-[var(--text-muted)]">Loading health data...</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">Team Health</h2>
          <p className="text-sm text-[var(--text-muted)]">Cross-team delivery health signals</p>
        </div>
        <div className="p-6 border border-[var(--border-default)] rounded-[var(--radius-md)] text-center">
          <p className="text-sm text-[var(--text-muted)]">No data available</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">Team Health</h2>
        <p className="text-sm text-[var(--text-muted)]">Cross-team delivery health signals</p>
      </div>

      {/* 4-Panel Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Panel 1: Velocity Trend */}
        <VelocityTrendPanel data={data.velocityTrend} />

        {/* Panel 2: Active Hours Heatmap */}
        <ActiveHoursHeatmapPanel data={data.activeHoursHeatmap} />

        {/* Panel 3: Stall Frequency */}
        <StallFrequencyPanel data={data.stalls} />

        {/* Panel 4: Review Bottlenecks */}
        <ReviewBottlenecksPanel data={data.reviewBottlenecks} />
      </div>
    </div>
  );
}

/**
 * Panel 1: 30-day bar chart of completed tasks
 */
function VelocityTrendPanel({ data }: { data: VelocityTrendPoint[] }) {
  const maxCompleted = Math.max(...data.map((d) => d.completed), 1);

  return (
    <div className="p-5 bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-md)] space-y-4">
      <h3 className="text-sm font-semibold text-[var(--text-primary)]">Team Velocity</h3>

      <div className="flex items-end gap-0.5 h-32">
        {data.map((point, idx) => {
          const height = maxCompleted > 0 ? (point.completed / maxCompleted) * 100 : 0;
          const shouldShowLabel = idx % 5 === 0 || idx === data.length - 1;

          return (
            <div
              key={point.date}
              className="flex-1 flex flex-col items-center group relative"
            >
              <div
                className="w-full rounded-t transition-all"
                style={{
                  height: `${Math.max(height, 2)}%`,
                  backgroundColor: 'var(--accent-primary)',
                  opacity: point.completed > 0 ? 1 : 0.1,
                }}
              />
              {/* Tooltip */}
              <div className="absolute bottom-full mb-2 hidden group-hover:block bg-[var(--bg-primary)] border border-[var(--border-default)] rounded px-2 py-1 text-xs text-[var(--text-primary)] whitespace-nowrap shadow-lg z-10">
                {point.date}: {point.completed} completed
              </div>
              {/* X-axis label (every 5th day) */}
              {shouldShowLabel && (
                <div className="text-[10px] text-[var(--text-muted)] mt-2 w-full text-center">
                  {point.date.split('-')[2]}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-xs text-[var(--text-muted)]">30-day task completion trend</p>
    </div>
  );
}

/**
 * Panel 2: 7×24 heatmap grid
 */
function ActiveHoursHeatmapPanel({ data }: { data: HeatmapCell[] }) {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const HOURS = [0, 3, 6, 9, 12, 15, 18, 21];

  // Create 7×24 grid
  const grid: Record<string, number> = {};
  const maxCount = Math.max(...data.map((d) => d.count), 1);

  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      grid[`${day}-${hour}`] = 0;
    }
  }

  for (const cell of data) {
    grid[`${cell.day}-${cell.hour}`] = cell.count;
  }

  return (
    <div className="p-5 bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-md)] space-y-4">
      <h3 className="text-sm font-semibold text-[var(--text-primary)]">Active Hours</h3>

      <div className="space-y-2">
        {/* Row headers + grid rows */}
        {[0, 1, 2, 3, 4, 5, 6].map((day) => (
          <div key={day} className="flex gap-2 items-center">
            <div className="w-10 text-right text-xs text-[var(--text-muted)]">{DAYS[day]}</div>
            <div className="flex gap-0.5 flex-1">
              {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23].map(
                (hour) => {
                  const count = grid[`${day}-${hour}`] || 0;
                  const intensity = count > 0 ? count / maxCount : 0;
                  const bgColor = `rgba(34, 197, 94, ${intensity * 0.8})`; // green scale

                  return (
                    <div
                      key={`${day}-${hour}`}
                      className="flex-1 aspect-square rounded group relative"
                      style={{
                        backgroundColor: bgColor,
                        border: '1px solid var(--border-subtle)',
                      }}
                      title={`${DAYS[day]} ${hour}:00 - ${count} events`}
                    >
                      {/* Tooltip */}
                      <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 hidden group-hover:block bg-[var(--bg-primary)] border border-[var(--border-default)] rounded px-2 py-1 text-xs text-[var(--text-primary)] whitespace-nowrap shadow-lg z-10">
                        {hour}:00 - {count} events
                      </div>
                    </div>
                  );
                }
              )}
            </div>
          </div>
        ))}

        {/* Column headers (every 3 hours) */}
        <div className="flex gap-2 items-start mt-2">
          <div className="w-10" />
          <div className="flex gap-0.5 flex-1">
            {HOURS.map((h) => (
              <div key={h} className="flex-1 text-[10px] text-[var(--text-muted)] text-center">
                {h === 0 ? '12am' : h === 12 ? '12pm' : h < 12 ? `${h}am` : `${h - 12}pm`}
              </div>
            ))}
          </div>
        </div>
      </div>

      <p className="text-xs text-[var(--text-muted)]">Activity density by day and hour (NY time)</p>
    </div>
  );
}

/**
 * Panel 3: Stall stats and list
 */
function StallFrequencyPanel({
  data,
}: {
  data: {
    current: StallItem[];
    frequency: { last7d: number; last30d: number; avgStallMinutes: number };
  };
}) {
  const { current, frequency } = data;

  const formatDuration = (minutes: number): string => {
    if (minutes < 60) return `${Math.round(minutes)}m`;
    return `${(minutes / 60).toFixed(1)}h`;
  };

  return (
    <div className="p-5 bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-md)] space-y-4">
      <h3 className="text-sm font-semibold text-[var(--text-primary)]">Stall Frequency</h3>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 gap-3">
        <StatItem label="Current Stalls" value={current.length} />
        <StatItem label="Last 7d" value={frequency.last7d} />
        <StatItem label="Last 30d" value={frequency.last30d} />
        <StatItem label="Avg Duration" value={formatDuration(frequency.avgStallMinutes)} />
      </div>

      {/* Stalled Tasks List */}
      {current.length > 0 && (
        <div className="space-y-2 border-t border-[var(--border-subtle)] pt-3">
          {current.map((task) => (
            <div
              key={task.taskId}
              className="p-3 bg-[var(--bg-secondary)] rounded border-l-4 border-red-500/50"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[var(--text-primary)] truncate">
                    {task.title}
                  </p>
                  <p className="text-xs text-[var(--text-muted)]">{task.assignee}</p>
                </div>
                <span className="text-xs px-2 py-1 rounded bg-red-500/20 text-red-400 whitespace-nowrap">
                  Stalled {formatDuration(task.stalledMinutes)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Panel 4: Review bottlenecks
 */
function ReviewBottlenecksPanel({
  data,
}: {
  data: {
    avgReviewMinutes: number;
    maxReviewMinutes: number;
    tasksInReview: number;
    recentBottlenecks: BottleneckItem[];
  };
}) {
  const formatDuration = (minutes: number): string => {
    if (minutes < 60) return `${Math.round(minutes)}m`;
    return `${(minutes / 60).toFixed(1)}h`;
  };

  return (
    <div className="p-5 bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-md)] space-y-4">
      <h3 className="text-sm font-semibold text-[var(--text-primary)]">Review Bottlenecks</h3>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 gap-3">
        <StatItem label="Avg Review Time" value={formatDuration(data.avgReviewMinutes)} />
        <StatItem label="Max Review Time" value={formatDuration(data.maxReviewMinutes)} />
        <StatItem label="Currently in Review" value={data.tasksInReview} />
        <StatItem label="Recent Cases" value={data.recentBottlenecks.length} />
      </div>

      {/* Bottleneck Tasks List */}
      {data.recentBottlenecks.length > 0 && (
        <div className="space-y-2 border-t border-[var(--border-subtle)] pt-3">
          {data.recentBottlenecks.map((task) => (
            <div
              key={task.taskId}
              className="p-3 bg-[var(--bg-secondary)] rounded border-l-4 border-amber-500/50"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[var(--text-primary)] truncate">
                    {task.title}
                  </p>
                  <p className="text-xs text-[var(--text-muted)]">{task.assignee}</p>
                </div>
                <span className="text-xs px-2 py-1 rounded bg-amber-500/20 text-amber-400 whitespace-nowrap">
                  {formatDuration(task.reviewMinutes)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Shared stat card component
 */
function StatItem({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <p className="text-xs text-[var(--text-muted)]">{label}</p>
      <p className="text-lg font-semibold text-[var(--text-primary)]">{value}</p>
    </div>
  );
}
