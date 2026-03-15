'use client';

import { useState } from 'react';
import { RefreshCw, MessageCircle, Sun, Moon } from 'lucide-react';
import { clsx } from 'clsx';
import { useGateway } from '@/lib/hooks';
import { useTheme } from '@/components/ThemeProvider';
import { PingPanel } from '@/components/PingPanel';

export function TopBar() {
  const { state } = useGateway();
  const [showChat, setShowChat] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const { theme, toggle: toggleTheme } = useTheme();

  const handleRefresh = () => {
    setRefreshing(true);
    window.location.reload();
  };

  return (
    <>
      <header className="h-14 bg-[var(--bg-primary)] flex items-center px-6 gap-4 shrink-0 z-30">
        <div className="flex-1" />
        {/* Right — actions */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setShowChat(true)}
            className={clsx(
              'flex items-center gap-2 px-3 py-1.5 text-[var(--text-xs)] font-semibold rounded-[var(--radius-md)] transition-all',
              'bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-white',
              'shadow-[0_1px_2px_rgba(0,0,0,0.3)] hover:shadow-[var(--shadow-md),0_0_20px_var(--accent-glow)]'
            )}
          >
            <MessageCircle size={13} />
            Ping
          </button>
          <button
            onClick={toggleTheme}
            className="p-2 rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button
            onClick={handleRefresh}
            className="p-2 rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
            title="Refresh"
          >
            <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
          </button>

          {/* Status dot */}
          <div className="flex items-center gap-1.5 ml-1">
            <div className={clsx(
              'w-2 h-2 rounded-full',
              state === 'connected' ? 'bg-[var(--success)] shadow-[0_0_8px_rgba(52,211,153,0.5)]' : 'bg-zinc-600'
            )} />
            <span className="text-[var(--text-xs)] text-[var(--text-muted)]">{state === 'connected' ? 'Live' : 'Offline'}</span>
          </div>
        </div>
      </header>

      <PingPanel open={showChat} onClose={() => setShowChat(false)} />
    </>
  );
}
