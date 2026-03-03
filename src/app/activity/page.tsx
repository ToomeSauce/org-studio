'use client';

import { PageHeader } from '@/components/PageHeader';
import { useGatewayQuery } from '@/lib/hooks';
import { Activity, Bot, Clock, MessageSquare, CheckCircle2, XCircle, Zap } from 'lucide-react';
// polling-based activity view
import { clsx } from 'clsx';

interface ActivityEvent {
  id: string;
  type: string;
  title: string;
  detail?: string;
  timestamp: string;
  icon: 'bot' | 'cron' | 'message' | 'success' | 'error' | 'system';
}

const iconMap = {
  bot: { icon: Bot, color: 'text-violet-400' },
  cron: { icon: Clock, color: 'text-amber-400' },
  message: { icon: MessageSquare, color: 'text-blue-400' },
  success: { icon: CheckCircle2, color: 'text-green-400' },
  error: { icon: XCircle, color: 'text-red-400' },
  system: { icon: Zap, color: 'text-zinc-400' },
};

function ActivityRow({ event }: { event: ActivityEvent }) {
  const { icon: Icon, color } = iconMap[event.icon] || iconMap.system;
  const time = new Date(event.timestamp);
  const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dateStr = time.toLocaleDateString([], { month: 'short', day: 'numeric' });

  return (
    <div className="flex items-start gap-3 py-3 px-4 hover:bg-[var(--bg-hover)] transition-colors">
      <div className="mt-0.5 shrink-0">
        <Icon size={16} className={color} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-[var(--text-primary)]">{event.title}</p>
        {event.detail && (
          <p className="text-xs text-[var(--text-tertiary)] mt-0.5 truncate">{event.detail}</p>
        )}
      </div>
      <div className="text-right shrink-0">
        <p className="text-xs text-[var(--text-muted)]">{timeStr}</p>
        <p className="text-[10px] text-[var(--text-muted)]">{dateStr}</p>
      </div>
    </div>
  );
}

export default function ActivityPage() {
  // Poll sessions as activity source (events will need SSE endpoint later)
  const { data: sessions } = useGatewayQuery<any>('sessions.list', { limit: 20 }, 10000);
  const sessionList = sessions?.sessions || sessions || [];

  const events: ActivityEvent[] = (Array.isArray(sessionList) ? sessionList : []).map((s: any, i: number) => ({
    id: s.sessionKey || `s-${i}`,
    type: s.kind || 'session',
    title: s.label || s.task || s.sessionKey?.slice(0, 16) || 'Session',
    detail: s.model || s.agentId || undefined,
    timestamp: s.lastActive || s.createdAt || new Date().toISOString(),
    icon: (s.kind === 'cron' ? 'cron' : s.kind === 'run' ? 'bot' : 'message') as ActivityEvent['icon'],
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Activity"
        description="Live event stream from Gateway"
        actions={
          <span className="text-xs text-[var(--text-muted)]">Auto-refreshes every 10s</span>
        }
      />

      <div className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg">
        <div className="divide-y divide-[var(--border-subtle)] max-h-[calc(100vh-200px)] overflow-y-auto">
          {events.length > 0 ? (
            events.map(event => <ActivityRow key={event.id} event={event} />)
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-[var(--text-tertiary)]">
              <Activity size={32} className="mb-3 opacity-30" />
              <p className="text-sm">Listening for events...</p>
              <p className="text-xs mt-1">Events will appear here as they happen</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
