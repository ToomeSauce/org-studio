'use client';

import { PageHeader } from '@/components/PageHeader';
import { useGateway, useGatewayQuery } from '@/lib/hooks';
import { Bot, Send, MessageCircle, Clock, Zap, Circle, Activity, ChevronRight, Loader2, X } from 'lucide-react';
import { clsx } from 'clsx';
import { useState, useMemo } from 'react';

interface AgentDef {
  id: string;
  name: string;
  emoji: string;
  title: string;
  color: string;
  bg: string;
}

const AGENT_DEFS: AgentDef[] = [
  { id: 'main', name: 'Henry', emoji: '🧄', title: 'Chief of Staff', color: 'text-[var(--accent-primary)]', bg: 'bg-[rgba(255,92,92,0.12)]' },
  { id: 'ana', name: 'Ana', emoji: '⚡', title: 'Catpilot Dev', color: 'text-yellow-400', bg: 'bg-[rgba(250,204,21,0.1)]' },
  { id: 'mikey', name: 'Mikey', emoji: '🔬', title: 'Labs Dev', color: 'text-cyan-400', bg: 'bg-[rgba(34,211,238,0.1)]' },
  { id: 'sam', name: 'Sam', emoji: '⚖️', title: 'Legal Counsel', color: 'text-purple-400', bg: 'bg-[rgba(168,85,247,0.1)]' },
];

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
  // Find sessions belonging to this agent
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
      isActive && 'border-[rgba(34,197,94,0.3)]'
    )}>
      {/* Header */}
      <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex items-center gap-3">
        <div className={clsx('w-10 h-10 rounded-full flex items-center justify-center text-lg shrink-0', agent.bg)}>
          {agent.emoji}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-[15px] font-bold text-[var(--text-primary)] tracking-tight">{agent.name}</h3>
            <div className={clsx(
              'w-2 h-2 rounded-full',
              isActive ? 'bg-[var(--success)] shadow-[0_0_6px_rgba(34,197,94,0.5)]' : 'bg-zinc-600'
            )} />
            <span className="text-[10px] text-[var(--text-muted)]">{isActive ? 'Active' : 'Idle'}</span>
          </div>
          <p className={clsx('text-[12px] font-medium', agent.color)}>{agent.title}</p>
        </div>
        <button
          onClick={() => onPing(agent.id)}
          className={clsx(
            'flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium rounded-[var(--radius-md)] transition-all',
            'border border-[var(--border-default)] hover:border-[var(--border-strong)]',
            'hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]'
          )}
        >
          <Send size={12} /> Message
        </button>
      </div>

      {/* Stats */}
      <div className="px-5 py-3 grid grid-cols-4 gap-4">
        <div>
          <p className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wide">Last Active</p>
          <p className="text-[13px] font-medium text-[var(--text-primary)] mt-0.5">{lastActive}</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wide">Model</p>
          <p className="text-[13px] font-medium text-[var(--text-primary)] mt-0.5 font-[var(--font-mono)] text-[11px]">{model}</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wide">Tokens</p>
          <p className="text-[13px] font-medium text-[var(--text-primary)] mt-0.5">{formatTokens(totalTokens)}</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wide">Sessions</p>
          <p className="text-[13px] font-medium text-[var(--text-primary)] mt-0.5">{agentSessions.length}</p>
        </div>
      </div>

      {/* Active sub-sessions */}
      {subSessions.length > 0 && (
        <div className="px-5 pb-3">
          <p className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-1.5">Active Runs</p>
          <div className="space-y-1">
            {subSessions.slice(0, 4).map((s: any, i: number) => {
              const name = s.displayName || s.label || s.key?.split(':').pop() || 'run';
              const kind = s.kind || 'run';
              return (
                <div key={s.key || i} className="flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-sm)] bg-[var(--bg-primary)]">
                  <div className={clsx('w-1.5 h-1.5 rounded-full',
                    kind === 'cron' ? 'bg-[var(--warning)]' : 'bg-[var(--info)]'
                  )} />
                  <span className="text-[11px] text-[var(--text-secondary)] truncate flex-1">{name}</span>
                  <span className={clsx(
                    'text-[9px] font-semibold px-1.5 py-px rounded-full',
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
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-default)]">
          <h2 className="text-base font-semibold tracking-tight">Message {agentName}</h2>
          <button onClick={onClose} className="p-1.5 rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)]"><X size={16} /></button>
        </div>
        <div className="p-5 space-y-4">
          {sent ? (
            <div className="text-center py-6">
              <div className="text-[var(--success)] text-lg mb-2">✓</div>
              <p className="text-sm text-[var(--text-secondary)]">Message sent to {agentName}</p>
            </div>
          ) : (
            <>
              <textarea
                value={msg} onChange={e => setMsg(e.target.value)}
                placeholder={`Send a task or message to ${agentName}...`}
                rows={4}
                className="w-full px-3.5 py-2.5 bg-[var(--bg-primary)] border border-[var(--border-strong)] rounded-[var(--radius-md)] text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] resize-none outline-none focus:border-[var(--accent-primary)] transition-all"
                autoFocus
                onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) handleSend(); }}
              />
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-[var(--text-muted)]">⌘+Enter to send</span>
                <button onClick={handleSend} disabled={!msg.trim() || sending}
                  className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium text-white rounded-[var(--radius-md)] bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-all">
                  {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send
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
  const { gateway } = useGateway();
  const { data: sessions } = useGatewayQuery<any>('sessions.list', { limit: 50 }, 8000);
  const sessionList = sessions?.sessions || [];
  const [messagingAgent, setMessagingAgent] = useState<AgentDef | null>(null);

  // Summary stats
  const allSessions = Array.isArray(sessionList) ? sessionList : [];
  const activeSessions = allSessions.filter((s: any) => s.updatedAt && Date.now() - s.updatedAt < 300000);
  const totalTokens = allSessions.reduce((sum: number, s: any) => sum + (s.totalTokens || 0), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Agents"
        description="Operational status and control for each agent"
      />

      {/* Summary strip */}
      <div className="flex items-center gap-6">
        {[
          { label: 'Agents', value: AGENT_DEFS.length, color: 'text-[var(--accent-primary)]' },
          { label: 'Active Sessions', value: activeSessions.length, color: 'text-[var(--success)]' },
          { label: 'Total Sessions', value: allSessions.length, color: 'text-[var(--text-primary)]' },
          { label: 'Total Tokens', value: formatTokens(totalTokens), color: 'text-[var(--warning)]' },
        ].map(stat => (
          <div key={stat.label} className="flex items-baseline gap-2">
            <span className={clsx('text-xl font-bold tracking-tight', stat.color)}>{stat.value}</span>
            <span className="text-[11px] font-medium text-[var(--text-muted)] uppercase tracking-wide">{stat.label}</span>
          </div>
        ))}
      </div>

      {/* Agent panels */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {AGENT_DEFS.map((agent, i) => (
          <AgentPanel
            key={agent.id}
            agent={agent}
            sessions={allSessions}
            onPing={() => setMessagingAgent(agent)}
          />
        ))}
      </div>

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
