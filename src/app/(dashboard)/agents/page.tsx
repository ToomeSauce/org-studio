'use client';

import { PageHeader } from '@/components/PageHeader';
import { GatewayNotice } from '@/components/GatewayNotice';
import { useWSData } from '@/lib/ws';
import { getGateway } from '@/lib/gateway';
import { Bot, Send, Clock, Circle, X, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { useState, useMemo } from 'react';
import { Teammate, resolveColor } from '@/lib/teammates';

interface AgentDef {
  id: string;
  name: string;
  emoji: string;
  title: string;
  color: string;
  bg: string;
}

function formatTokens(n: number): string {
  if (!n) return '0';
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

function formatRelative(ms: number): string {
  if (!ms) return 'never';
  const diff = Date.now() - ms;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function AgentPanel({ agent, sessions, onPing }: {
  agent: AgentDef;
  sessions: any[];
  onPing: (agentId: string) => void;
}) {
  const agentSessions = sessions.filter((s: any) => {
    const key = s.key || s.sessionKey || '';
    return key.includes(`agent:${agent.id}:`) || key.startsWith(`${agent.id}:`);
  });

  const mainSession = agentSessions.find((s: any) => s.kind === 'direct') || agentSessions[0];
  const isActive = mainSession?.updatedAt && Date.now() - mainSession.updatedAt < 300000;
  const totalTokens = agentSessions.reduce((sum: number, s: any) => sum + (s.totalTokens || 0), 0);
  const model = mainSession?.model?.split('/').pop() || '—';
  const lastActive = mainSession?.updatedAt ? formatRelative(mainSession.updatedAt) : 'no sessions';
  const subSessions = agentSessions.filter((s: any) => s.kind === 'run' || s.kind === 'cron');

  return (
    <div className={clsx(
      'animate-rise bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)]',
      'hover:border-[var(--border-strong)] transition-all duration-200',
      'shadow-[var(--shadow-sm),inset_0_1px_0_var(--card-highlight)]',
      isActive && 'border-[rgba(52,211,153,0.3)]'
    )}>
      {/* Header */}
      <div className="px-6 py-5 border-b border-[var(--border-subtle)] flex items-center gap-4">
        <div className={clsx('w-12 h-12 rounded-full flex items-center justify-center text-xl shrink-0', agent.bg)}>
          {agent.emoji}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5">
            <h3 className="text-[var(--text-md)] font-bold text-[var(--text-primary)]">{agent.name}</h3>
            <div className={clsx(
              'w-2.5 h-2.5 rounded-full',
              isActive ? 'bg-[var(--success)] shadow-[0_0_8px_rgba(52,211,153,0.5)]' : 'bg-zinc-600'
            )} />
            <span className="text-[var(--text-xs)] text-[var(--text-muted)]">{isActive ? 'Active' : 'Idle'}</span>
          </div>
          <p className={clsx('text-[var(--text-sm)] font-medium mt-0.5', agent.color)}>{agent.title}</p>
        </div>
        <button
          onClick={() => onPing(agent.id)}
          className={clsx(
            'flex items-center gap-2 px-4 py-2 text-[var(--text-sm)] font-medium rounded-[var(--radius-md)] transition-all',
            'border border-[var(--border-default)] hover:border-[var(--border-strong)]',
            'hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]'
          )}
        >
          <Send size={14} /> Message
        </button>
      </div>

      {/* Stats */}
      <div className="px-6 py-4 grid grid-cols-4 gap-5">
        {[
          { label: 'Last Active', value: lastActive },
          { label: 'Model', value: model, mono: true },
          { label: 'Tokens', value: formatTokens(totalTokens) },
          { label: 'Sessions', value: String(agentSessions.length) },
        ].map(stat => (
          <div key={stat.label}>
            <p className="text-[var(--text-xs)] font-semibold text-[var(--text-muted)] uppercase tracking-wide">{stat.label}</p>
            <p className={clsx('text-[var(--text-base)] font-medium text-[var(--text-primary)] mt-1', stat.mono && 'font-[var(--font-mono)] text-[var(--text-sm)]')}>{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Active sub-sessions */}
      {subSessions.length > 0 && (
        <div className="px-6 pb-4">
          <p className="text-[var(--text-xs)] font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-2">Active Runs</p>
          <div className="space-y-1.5">
            {subSessions.slice(0, 4).map((s: any, i: number) => {
              const name = s.displayName || s.label || s.key?.split(':').pop() || 'run';
              const kind = s.kind || 'run';
              return (
                <div key={s.key || i} className="flex items-center gap-2.5 px-3 py-2 rounded-[var(--radius-sm)] bg-[var(--bg-primary)]">
                  <div className={clsx('w-2 h-2 rounded-full',
                    kind === 'cron' ? 'bg-[var(--warning)]' : 'bg-[var(--info)]'
                  )} />
                  <span className="text-[var(--text-sm)] text-[var(--text-secondary)] truncate flex-1">{name}</span>
                  <span className={clsx(
                    'text-[var(--text-xs)] font-semibold px-2 py-0.5 rounded-full',
                    kind === 'cron' ? 'bg-[var(--warning-subtle)] text-[var(--warning)]' : 'bg-[var(--info-subtle)] text-[var(--info)]'
                  )}>{kind}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function MessageDialog({ agentId, agentName, onClose, gateway }: {
  agentId: string; agentName: string; onClose: () => void; gateway: any;
}) {
  const [msg, setMsg] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSend = async () => {
    if (!msg.trim() || sending || !gateway) return;
    setSending(true);
    try {
      await gateway.sendChat(msg.trim(), `agent:${agentId}:main`);
      setSent(true);
      setTimeout(onClose, 1500);
    } catch (e) {
      console.error('Send failed:', e);
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-lg bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] shadow-[var(--shadow-lg)] animate-rise"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border-default)]">
          <h2 className="text-[var(--text-lg)] font-semibold tracking-tight">Message {agentName}</h2>
          <button onClick={onClose} className="p-2 rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)]"><X size={18} /></button>
        </div>
        <div className="p-6 space-y-4">
          {sent ? (
            <div className="text-center py-8">
              <div className="text-[var(--success)] text-2xl mb-3">✓</div>
              <p className="text-[var(--text-base)] text-[var(--text-secondary)]">Message sent to {agentName}</p>
            </div>
          ) : (
            <>
              <textarea
                value={msg} onChange={e => setMsg(e.target.value)}
                placeholder={`Send a task or message to ${agentName}...`}
                rows={4}
                className="w-full px-4 py-3 bg-[var(--bg-primary)] border border-[var(--border-strong)] rounded-[var(--radius-md)] text-[var(--text-base)] text-[var(--text-primary)] placeholder-[var(--text-muted)] resize-none outline-none focus:border-[var(--accent-primary)] transition-all"
                autoFocus
                onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) handleSend(); }}
              />
              <div className="flex items-center justify-between">
                <span className="text-[var(--text-xs)] text-[var(--text-muted)]">⌘+Enter to send</span>
                <button onClick={handleSend} disabled={!msg.trim() || sending}
                  className="flex items-center gap-2 px-5 py-2 text-[var(--text-sm)] font-semibold text-white rounded-[var(--radius-md)] bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-all">
                  {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />} Send
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function AgentsPage() {
  const gateway = getGateway();
  const sessions = useWSData<any>('sessions');
  const sessionList = sessions?.sessions || [];
  const [messagingAgent, setMessagingAgent] = useState<AgentDef | null>(null);

  const storeData = useWSData<any>('store');
  const teammates: Teammate[] = storeData?.settings?.teammates || [];
  const agentDefs: AgentDef[] = useMemo(() =>
    teammates.filter(t => !t.isHuman && t.agentId).map(t => {
      const c = resolveColor(t.color);
      return { id: t.agentId, name: t.name, emoji: t.emoji, title: t.title, color: c.text, bg: c.bg };
    }), [teammates]);

  const allSessions = Array.isArray(sessionList) ? sessionList : [];
  const activeSessions = allSessions.filter((s: any) => s.updatedAt && Date.now() - s.updatedAt < 300000);
  const totalTokens = allSessions.reduce((sum: number, s: any) => sum + (s.totalTokens || 0), 0);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Agents"
        description="Operational status and control for each agent"
      />

      {/* Gateway Notice */}
      {!sessions && (
        <GatewayNotice feature="live agent sessions" />
      )}

      {/* Empty state */}
      {agentDefs.length === 0 && !sessions && (
        <div className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-8 text-center">
          <div className="text-4xl mb-3">🤖</div>
          <p className="text-[var(--text-base)] font-medium text-[var(--text-secondary)] mb-2">No agents yet</p>
          <p className="text-[var(--text-sm)] text-[var(--text-muted)] mb-6">
            Add agent teammates on the <a href="/team" className="text-[var(--accent-primary)] hover:underline">Team page</a>, or connect an agent runtime to auto-discover them.
          </p>
        </div>
      )}

      {/* Summary strip */}
      {agentDefs.length > 0 && (
        <>
          <div className="flex items-center gap-8">
            {[
              { label: 'Agents', value: agentDefs.length, color: 'text-[var(--accent-primary)]' },
              { label: 'Active Sessions', value: activeSessions.length, color: 'text-[var(--success)]' },
              { label: 'Total Sessions', value: allSessions.length, color: 'text-[var(--text-primary)]' },
              { label: 'Total Tokens', value: formatTokens(totalTokens), color: 'text-[var(--warning)]' },
            ].map(stat => (
              <div key={stat.label} className="flex items-baseline gap-2">
                <span className={clsx('text-[var(--text-xl)] font-bold tracking-tight', stat.color)}>{stat.value}</span>
                <span className="text-[var(--text-xs)] font-semibold text-[var(--text-muted)] uppercase tracking-wide">{stat.label}</span>
              </div>
            ))}
          </div>

          {/* Agent panels */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {agentDefs.map(agent => (
              <AgentPanel
                key={agent.id}
                agent={agent}
                sessions={allSessions}
                onPing={() => setMessagingAgent(agent)}
              />
            ))}
          </div>
        </>
      )}

      {messagingAgent && gateway && (
        <MessageDialog
          agentId={messagingAgent.id}
          agentName={messagingAgent.name}
          onClose={() => setMessagingAgent(null)}
          gateway={gateway}
        />
      )}
    </div>
  );
}
