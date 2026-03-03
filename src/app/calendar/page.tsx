'use client';

import { PageHeader } from '@/components/PageHeader';
import { useGatewayQuery } from '@/lib/hooks';
import { Clock, ChevronLeft, ChevronRight, RefreshCw, Circle } from 'lucide-react';
import { useState, useMemo } from 'react';
import { clsx } from 'clsx';

const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

interface CalEvent {
  id: string; title: string; time: string; timeFormatted: string; enabled: boolean; schedule: string;
}

function parseCron(expr: string) {
  if (!expr) return null;
  const p = expr.split(/\s+/);
  if (p.length < 5) return null;
  const mins = p[0] === '*' ? null : p[0].split(',').map(Number);
  let hours: number[] = [];
  if (p[1] === '*') hours = [];
  else if (p[1].includes('-')) { const [a,b] = p[1].split('-').map(Number); for (let i=a;i<=b;i++) hours.push(i); }
  else hours = p[1].split(',').map(Number);
  let dows: number[] | null = null;
  if (p[4] !== '*') {
    if (p[4].includes('-')) { const [a,b] = p[4].split('-').map(Number); dows = []; for (let i=a;i<=b;i++) dows.push(i); }
    else dows = p[4].split(',').map(Number);
  }
  return { mins, hours, dows };
}

function fmtTime(h: number, m: number) {
  return `${h % 12 || 12}:${m.toString().padStart(2,'0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function getWeekStart(d: Date) { const r = new Date(d); r.setDate(r.getDate() - r.getDay()); r.setHours(0,0,0,0); return r; }
function sameDay(a: Date, b: Date) { return a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate(); }

export default function CalendarPage() {
  const [offset, setOffset] = useState(0);
  const [view, setView] = useState<'week'|'day'>('week');
  const [dayIndex, setDayIndex] = useState(new Date().getDay());
  const { data: cronData, refetch } = useGatewayQuery<any>('cron.list', {}, 60000);
  const [refreshing, setRefreshing] = useState(false);
  const cronJobs = cronData?.jobs || cronData || [];
  const today = new Date();

  const weekStart = useMemo(() => {
    const b = getWeekStart(today);
    b.setDate(b.getDate() + offset * 7);
    return b;
  }, [offset]);

  const weekDays = useMemo(() => Array.from({length:7},(_,i) => { const d=new Date(weekStart); d.setDate(d.getDate()+i); return d; }), [weekStart]);

  // Always-running jobs (no specific time — run constantly or very frequently)
  const alwaysRunning = useMemo(() => {
    if (!Array.isArray(cronJobs)) return [];
    return cronJobs.filter((j:any) => {
      if (j.enabled === false) return false;
      const expr = typeof j.schedule === 'string' ? j.schedule : j.schedule?.expr || '';
      const p = parseCron(expr);
      // Heartbeat or very frequent (every minute, etc.)
      return !p || (p.hours.length === 0 && !p.mins);
    });
  }, [cronJobs]);

  // Events by day index
  const eventsByDay = useMemo(() => {
    const map = new Map<number, CalEvent[]>();
    if (!Array.isArray(cronJobs)) return map;
    for (let i=0;i<7;i++) map.set(i,[]);

    cronJobs.forEach((job:any) => {
      if (job.enabled === false) return;
      const expr = typeof job.schedule === 'string' ? job.schedule : job.schedule?.expr || '';
      const p = parseCron(expr);
      if (!p || (p.hours.length === 0 && !p.mins)) return; // skip always-running

      for (let di=0;di<7;di++) {
        const dow = weekDays[di].getDay();
        if (p.dows && !p.dows.includes(dow)) continue;

        let desc = '';
        if (p.hours.length > 1) {
          const s = fmtTime(p.hours[0], p.mins?.[0]||0);
          const e = fmtTime(p.hours[p.hours.length-1], p.mins?.[0]||0);
          desc = p.mins && p.mins.length > 1 ? `Every ${p.mins.join(',')}min ${s}–${e}` : `Hourly ${s}–${e}`;
        } else if (p.hours.length === 1) {
          desc = fmtTime(p.hours[0], p.mins?.[0]||0);
        }

        map.get(di)!.push({
          id: `${job.id}-${di}`,
          title: job.name || job.label || job.id?.slice(0,8) || 'Job',
          time: p.hours.length > 0 ? `${p.hours[0].toString().padStart(2,'0')}:${(p.mins?.[0]||0).toString().padStart(2,'0')}` : '00:00',
          timeFormatted: desc,
          enabled: true,
          schedule: expr,
        });
      }
    });
    for (const [,events] of map) events.sort((a,b) => a.time.localeCompare(b.time));
    return map;
  }, [cronJobs, weekDays]);

  const weekLabel = useMemo(() => {
    const s=weekDays[0], e=weekDays[6];
    if (s.getMonth()===e.getMonth()) return `${MONTHS[s.getMonth()]} ${s.getDate()}–${e.getDate()}, ${s.getFullYear()}`;
    return `${MONTHS[s.getMonth()].slice(0,3)} ${s.getDate()} – ${MONTHS[e.getMonth()].slice(0,3)} ${e.getDate()}, ${e.getFullYear()}`;
  }, [weekDays]);

  const handleRefresh = () => { setRefreshing(true); refetch(); setTimeout(()=>setRefreshing(false),1000); };

  const renderDayColumn = (day: Date, idx: number, tall = false) => {
    const isToday = sameDay(day, today);
    const events = eventsByDay.get(idx) || [];
    const isPast = day < today && !isToday;

    return (
      <div key={idx} className={clsx(
        'animate-rise rounded-[var(--radius-lg)] border flex flex-col transition-all duration-200',
        tall ? 'min-h-[500px]' : 'min-h-[280px]',
        isToday ? 'bg-[var(--card)] border-[rgba(255,92,92,0.3)] shadow-[0_0_20px_var(--accent-glow)]'
          : 'bg-[var(--card)] border-[var(--border-default)] hover:border-[var(--border-strong)]',
        isPast && 'opacity-60', `stagger-${Math.min(idx+1,6)}`
      )}>
        <div className={clsx('px-3 py-2.5 border-b border-[var(--border-subtle)] flex items-center gap-2', isToday && 'border-b-[rgba(255,92,92,0.2)]')}>
          <span className={clsx('inline-flex items-center justify-center w-7 h-7 text-xs font-bold rounded-full',
            isToday ? 'bg-[var(--accent-primary)] text-white' : 'text-[var(--text-secondary)]'
          )}>{day.getDate()}</span>
          <span className={clsx('text-xs font-medium', isToday ? 'text-[var(--accent-primary)]' : 'text-[var(--text-tertiary)]')}>
            {DAYS_SHORT[day.getDay()]}
          </span>
        </div>
        <div className="flex-1 p-2 space-y-1.5 overflow-y-auto">
          {events.map(ev => (
            <div key={ev.id} className="px-2.5 py-2 rounded-[var(--radius-md)] border border-[rgba(245,158,11,0.2)] bg-[rgba(245,158,11,0.06)] hover:bg-[rgba(245,158,11,0.1)] transition-colors">
              <div className="flex items-center gap-1.5 mb-0.5">
                <Clock size={10} className="text-[var(--warning)] shrink-0" />
                <span className="text-[10px] font-medium text-[var(--warning)]">{ev.timeFormatted}</span>
              </div>
              <p className="text-[11px] text-[var(--text-secondary)] leading-snug">{ev.title}</p>
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
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Calendar"
        description="Scheduled activities and events"
        actions={
          <div className="flex items-center gap-2">
            {/* View toggle */}
            <div className="flex border border-[var(--border-default)] rounded-[var(--radius-md)] overflow-hidden">
              {(['week','day'] as const).map(v => (
                <button key={v} onClick={() => setView(v)}
                  className={clsx('px-3 py-1 text-[12px] font-medium transition-colors',
                    view===v ? 'bg-[var(--accent-muted)] text-[var(--accent-primary)]' : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                  )}>{v === 'week' ? 'Week' : 'Day'}</button>
              ))}
            </div>
            <button onClick={() => setOffset(0)}
              className={clsx('px-3 py-1.5 text-sm rounded-[var(--radius-md)] transition-all',
                offset===0 ? 'text-[var(--accent-primary)] bg-[var(--accent-muted)] border border-[rgba(255,92,92,0.3)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-default)] hover:border-[var(--border-strong)]'
              )}>Today</button>
            <div className="flex items-center gap-0.5">
              <button onClick={() => view==='week' ? setOffset(o=>o-1) : setDayIndex(d=>(d+6)%7)} className="p-1.5 rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] transition-colors"><ChevronLeft size={16}/></button>
              <button onClick={() => view==='week' ? setOffset(o=>o+1) : setDayIndex(d=>(d+1)%7)} className="p-1.5 rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] transition-colors"><ChevronRight size={16}/></button>
            </div>
            <button onClick={handleRefresh} className="p-1.5 rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] transition-colors" title="Refresh">
              <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
            </button>
          </div>
        }
      />

      {/* Always Running */}
      {alwaysRunning.length > 0 && (
        <div className="flex items-center gap-3 px-4 py-2.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)]">
          <div className="w-1.5 h-1.5 rounded-full bg-[var(--success)] animate-pulse" />
          <span className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wide">Always Running</span>
          <div className="flex flex-wrap gap-2">
            {alwaysRunning.map((j: any) => (
              <span key={j.id} className="text-[11px] px-2 py-0.5 rounded-full border border-[rgba(34,197,94,0.2)] bg-[var(--success-subtle)] text-[var(--success)]">
                {j.name || j.label || j.id?.slice(0,8)}
              </span>
            ))}
          </div>
        </div>
      )}

      <h2 className="text-base font-semibold text-[var(--text-primary)] tracking-tight">{weekLabel}</h2>

      {/* Calendar grid */}
      {view === 'week' ? (
        <div className="grid grid-cols-7 gap-3">
          {weekDays.map((day, idx) => renderDayColumn(day, idx))}
        </div>
      ) : (
        <div className="max-w-md">
          {renderDayColumn(weekDays[dayIndex], dayIndex, true)}
        </div>
      )}
    </div>
  );
}
