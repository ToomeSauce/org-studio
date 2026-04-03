'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Send, Loader2, MessageCircle, WifiOff, Users } from 'lucide-react';
import { clsx } from 'clsx';
import { useGateway } from '@/lib/hooks';
import { useWSData } from '@/lib/ws';
import { type Teammate, resolveColor } from '@/lib/teammates';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  ts?: number;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function PingPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { gateway, state } = useGateway();
  const storeData = useWSData<any>('store');
  const gatewayStatus = useWSData<any>('gateway-status');

  const teammates: Teammate[] = storeData?.settings?.teammates || [];
  const agents = teammates.filter((t) => !t.isHuman && t.agentId);

  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [runtimeConnected, setRuntimeConnected] = useState<boolean | null>(null); // null = loading
  const [chatMsg, setChatMsg] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Check runtime connectivity when panel opens
  useEffect(() => {
    if (!open) return;
    fetch('/api/runtimes')
      .then(r => r.json())
      .then(data => {
        const connected = (data.runtimes || []).some((r: any) => r.connected);
        setRuntimeConnected(connected);
      })
      .catch(() => setRuntimeConnected(false));
  }, [open]);

  // Auto-select first agent when agents load
  useEffect(() => {
    if (agents.length > 0 && !selectedAgentId) {
      setSelectedAgentId(agents[0].agentId);
    }
  }, [agents, selectedAgentId]);

  // Load chat history when agent changes or panel opens
  const loadHistory = useCallback(async () => {
    if (!gateway || state !== 'connected' || !selectedAgentId) return;
    setLoadingHistory(true);
    try {
      const history = await gateway.rpc('chat.history', {
        sessionKey: `agent:${selectedAgentId}:main`,
        limit: 20,
      });
      const msgs = Array.isArray(history) ? history : history?.messages || [];
      // Filter to user/assistant text messages only, extract text content
      const parsed: ChatMessage[] = [];
      for (const m of msgs) {
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        let text = '';
        if (typeof m.content === 'string') {
          text = m.content;
        } else if (Array.isArray(m.content)) {
          text = m.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text || '')
            .join('\n');
        }
        if (!text.trim()) continue;
        parsed.push({
          role: m.role as 'user' | 'assistant',
          content: text,
          ts: m.ts || m.timestamp,
        });
      }
      setMessages(parsed);
    } catch {
      // History endpoint may not exist yet — that's fine
      setMessages([]);
    } finally {
      setLoadingHistory(false);
    }
  }, [gateway, state, selectedAgentId]);

  useEffect(() => {
    if (open && selectedAgentId) {
      loadHistory();
    }
  }, [open, selectedAgentId, loadHistory]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Auto-dismiss error toast
  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => setError(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [error]);

  // Focus textarea when panel opens
  useEffect(() => {
    if (open) {
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
  }, [open]);

  const handleSend = async () => {
    if (!chatMsg.trim() || sending || !selectedAgentId) return;
    const text = chatMsg.trim();
    setSending(true);
    setChatMsg('');

    // Optimistic add
    setMessages((prev) => [...prev, { role: 'user', content: text, ts: Date.now() }]);

    try {
      // Route through /api/ping — works for both OpenClaw and Hermes agents
      const resp = await fetch('/api/ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: selectedAgentId,
          message: text,
        }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || `Send failed (${resp.status})`);
      }
    } catch (e: any) {
      setError(e.message || 'Failed to send message');
    } finally {
      setSending(false);
    }
  };

  const selectedAgent = agents.find((a) => a.agentId === selectedAgentId);
  const selectedColor = selectedAgent ? resolveColor(selectedAgent.color) : null;
  const runtimeName = 'Org Studio';

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-md h-full bg-[var(--bg-primary)] border-l border-[var(--border-default)] shadow-[var(--shadow-lg)] flex flex-col"
        style={{ animation: 'fadeIn 0.2s var(--ease-out)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-default)]">
          <div className="flex items-center gap-2">
            <MessageCircle size={18} className="text-[var(--accent-primary)]" />
            <h2 className="text-[var(--text-md)] font-semibold">
              {selectedAgent ? `Message ${selectedAgent.name}` : 'Message Team'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)]"
          >
            <X size={18} />
          </button>
        </div>

        {/* No runtime connected */}
        {runtimeConnected === false ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <WifiOff size={32} className="text-[var(--text-muted)]" />
            <p className="text-[var(--text-base)] font-medium text-[var(--text-secondary)]">
              No agent runtime connected
            </p>
            <p className="text-[var(--text-sm)] text-[var(--text-muted)] max-w-xs">
              Ping requires a running agent runtime (OpenClaw, Hermes, or compatible). Configure one in <code className="text-[var(--text-xs)] bg-[var(--bg-tertiary)] px-1 py-0.5 rounded">.env.local</code> and restart.
            </p>
          </div>
        ) : agents.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <Users size={32} className="text-[var(--text-muted)]" />
            <p className="text-[var(--text-base)] text-[var(--text-muted)]">
              No agents discovered. Click Sync Agents on the Team page.
            </p>
          </div>
        ) : (
          <>
            {/* Agent selector pills */}
            <div className="px-5 py-3 border-b border-[var(--border-default)] flex gap-2 overflow-x-auto">
              {agents.map((agent) => {
                const color = resolveColor(agent.color);
                const isSelected = agent.agentId === selectedAgentId;
                return (
                  <button
                    key={agent.id}
                    onClick={() => setSelectedAgentId(agent.agentId)}
                    className={clsx(
                      'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[var(--text-xs)] font-medium whitespace-nowrap transition-all shrink-0',
                      isSelected
                        ? 'text-white shadow-sm'
                        : 'hover:opacity-80'
                    )}
                    style={
                      isSelected
                        ? { background: color.border, color: '#fff', border: `1px solid ${color.border}` }
                        : { background: color.bgRgba, border: '1px solid transparent', color: 'var(--text-primary)' }
                    }
                  >
                    <span>{agent.emoji}</span>
                    <span>{agent.name}</span>
                  </button>
                );
              })}
            </div>

            {/* Messages area */}
            <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-3">
              {loadingHistory ? (
                <div className="flex-1 flex items-center justify-center">
                  <Loader2 size={20} className="animate-spin text-[var(--text-muted)]" />
                </div>
              ) : messages.length === 0 ? (
                <div className="flex-1 flex items-center justify-center">
                  <p className="text-[var(--text-sm)] text-[var(--text-muted)]">
                    Send a message to start a conversation
                  </p>
                </div>
              ) : (
                messages.map((msg, i) => {
                  const isUser = msg.role === 'user';
                  return (
                    <div
                      key={i}
                      className={clsx('flex', isUser ? 'justify-end' : 'justify-start')}
                    >
                      <div
                        className={clsx(
                          'max-w-[80%] rounded-[var(--radius-lg)] px-4 py-2.5 text-[var(--text-sm)]',
                          isUser
                            ? 'bg-[var(--accent-primary)] text-white'
                            : 'bg-[var(--card)] border border-[var(--border-default)] text-[var(--text-primary)]'
                        )}
                      >
                        <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                        {msg.ts && (
                          <p
                            className={clsx(
                              'text-[11px] mt-1',
                              isUser ? 'text-white/60' : 'text-[var(--text-muted)]'
                            )}
                          >
                            {relativeTime(msg.ts)}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Error toast */}
            {error && (
              <div className="mx-5 mb-2 px-4 py-2 rounded-[var(--radius-md)] bg-[var(--error-subtle)] border border-[var(--error)] text-[var(--error)] text-[var(--text-xs)]">
                {error}
              </div>
            )}

            {/* Input area */}
            <div className="p-5 border-t border-[var(--border-default)]">
              <div className="flex gap-3">
                <textarea
                  ref={textareaRef}
                  value={chatMsg}
                  onChange={(e) => setChatMsg(e.target.value)}
                  placeholder={selectedAgent ? `Message ${selectedAgent.name}...` : 'Type a message...'}
                  rows={2}
                  className="flex-1 px-4 py-3 text-[var(--text-base)] bg-[var(--bg-secondary)] border border-[var(--border-strong)] rounded-[var(--radius-md)] text-[var(--text-primary)] placeholder-[var(--text-muted)] resize-none outline-none focus:border-[var(--accent-primary)] transition-colors"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSend();
                  }}
                />
                <button
                  onClick={handleSend}
                  disabled={!chatMsg.trim() || sending || !selectedAgentId}
                  className="self-end p-3 bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-white rounded-[var(--radius-md)] disabled:opacity-50 transition-all"
                >
                  {sending ? (
                    <Loader2 size={18} className="animate-spin" />
                  ) : (
                    <Send size={18} />
                  )}
                </button>
              </div>
              <p className="text-[11px] text-[var(--text-muted)] mt-2 text-center">
                powered by {runtimeName}
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
