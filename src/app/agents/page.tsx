'use client';

import { PageHeader } from '@/components/PageHeader';
import { useGatewayQuery } from '@/lib/hooks';
import { Bot, Circle, Clock, MessageSquare, Plus, Settings2 } from 'lucide-react';
import { clsx } from 'clsx';

function AgentCard({ session }: { session: any }) {
  const isActive = session.status === 'active' || session.activeMinutes < 5;
  const kind: string = session.kind || 'main';

  const kindBadges: Record<string, { label: string; color: string }> = {
    main: { label: 'Main', color: 'bg-violet-500/15 text-violet-400' },
    run: { label: 'Sub-agent', color: 'bg-blue-500/15 text-blue-400' },
    session: { label: 'Persistent', color: 'bg-green-500/15 text-green-400' },
    cron: { label: 'Cron', color: 'bg-amber-500/15 text-amber-400' },
  };
  const kindBadge = kindBadges[kind] || { label: kind, color: 'bg-zinc-500/15 text-zinc-400' };

  return (
    <div className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg p-4 hover:border-[var(--border-strong)] transition-colors">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <Bot size={16} className="text-[var(--accent-primary)]" />
          <span className="text-sm font-medium text-[var(--text-primary)] truncate">
            {session.label || session.agentId || session.sessionKey?.slice(0, 12) || 'Agent'}
          </span>
        </div>
        <span className={clsx('text-[11px] px-2 py-0.5 rounded-full font-medium', kindBadge.color)}>
          {kindBadge.label}
        </span>
      </div>

      <div className="space-y-2">
        {session.task && (
          <p className="text-xs text-[var(--text-secondary)] line-clamp-2">
            {session.task}
          </p>
        )}

        <div className="flex items-center gap-4 text-xs text-[var(--text-tertiary)]">
          <span className="flex items-center gap-1">
            <Circle size={6} className={clsx('fill-current', isActive ? 'text-green-500' : 'text-zinc-600')} />
            {isActive ? 'Active' : 'Idle'}
          </span>
          {session.model && (
            <span className="truncate">
              {session.model.split('/').pop()}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export default function AgentsPage() {
  const { data: sessions } = useGatewayQuery<any>('sessions.list', { limit: 50 }, 10000);
  const sessionList = sessions?.sessions || sessions || [];

  const mainSessions = Array.isArray(sessionList) ? sessionList.filter((s: any) => s.kind !== 'cron') : [];
  const cronSessions = Array.isArray(sessionList) ? sessionList.filter((s: any) => s.kind === 'cron') : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Agents"
        description="Active agents, sub-agents, and sessions"
        actions={
          <button className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-white rounded-md transition-colors">
            <Plus size={14} />
            New Agent
          </button>
        }
      />

      {/* Main / Sub-agents */}
      <div>
        <h2 className="text-xs uppercase tracking-wide text-[var(--text-tertiary)] mb-3">
          Sessions ({mainSessions.length})
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {mainSessions.map((session: any, i: number) => (
            <AgentCard key={session.sessionKey || i} session={session} />
          ))}
          {mainSessions.length === 0 && (
            <p className="text-sm text-[var(--text-tertiary)] col-span-full text-center py-8">
              No active sessions
            </p>
          )}
        </div>
      </div>

      {/* Cron sessions */}
      {cronSessions.length > 0 && (
        <div>
          <h2 className="text-xs uppercase tracking-wide text-[var(--text-tertiary)] mb-3">
            Cron Sessions ({cronSessions.length})
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {cronSessions.map((session: any, i: number) => (
              <AgentCard key={session.sessionKey || i} session={session} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
