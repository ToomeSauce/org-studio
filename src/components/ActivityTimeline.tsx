'use client';

import { useMemo } from 'react';
import { Activity } from 'lucide-react';
import { clsx } from 'clsx';
import { Teammate, resolveColor, buildAgentMap } from '@/lib/teammates';

// ── Relative time helper ──────────────────────────────────────────────

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 172_800_000) return 'yesterday';
  const d = new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Timeline event types ──────────────────────────────────────────────

export interface TimelineEvent {
  id: string;
  agentName: string;
  agentEmoji: string;
  agentColor: string;         // color key (e.g. 'emerald')
  action: string;             // e.g. "picked up"
  taskTitle?: string;
  timestamp: number;
  status?: string;            // task status for badge
  live?: boolean;             // true = from activity-status
}

const ACTION_VERBS: Record<string, string> = {
  backlog: 'added to backlog',
  'in-progress': 'picked up',
  review: 'moved to review',
  done: 'completed',
  planning: 'created',
};

const STATUS_BADGE_COLORS: Record<string, string> = {
  done: 'bg-[rgba(52,211,153,0.2)] text-emerald-400',
  'in-progress': 'bg-[rgba(96,165,250,0.2)] text-blue-400',
  review: 'bg-[rgba(251,191,36,0.2)] text-amber-400',
  backlog: 'bg-[rgba(148,163,184,0.2)] text-[var(--text-muted)]',
  planning: 'bg-[rgba(168,85,247,0.2)] text-purple-400',
};

// ── Build timeline events ─────────────────────────────────────────────

export function buildTimelineEvents(
  tasks: any[],
  teammates: Teammate[],
  activityStatuses: Record<string, any>,
): TimelineEvent[] {
  const agentMap = buildAgentMap(teammates);
  const events: TimelineEvent[] = [];

  // 1. Task statusHistory events
  for (const task of tasks) {
    if (!Array.isArray(task.statusHistory)) continue;
    const assigneeKey = task.assignee?.toLowerCase();
    const teammate = agentMap[assigneeKey];

    for (const entry of task.statusHistory) {
      const verb = ACTION_VERBS[entry.status] || `moved to ${entry.status}`;
      events.push({
        id: `${task.id}-${entry.status}-${entry.timestamp}`,
        agentName: teammate?.name || task.assignee || 'Unknown',
        agentEmoji: teammate?.emoji || '👤',
        agentColor: teammate?.color || 'blue',
        action: verb,
        taskTitle: task.title,
        timestamp: entry.timestamp,
        status: entry.status,
        live: false,
      });
    }
  }

  // 2. Live activity-status events
  for (const [agentId, statusObj] of Object.entries(activityStatuses)) {
    if (!statusObj) continue;
    const teammate = agentMap[agentId];
    if (!teammate) continue;
    events.push({
      id: `live-${agentId}`,
      agentName: teammate.name,
      agentEmoji: teammate.emoji,
      agentColor: teammate.color,
      action: `is working on`,
      taskTitle: (statusObj as any).status || (statusObj as any).detail || 'something',
      timestamp: Date.now(),
      live: true,
    });
  }

  // Sort newest first, cap at 20
  events.sort((a, b) => b.timestamp - a.timestamp);
  return events.slice(0, 20);
}

// ── Component ─────────────────────────────────────────────────────────

interface ActivityTimelineProps {
  tasks: any[];
  teammates: Teammate[];
  activityStatuses: Record<string, any>;
}

export function ActivityTimeline({ tasks, teammates, activityStatuses }: ActivityTimelineProps) {
  const events = useMemo(
    () => buildTimelineEvents(tasks, teammates, activityStatuses),
    [tasks, teammates, activityStatuses],
  );

  return (
    <div className="animate-rise stagger-6 bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] shadow-[var(--shadow-sm),inset_0_1px_0_var(--card-highlight)] hover:border-[var(--border-strong)] transition-all">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-subtle)]">
        <h2 className="text-[var(--text-md)] font-semibold text-[var(--text-primary)]">📡 Activity Timeline</h2>
        <span className="text-[var(--text-xs)] text-[var(--text-muted)] font-medium">
          {events.length} events
        </span>
      </div>

      {/* Timeline body */}
      <div className="max-h-[400px] overflow-y-auto">
        {events.length > 0 ? (
          <div className="relative py-2">
            {/* Vertical line */}
            <div
              className="absolute left-[27px] top-0 bottom-0 w-px bg-[var(--border-subtle)]"
              aria-hidden
            />

            {events.map((ev, i) => {
              const colors = resolveColor(ev.agentColor);
              const badgeClass = ev.status ? STATUS_BADGE_COLORS[ev.status] : null;

              return (
                <div
                  key={ev.id}
                  className="relative flex items-start gap-3 py-2.5 px-4 hover:bg-[var(--bg-hover)] transition-colors"
                  style={{ animationDelay: `${i * 30}ms` }}
                >
                  {/* Dot */}
                  <span
                    className="relative z-10 mt-1.5 shrink-0 w-3 h-3 rounded-full border-2 border-[var(--card)]"
                    style={{ backgroundColor: colors.glowRgba }}
                  />

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <p className="text-[var(--text-sm)] leading-snug">
                      <span className="mr-1">{ev.agentEmoji}</span>
                      <span className={clsx('font-semibold', colors.text)}>{ev.agentName}</span>
                      {' '}
                      <span className="text-[var(--text-secondary)]">{ev.action}</span>
                      {ev.taskTitle && (
                        <>
                          {' '}
                          <span className="font-medium text-[var(--text-primary)]">&lsquo;{ev.taskTitle}&rsquo;</span>
                        </>
                      )}
                    </p>

                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[var(--text-xs)] text-[var(--text-muted)]">
                        {ev.live ? 'now' : relativeTime(ev.timestamp)}
                      </span>
                      {badgeClass && (
                        <span className={clsx('text-[10px] font-medium px-1.5 py-0.5 rounded-full leading-none', badgeClass)}>
                          {ev.status}
                        </span>
                      )}
                      {ev.live && (
                        <span className="flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-[var(--success)] animate-pulse" />
                          <span className="text-[10px] text-[var(--success)] font-medium">live</span>
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="p-8 text-center">
            <Activity size={28} className="mx-auto text-[var(--text-muted)] opacity-40 mb-3" />
            <p className="text-[var(--text-sm)] text-[var(--text-muted)]">No activity yet</p>
            <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-1 opacity-60">
              Events appear when tasks move through the pipeline
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
