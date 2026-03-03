'use client';

import { useState } from 'react';
import { Search, RefreshCw, MessageCircle, X, Send, Loader2, Flame } from 'lucide-react';
import { clsx } from 'clsx';
import { useGateway } from '@/lib/hooks';

export function TopBar() {
  const { gateway, state } = useGateway();
  const [searchQuery, setSearchQuery] = useState('');
  const [showChat, setShowChat] = useState(false);
  const [chatMsg, setChatMsg] = useState('');
  const [sending, setSending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = () => {
    setRefreshing(true);
    window.location.reload();
  };

  const handleSendChat = async () => {
    if (!chatMsg.trim() || sending || !gateway) return;
    setSending(true);
    try {
      await gateway.sendChat(chatMsg.trim());
      setChatMsg('');
      setShowChat(false);
    } catch (e) {
      console.error('Chat send failed:', e);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <header className="h-14 border-b border-[var(--border-default)] bg-[var(--bg-primary)] flex items-center justify-between px-5 gap-4 shrink-0 z-30">
        {/* Left — search */}
        <div className="flex items-center gap-3 flex-1 max-w-md">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search..."
              className="w-full pl-9 pr-3 py-1.5 text-sm bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent-primary)] transition-colors"
            />
          </div>
        </div>

        {/* Right — actions */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowChat(true)}
            className={clsx(
              'flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-[var(--radius-md)] transition-all',
              'bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-white',
              'shadow-[0_1px_2px_rgba(0,0,0,0.3)] hover:shadow-[var(--shadow-md),0_0_20px_var(--accent-glow)]'
            )}
          >
            <MessageCircle size={14} />
            Ping
          </button>
          <button
            onClick={handleRefresh}
            className="p-2 rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
            title="Refresh"
          >
            <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
          </button>

          {/* Status dot */}
          <div className={clsx(
            'w-2 h-2 rounded-full',
            state === 'connected' ? 'bg-[var(--success)] shadow-[0_0_6px_rgba(34,197,94,0.5)]' : 'bg-zinc-600'
          )} />
        </div>
      </header>

      {/* Chat slide-out */}
      {showChat && (
        <div className="fixed inset-0 z-50 flex justify-end" onClick={() => setShowChat(false)}>
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
          <div
            className="relative w-full max-w-md h-full bg-[var(--bg-primary)] border-l border-[var(--border-default)] shadow-[var(--shadow-lg)] flex flex-col animate-[slide-in_0.2s_ease-out]"
            onClick={e => e.stopPropagation()}
            style={{ animationName: 'none' }} // CSS animation via class
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-default)]">
              <div className="flex items-center gap-2">
                <Flame size={16} className="text-[var(--accent-primary)]" />
                <h2 className="text-sm font-semibold">Ping Henry</h2>
              </div>
              <button onClick={() => setShowChat(false)} className="p-1.5 rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)]">
                <X size={16} />
              </button>
            </div>

            <div className="flex-1 p-4 flex items-center justify-center text-sm text-[var(--text-muted)]">
              Send a message to start a conversation
            </div>

            <div className="p-4 border-t border-[var(--border-default)]">
              <div className="flex gap-2">
                <textarea
                  value={chatMsg}
                  onChange={e => setChatMsg(e.target.value)}
                  placeholder="Type a message..."
                  rows={2}
                  className="flex-1 px-3 py-2 text-sm bg-[var(--bg-secondary)] border border-[var(--border-strong)] rounded-[var(--radius-md)] text-[var(--text-primary)] placeholder-[var(--text-muted)] resize-none outline-none focus:border-[var(--accent-primary)] transition-colors"
                  onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) handleSendChat(); }}
                  autoFocus
                />
                <button
                  onClick={handleSendChat}
                  disabled={!chatMsg.trim() || sending}
                  className="self-end p-2.5 bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-white rounded-[var(--radius-md)] disabled:opacity-50 transition-all"
                >
                  {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
