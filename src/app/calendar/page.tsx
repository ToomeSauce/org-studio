'use client';

import { PageHeader } from '@/components/PageHeader';
import { useGatewayQuery } from '@/lib/hooks';
import { Clock, ChevronLeft, ChevronRight, Circle } from 'lucide-react';
import { useState, useMemo } from 'react';
import { clsx } from 'clsx';

const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

interface CalendarEvent {
  id: string;
  title: string;
  time: string;
  timeFormatted: string;
  type: 'cron' | 'calendar';
  enabled: boolean;
  schedule: string;
}

function parseCronSchedule(expr: string): { dayOfWeek?: number; hour?: number; minute?: number } | null {
  if (!expr) return null;
  const parts = expr.split(/\s+/);
  if (parts.length < 5) return null;
  const minute = parts[0] !== '*' ? parseInt(parts[0]) : undefined;
  const hour = parts[1] !== '*' ? parseInt(parts[1]) : undefined;
  const dayOfWeek = parts[4] !== '*' ? parseInt(parts[4]) : undefined;
  return { dayOfWeek, hour, minute };
}

function formatTime(hour: number, minute: number): string {
  const period = hour >= 12 ? 'PM' : 'AM';
  const h = hour % 12 || 12;
  const m = minute.toString().padStart(2, '0');
  return `${h}:${m} ${period}`;
}

function formatScheduleHuman(expr: string): string {
  const parsed = parseCronSchedule(expr);
  if (!parsed) return expr;
  const parts: string[] = [];
  if (parsed.hour !== undefined) {
    parts.push(formatTime(parsed.hour, parsed.minute || 0));
  }
  if (parsed.dayOfWeek !== undefined) {
    parts.push(DAYS_FULL[parsed.dayOfWeek] + 's');
  } else {
    parts.push('Daily');
  }
  return parts.join(' · ');
}

function getWeekStart(date: Date): Date {
  const d = new Date(date);
  d.setDate(d.getDate() - d.getDay());
  d.setHours(0, 0, 0, 0);
  return d;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export default function CalendarPage() {
  const [weekOffset, setWeekOffset] = useState(0);
  const { data: cronData } = useGatewayQuery<any>('cron.list', {}, 60000);
  const cronJobs = cronData?.jobs || cronData || [];

  const today = new Date();
  const weekStart = useMemo(() => {
    const base = getWeekStart(today);
    base.setDate(base.getDate() + weekOffset * 7);
    return base;
  }, [weekOffset]);

  const weekDays = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + i);
      return d;
    });
  }, [weekStart]);

  // Generate events per day
  const eventsByDay = useMemo(() => {
    const map = new Map<number, CalendarEvent[]>();
    if (!Array.isArray(cronJobs)) return map;

    for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
      map.set(dayIdx, []);
    }

    cronJobs.forEach((job: any) => {
      const scheduleStr = typeof job.schedule === 'string' ? job.schedule : job.schedule?.expr || job.cron || '';
      const parsed = parseCronSchedule(scheduleStr);
      if (!parsed) return;

      // Check for multi-minute schedules (e.g., "0,30 9-16 * * 1-5")
      const parts = scheduleStr.split(/\s+/);
      const minutes = parts[0]?.split(',') || ['0'];
      const hours = parts[1] || '*';

      // Parse hour ranges
      let hourList: number[] = [];
      if (hours === '*') {
        hourList = [0]; // Just show once for "every hour" jobs
      } else if (hours.includes('-')) {
        const [start, end] = hours.split('-').map(Number);
        for (let h = start; h <= end; h++) hourList.push(h);
      } else {
        hourList = hours.split(',').map(Number);
      }

      // Parse day-of-week ranges (e.g., "1-5")
      const dowStr = parts[4] || '*';
      let dowList: number[] | null = null;
      if (dowStr !== '*') {
        if (dowStr.includes('-')) {
          const [start, end] = dowStr.split('-').map(Number);
          dowList = [];
          for (let d = start; d <= end; d++) dowList.push(d);
        } else {
          dowList = dowStr.split(',').map(Number);
        }
      }

      for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
        const dayDate = weekDays[dayIdx];
        const dow = dayDate.getDay();

        if (dowList && !dowList.includes(dow)) continue;

        // For display, only show the first occurrence time
        const firstHour = hourList[0];
        const firstMinute = parseInt(minutes[0]) || 0;
        const timeStr = formatTime(firstHour, firstMinute);

        let scheduleDesc = '';
        if (hourList.length > 1) {
          const startTime = formatTime(hourList[0], firstMinute);
          const endTime = formatTime(hourList[hourList.length - 1], firstMinute);
          if (minutes.length > 1) {
            scheduleDesc = `Every ${minutes.join(',')} min, ${startTime}–${endTime}`;
          } else {
            scheduleDesc = `Hourly ${startTime}–${endTime}`;
          }
        } else {
          scheduleDesc = timeStr;
        }

        map.get(dayIdx)!.push({
          id: `${job.id}-${dayIdx}`,
          title: job.name || job.label || job.id?.slice(0, 8) || 'Cron Job',
          time: `${firstHour.toString().padStart(2, '0')}:${firstMinute.toString().padStart(2, '0')}`,
          timeFormatted: scheduleDesc,
          type: 'cron',
          enabled: job.enabled !== false,
          schedule: scheduleStr,
        });
      }
    });

    // Sort events by time
    for (const [key, events] of map) {
      events.sort((a, b) => a.time.localeCompare(b.time));
    }

    return map;
  }, [cronJobs, weekDays]);

  const weekLabel = useMemo(() => {
    const start = weekDays[0];
    const end = weekDays[6];
    if (start.getMonth() === end.getMonth()) {
      return `${MONTHS[start.getMonth()]} ${start.getDate()}–${end.getDate()}, ${start.getFullYear()}`;
    }
    return `${MONTHS[start.getMonth()].slice(0, 3)} ${start.getDate()} – ${MONTHS[end.getMonth()].slice(0, 3)} ${end.getDate()}, ${end.getFullYear()}`;
  }, [weekDays]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Calendar"
        description="Weekly schedule overview"
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={() => setWeekOffset(0)}
              className={clsx(
                'px-3 py-1.5 text-sm rounded-[var(--radius-md)] transition-all',
                weekOffset === 0
                  ? 'text-[var(--accent-primary)] bg-[var(--accent-muted)] border border-[rgba(255,92,92,0.3)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-default)] hover:border-[var(--border-strong)]'
              )}
            >
              Today
            </button>
            <div className="flex items-center gap-0.5">
              <button
                onClick={() => setWeekOffset(w => w - 1)}
                className="p-1.5 rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] transition-colors"
              >
                <ChevronLeft size={16} />
              </button>
              <button
                onClick={() => setWeekOffset(w => w + 1)}
                className="p-1.5 rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] transition-colors"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        }
      />

      <h2 className="text-base font-semibold text-[var(--text-primary)] tracking-tight">{weekLabel}</h2>

      {/* Weekly grid */}
      <div className="grid grid-cols-7 gap-3">
        {weekDays.map((day, idx) => {
          const isToday = isSameDay(day, today);
          const events = eventsByDay.get(idx) || [];
          const isPast = day < today && !isToday;

          return (
            <div
              key={idx}
              className={clsx(
                'animate-rise rounded-[var(--radius-lg)] border min-h-[280px] flex flex-col transition-all duration-200',
                isToday
                  ? 'bg-[var(--card)] border-[rgba(255,92,92,0.3)] shadow-[0_0_20px_var(--accent-glow)]'
                  : 'bg-[var(--card)] border-[var(--border-default)] hover:border-[var(--border-strong)]',
                isPast && 'opacity-60',
                `stagger-${idx + 1}`
              )}
            >
              {/* Day header */}
              <div className={clsx(
                'px-3 py-2.5 border-b border-[var(--border-subtle)] flex items-center gap-2',
                isToday && 'border-b-[rgba(255,92,92,0.2)]'
              )}>
                <span className={clsx(
                  'inline-flex items-center justify-center w-7 h-7 text-xs font-bold rounded-full',
                  isToday
                    ? 'bg-[var(--accent-primary)] text-white'
                    : 'text-[var(--text-secondary)]'
                )}>
                  {day.getDate()}
                </span>
                <span className={clsx(
                  'text-xs font-medium',
                  isToday ? 'text-[var(--accent-primary)]' : 'text-[var(--text-tertiary)]'
                )}>
                  {DAYS_SHORT[idx]}
                </span>
              </div>

              {/* Events */}
              <div className="flex-1 p-2 space-y-1.5 overflow-y-auto">
                {events.map(event => (
                  <div
                    key={event.id}
                    className={clsx(
                      'px-2.5 py-2 rounded-[var(--radius-md)] border transition-colors cursor-default group',
                      event.enabled
                        ? 'border-[rgba(245,158,11,0.2)] bg-[rgba(245,158,11,0.06)] hover:bg-[rgba(245,158,11,0.1)]'
                        : 'border-[var(--border-subtle)] bg-[var(--bg-primary)] opacity-50'
                    )}
                  >
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <Clock size={10} className="text-[var(--warning)] shrink-0" />
                      <span className="text-[10px] font-medium text-[var(--warning)]">
                        {event.timeFormatted}
                      </span>
                    </div>
                    <p className="text-[11px] text-[var(--text-secondary)] leading-snug truncate">
                      {event.title}
                    </p>
                  </div>
                ))}
                {events.length === 0 && (
                  <div className="flex items-center justify-center h-full">
                    <span className="text-[11px] text-[var(--text-muted)]">No events</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
