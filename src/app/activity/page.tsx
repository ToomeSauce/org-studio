'use client';

import { PageHeader } from '@/components/PageHeader';
import { useGatewayQuery, useGatewayEvent } from '@/lib/hooks';
import { Activity, Bot, Clock, MessageSquare, CheckCircle2, XCircle, Zap } from 'lucide-react';
import { useState, useCallback } from 'react';
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
  const [events, setEvents] = useState<ActivityEvent[]>([]);

  // Subscribe to live gateway events
  useGatewayEvent('*', useCallback((msg: any) => {
    const event: ActivityEvent = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: msg.event || msg.type || 'unknown',
      title: msg.event || msg.type || 'Gateway Event',
      detail: msg.data ? JSON.stringify(msg.data).slice(0, 200) : undefined,
      timestamp: new Date().toISOString(),
      icon: 'system',
    };

    // Classify events
    if (event.type.includes('chat')) event.icon = 'message';
    else if (event.type.includes('cron')) event.icon = 'cron';
    else if (event.type.includes('session') || event.type.includes('agent')) event.icon = 'bot';
    else if (event.type.includes('error')) event.icon = 'error';

    setEvents(prev => [event, ...prev].slice(0, 200));
  }, []));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Activity"
        description="Live event stream from Gateway"
        actions={
          <button
            onClick={() => setEvents([])}
            className="px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-default)] hover:border-[var(--border-strong)] rounded-md transition-colors"
          >
            Clear
          </button>
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
