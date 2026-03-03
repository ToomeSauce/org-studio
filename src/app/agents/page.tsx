'use client';

import { PageHeader } from '@/components/PageHeader';
import { useGateway, useGatewayQuery } from '@/lib/hooks';
import { Bot, Circle, Clock, MessageSquare, Plus, X, Send, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { useState } from 'react';

function AgentCard({ session, stagger }: { session: any; stagger: number }) {
  const isActive = session.status === 'active' || (session.updatedAt && Date.now() - session.updatedAt < 300000);
  const kind: string = session.kind || 'direct';

  const kindConfig: Record<string, { label: string; color: string; dotColor: string }> = {
    direct:  { label: 'Main', color: 'text-[var(--accent-primary)] bg-[var(--accent-muted)] border-[rgba(255,92,92,0.3)]', dotColor: 'bg-[var(--accent-primary)]' },
    run:     { label: 'Sub-agent', color: 'text-[var(--info)] bg-[var(--info-subtle)] border-[rgba(59,130,246,0.3)]', dotColor: 'bg-[var(--info)]' },
    session: { label: 'Persistent', color: 'text-[var(--success)] bg-[var(--success-subtle)] border-[rgba(34,197,94,0.3)]', dotColor: 'bg-[var(--success)]' },
    cron:    { label: 'Cron', color: 'text-[var(--warning)] bg-[var(--warning-subtle)] border-[rgba(245,158,11,0.3)]', dotColor: 'bg-[var(--warning)]' },
  };
  const kc = kindConfig[kind] || { label: kind, color: 'text-[var(--text-muted)] bg-[var(--bg-tertiary)] border-[var(--border-default)]', dotColor: 'bg-zinc-500' };

  const displayName = session.displayName || session.label || session.agentId || session.key?.split(':').pop() || 'Agent';
  const model = session.model?.split('/').pop() || '';
  const tokens = session.totalTokens ? `${Math.round(session.totalTokens / 1000)}k tokens` : '';

  return (
    <div className={clsx(
      'animate-rise bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-4',
      'hover:border-[var(--border-strong)] transition-all duration-200',
      'shadow-[var(--shadow-sm),inset_0_1px_0_var(--card-highlight)]',
      `stagger-${stagger}`
    )}>
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-[var(--radius-md)] bg-[var(--bg-tertiary)] flex items-center justify-center shrink-0">
            <Bot size={15} className="text-[var(--text-tertiary)]" />
          </div>
          <span className="text-sm font-semibold text-[var(--text-primary)] truncate tracking-tight">
            {displayName}
          </span>
        </div>
        <span className={clsx('text-[10px] px-2 py-0.5 rounded-full font-semibold border', kc.color)}>
          {kc.label}
        </span>
      </div>

      <div className="space-y-2">
        {session.task && (
          <p className="text-xs text-[var(--text-tertiary)] line-clamp-2 leading-relaxed">
            {session.task}
          </p>
        )}

        <div className="flex items-center gap-3 text-[11px] text-[var(--text-muted)]">
          <span className="flex items-center gap-1.5">
            <div className={clsx('w-[5px] h-[5px] rounded-full', isActive ? 'bg-[var(--success)] shadow-[0_0_6px_rgba(34,197,94,0.5)]' : 'bg-zinc-600')} />
            {isActive ? 'Active' : 'Idle'}
          </span>
          {model && <span className="font-[var(--font-mono)] text-[10px]">{model}</span>}
          {tokens && <span>{tokens}</span>}
          {session.channel && <span>{session.channel}</span>}
        </div>
      </div>
    </div>
  );
}

function NewAgentDialog({ onClose, onSend }: { onClose: () => void; onSend: (msg: string) => Promise<void> }) {
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    if (!message.trim() || sending) return;
    setSending(true);
    try {
      await onSend(message.trim());
      onClose();
    } catch (e) {
      console.error('Failed to send:', e);
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-lg bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] shadow-[var(--shadow-lg)] animate-rise"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-default)]">
          <h2 className="text-base font-semibold tracking-tight">New Chat Session</h2>
          <button onClick={onClose} className="p-1.5 rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label className="text-xs font-medium text-[var(--text-tertiary)] uppercase tracking-wide mb-2 block">
              Message
            </label>
            <textarea
              value={message}
              onChange={e => setMessage(e.target.value)}
              placeholder="Send a message to start a new session..."
              rows={4}
              className="w-full px-3.5 py-2.5 bg-[var(--bg-primary)] border border-[var(--border-strong)] rounded-[var(--radius-md)] text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] resize-none outline-none focus:border-[var(--accent-primary)] focus:shadow-[0_0_0_2px_var(--bg-primary),0_0_0_4px_var(--accent-primary)] transition-all"
              autoFocus
              onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) handleSend(); }}
            />
          </div>

          <div className="flex items-center justify-between">
            <span className="text-[11px] text-[var(--text-muted)]">⌘+Enter to send</span>
            <div className="flex items-center gap-2">
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-sm text-[var(--text-secondary)] border border-[var(--border-default)] hover:border-[var(--border-strong)] rounded-[var(--radius-md)] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSend}
                disabled={!message.trim() || sending}
                className={clsx(
                  'flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium text-white rounded-[var(--radius-md)] transition-all',
                  'bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)]',
                  'shadow-[0_1px_2px_rgba(0,0,0,0.3)] hover:shadow-[var(--shadow-md),0_0_20px_var(--accent-glow)]',
                  'disabled:opacity-50 disabled:cursor-not-allowed'
                )}
              >
                {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                Send
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AgentsPage() {
  const { gateway } = useGateway();
  const { data: sessions } = useGatewayQuery<any>('sessions.list', { limit: 50 }, 10000);
  const sessionList = sessions?.sessions || sessions || [];
  const [showNewAgent, setShowNewAgent] = useState(false);

  const mainSessions = Array.isArray(sessionList) ? sessionList.filter((s: any) => s.kind !== 'cron') : [];
  const cronSessions = Array.isArray(sessionList) ? sessionList.filter((s: any) => s.kind === 'cron') : [];

  const handleSendChat = async (message: string) => {
    if (!gateway) throw new Error('Not connected');
    await gateway.sendChat(message);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Agents"
        description="Active agents, sub-agents, and sessions"
        actions={
          <button
            onClick={() => setShowNewAgent(true)}
            className={clsx(
              'flex items-center gap-1.5 px-3.5 py-1.5 text-sm font-medium text-white rounded-[var(--radius-md)] transition-all',
              'bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)]',
              'shadow-[0_1px_2px_rgba(0,0,0,0.3)] hover:shadow-[var(--shadow-md),0_0_20px_var(--accent-glow)]'
            )}
          >
            <Plus size={14} />
            New Agent
          </button>
        }
      />

      {/* Main sessions */}
      <div>
        <h2 className="text-[11px] uppercase tracking-[0.04em] font-semibold text-[var(--text-muted)] mb-3">
          Sessions ({mainSessions.length})
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {mainSessions.map((session: any, i: number) => (
            <AgentCard key={session.key || session.sessionKey || i} session={session} stagger={Math.min(i + 1, 6)} />
          ))}
          {mainSessions.length === 0 && (
            <p className="text-sm text-[var(--text-muted)] col-span-full text-center py-8">
              No active sessions
            </p>
          )}
        </div>
      </div>

      {/* Cron sessions */}
      {cronSessions.length > 0 && (
        <div>
          <h2 className="text-[11px] uppercase tracking-[0.04em] font-semibold text-[var(--text-muted)] mb-3">
            Cron Sessions ({cronSessions.length})
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {cronSessions.map((session: any, i: number) => (
              <AgentCard key={session.key || session.sessionKey || i} session={session} stagger={Math.min(i + 1, 6)} />
            ))}
          </div>
        </div>
      )}

      {showNewAgent && (
        <NewAgentDialog
          onClose={() => setShowNewAgent(false)}
          onSend={handleSendChat}
        />
      )}
    </div>
  );
}
