'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw, MessageCircle, Sun, Moon, Menu, User, Settings, LogOut, ChevronDown } from 'lucide-react';
import { clsx } from 'clsx';
import { useGateway } from '@/lib/hooks';
import { useWSConnected, useHttpAvailable } from '@/lib/ws';
import { useTheme } from '@/components/ThemeProvider';
import { PingPanel } from '@/components/PingPanel';
import { SettingsModal } from '@/components/SettingsModal';
import { useMobileMenu } from '@/lib/mobile-menu-context';

export function TopBar() {
  const router = useRouter();
  const { state: gatewayState } = useGateway();
  const wsConnected = useWSConnected();
  const httpAvailable = useHttpAvailable();
  const [showChat, setShowChat] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const { theme, toggle: toggleTheme } = useTheme();
  const { mobileOpen, setMobileOpen } = useMobileMenu();
  const userMenuRef = useRef<HTMLDivElement>(null);

  // Close user menu on outside click
  useEffect(() => {
    if (!showUserMenu) return;
    const handler = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showUserMenu]);

  const handleLogout = async () => {
    setShowUserMenu(false);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      router.push('/login');
    } catch (e) {
      console.error('Logout error:', e);
    }
  };

  // Determine connection status
  // Priority: WS connected > HTTP available > disconnected
  const isConnected = wsConnected || httpAvailable;
  const statusLabel = wsConnected ? 'Live' : httpAvailable ? 'Cloud' : 'Offline';
  const statusColor = wsConnected ? 'bg-[var(--success)]' : httpAvailable ? 'bg-blue-500' : 'bg-zinc-600';
  const statusGlow = wsConnected ? 'shadow-[0_0_8px_rgba(52,211,153,0.5)]' : httpAvailable ? 'shadow-[0_0_8px_rgba(59,130,246,0.5)]' : '';

  const handleRefresh = () => {
    setRefreshing(true);
    window.location.reload();
  };

  return (
    <>
      <header className="h-14 bg-[var(--bg-primary)] flex items-center px-6 gap-4 shrink-0 z-30 border-b border-[var(--border-default)]">
        {/* Mobile Hamburger Button */}
        <button
          onClick={() => setMobileOpen(!mobileOpen)}
          className="md:hidden p-2 rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
          title="Toggle sidebar"
        >
          <Menu size={18} />
        </button>

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
              statusColor,
              statusGlow
            )} />
            <span className="text-[var(--text-xs)] text-[var(--text-muted)]">{statusLabel}</span>
          </div>

          {/* User Menu */}
          <div ref={userMenuRef} className="relative ml-1">
            <button
              onClick={() => setShowUserMenu(!showUserMenu)}
              aria-label="User menu"
              aria-expanded={showUserMenu}
              aria-haspopup="true"
              className={clsx(
                'flex items-center gap-1.5 p-1.5 rounded-[var(--radius-md)] transition-colors',
                showUserMenu
                  ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]'
                  : 'hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'
              )}
            >
              <div className="w-6 h-6 rounded-full bg-[var(--accent-muted)] flex items-center justify-center">
                <User size={13} className="text-[var(--accent-primary)]" />
              </div>
              <ChevronDown size={12} className={clsx(
                'text-[var(--text-muted)] transition-transform hidden sm:block',
                showUserMenu && 'rotate-180'
              )} />
            </button>

            {/* Dropdown Menu */}
            {showUserMenu && (
              <div
                className="absolute right-0 mt-1.5 w-48 rounded-[var(--radius-lg)] border border-[var(--border-default)] bg-[var(--card)] shadow-[var(--shadow-md)] overflow-hidden z-50"
                role="menu"
                aria-label="User menu"
              >
                <div className="p-1.5">
                  <button
                    onClick={() => {
                      setShowUserMenu(false);
                      setShowSettings(true);
                    }}
                    role="menuitem"
                    className="w-full flex items-center gap-2.5 px-3 py-2 rounded-[var(--radius-md)] text-[var(--text-sm)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors text-left"
                  >
                    <Settings size={14} className="text-[var(--text-secondary)]" />
                    Settings
                  </button>
                  <button
                    onClick={handleLogout}
                    role="menuitem"
                    className="w-full flex items-center gap-2.5 px-3 py-2 rounded-[var(--radius-md)] text-[var(--text-sm)] text-red-500 hover:bg-red-500/10 transition-colors text-left"
                  >
                    <LogOut size={14} />
                    Logout
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      <PingPanel open={showChat} onClose={() => setShowChat(false)} />
      <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} />
    </>
  );
}
