'use client';

import { PageHeader } from '@/components/PageHeader';
import { useGatewayQuery } from '@/lib/hooks';
import { Clock, ChevronLeft, ChevronRight } from 'lucide-react';
import { useState, useMemo } from 'react';
import { clsx } from 'clsx';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

interface CalendarEvent {
  id: string;
  title: string;
  time?: string;
  type: 'cron' | 'calendar' | 'reminder' | 'task';
  color: string;
}

function parseCronSchedule(schedule: string): { dayOfWeek?: number; hour?: number; minute?: number } | null {
  if (!schedule) return null;
  // Simple cron parser for display: "0 19 * * *" → 7pm daily
  const parts = schedule.split(/\s+/);
  if (parts.length < 5) return null;
  const minute = parts[0] !== '*' ? parseInt(parts[0]) : undefined;
  const hour = parts[1] !== '*' ? parseInt(parts[1]) : undefined;
  const dayOfWeek = parts[4] !== '*' ? parseInt(parts[4]) : undefined;
  return { dayOfWeek, hour, minute };
}

export default function CalendarPage() {
  const [currentDate, setCurrentDate] = useState(new Date());
  const { data: cronData } = useGatewayQuery<any>('cron.list', {}, 60000);
  const cronJobs = cronData?.jobs || cronData || [];

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();

  // Generate cron-based events for visible days
  const cronEvents = useMemo(() => {
    if (!Array.isArray(cronJobs)) return new Map<number, CalendarEvent[]>();

    const events = new Map<number, CalendarEvent[]>();

    cronJobs.forEach((job: any) => {
      if (job.enabled === false) return;
      const parsed = parseCronSchedule(job.schedule || job.cron || '');
      if (!parsed) return;

      for (let day = 1; day <= daysInMonth; day++) {
        const date = new Date(year, month, day);
        const dow = date.getDay();

        // Check if job runs on this day
        let runs = false;
        if (parsed.dayOfWeek !== undefined) {
          runs = dow === parsed.dayOfWeek;
        } else {
          runs = true; // daily
        }

        if (runs) {
          if (!events.has(day)) events.set(day, []);
          const timeStr = parsed.hour !== undefined
            ? `${parsed.hour.toString().padStart(2, '0')}:${(parsed.minute || 0).toString().padStart(2, '0')}`
            : '';
          events.get(day)!.push({
            id: `${job.id}-${day}`,
            title: job.label || job.id?.slice(0, 8) || 'Cron',
            time: timeStr,
            type: 'cron',
            color: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
          });
        }
      }
    });

    return events;
  }, [cronJobs, year, month, daysInMonth]);

  const prevMonth = () => setCurrentDate(new Date(year, month - 1, 1));
  const nextMonth = () => setCurrentDate(new Date(year, month + 1, 1));
  const goToday = () => setCurrentDate(new Date());

  return (
    <div className="space-y-6">
      <PageHeader
        title="Calendar"
        description="Scheduled activities and events"
        actions={
          <button
            onClick={goToday}
            className="px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-default)] hover:border-[var(--border-strong)] rounded-md transition-colors"
          >
            Today
          </button>
        }
      />

      {/* Calendar header */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-medium text-[var(--text-primary)]">
          {MONTHS[month]} {year}
        </h2>
        <div className="flex items-center gap-1">
          <button onClick={prevMonth} className="p-1.5 rounded hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] transition-colors">
            <ChevronLeft size={16} />
          </button>
          <button onClick={nextMonth} className="p-1.5 rounded hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] transition-colors">
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {/* Calendar grid */}
      <div className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg overflow-hidden">
        {/* Day headers */}
        <div className="grid grid-cols-7 border-b border-[var(--border-default)]">
          {DAYS.map(day => (
            <div key={day} className="px-2 py-2 text-center text-xs font-medium text-[var(--text-tertiary)] uppercase">
              {day}
            </div>
          ))}
        </div>

        {/* Day cells */}
        <div className="grid grid-cols-7">
          {/* Empty cells before first day */}
          {Array.from({ length: firstDay }).map((_, i) => (
            <div key={`empty-${i}`} className="min-h-[100px] p-1.5 border-b border-r border-[var(--border-subtle)] bg-[var(--bg-primary)]/30" />
          ))}

          {/* Day cells */}
          {Array.from({ length: daysInMonth }).map((_, i) => {
            const day = i + 1;
            const isToday = today.getDate() === day && today.getMonth() === month && today.getFullYear() === year;
            const events = cronEvents.get(day) || [];

            return (
              <div
                key={day}
                className={clsx(
                  'min-h-[100px] p-1.5 border-b border-r border-[var(--border-subtle)]',
                  isToday && 'bg-[var(--accent-muted)]/30'
                )}
              >
                <span className={clsx(
                  'inline-flex items-center justify-center w-6 h-6 text-xs rounded-full',
                  isToday
                    ? 'bg-[var(--accent-primary)] text-white font-medium'
                    : 'text-[var(--text-secondary)]'
                )}>
                  {day}
                </span>

                {/* Events */}
                <div className="mt-1 space-y-0.5">
                  {events.slice(0, 3).map(event => (
                    <div
                      key={event.id}
                      className={clsx(
                        'px-1 py-0.5 text-[10px] rounded border truncate',
                        event.color
                      )}
                      title={`${event.time} ${event.title}`}
                    >
                      {event.time && <span className="font-medium">{event.time} </span>}
                      {event.title}
                    </div>
                  ))}
                  {events.length > 3 && (
                    <span className="text-[10px] text-[var(--text-muted)] px-1">
                      +{events.length - 3} more
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
