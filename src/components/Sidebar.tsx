'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { clsx } from 'clsx';
import {
  LayoutDashboard, Kanban, Bot, Clock, Calendar, Activity, Settings,
  ChevronLeft, ChevronRight, Circle, Flame,
} from 'lucide-react';
import { useState } from 'react';
import { useGateway } from '@/lib/hooks';

interface NavItem {
  name: string;
  href: string;
  icon: React.ElementType;
}

const navigation: NavItem[] = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Projects', href: '/projects', icon: Kanban },
  { name: 'Agents', href: '/agents', icon: Bot },
  { name: 'Cron Jobs', href: '/cron', icon: Clock },
  { name: 'Calendar', href: '/calendar', icon: Calendar },
  { name: 'Activity', href: '/activity', icon: Activity },
];

const bottomNav: NavItem[] = [
  { name: 'Settings', href: '/settings', icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const { state } = useGateway();

  const connectionColor = {
    connected: 'text-green-500',
    connecting: 'text-yellow-500',
    disconnected: 'text-zinc-600',
    error: 'text-red-500',
  }[state];

  const statusDotClass = clsx(
    'w-[6px] h-[6px] rounded-full',
    state === 'connected' && 'bg-[var(--success)] shadow-[0_0_8px_rgba(34,197,94,0.5)]',
    state === 'connecting' && 'bg-[var(--warning)] shadow-[0_0_8px_rgba(245,158,11,0.5)] animate-pulse',
    state === 'disconnected' && 'bg-zinc-600',
    state === 'error' && 'bg-[var(--error)] shadow-[0_0_8px_rgba(239,68,68,0.5)] animate-[pulse-subtle_2s_ease-in-out_infinite]',
  );

  return (
    <aside
      className={clsx(
        'flex flex-col h-screen border-r border-[var(--border-default)] bg-[var(--bg-primary)]',
        'transition-all duration-200',
        collapsed ? 'w-[52px]' : 'w-[220px]'
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 h-14 px-3 border-b border-[var(--border-default)]">
        {!collapsed && (
          <>
            <Flame size={20} className="text-[var(--accent-primary)] shrink-0" />
            <div className="flex flex-col gap-px truncate">
              <span className="text-sm font-bold tracking-tight text-[var(--text-primary)] leading-tight">
                Mission Control
              </span>
              <span className="text-[10px] font-medium text-[var(--text-muted)] uppercase tracking-[0.05em] leading-none">
                OpenClaw
              </span>
            </div>
          </>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className={clsx(
            'p-1.5 rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)]',
            'transition-colors',
            collapsed ? 'mx-auto' : 'ml-auto'
          )}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </button>
      </div>

      {/* Connection status */}
      <div className={clsx(
        'flex items-center gap-2 px-3 py-2',
        collapsed && 'justify-center'
      )}>
        <div className={statusDotClass} />
        {!collapsed && (
          <span className="text-xs text-[var(--text-tertiary)]">
            {state === 'connected' ? 'Gateway' : state}
          </span>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-1 space-y-0.5 overflow-y-auto">
        {navigation.map((item) => {
          const isActive = pathname === item.href ||
            (item.href !== '/' && pathname.startsWith(item.href));
          return (
            <Link
              key={item.name}
              href={item.href}
              className={clsx(
                'flex items-center gap-2.5 px-2.5 py-2 rounded-[var(--radius-md)] text-[13px] font-medium',
                'transition-all duration-100',
                isActive
                  ? 'bg-[var(--accent-muted)] text-[var(--accent-primary)]'
                  : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
                collapsed && 'justify-center px-0'
              )}
              title={collapsed ? item.name : undefined}
            >
              <item.icon size={16} className={clsx('shrink-0', isActive ? 'opacity-100' : 'opacity-70')} />
              {!collapsed && <span className="truncate">{item.name}</span>}
            </Link>
          );
        })}
      </nav>

      {/* Bottom */}
      <div className="px-2 py-2 border-t border-[var(--border-subtle)]">
        {bottomNav.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.name}
              href={item.href}
              className={clsx(
                'flex items-center gap-2.5 px-2.5 py-2 rounded-[var(--radius-md)] text-[13px] font-medium',
                'transition-all duration-100',
                isActive
                  ? 'bg-[var(--accent-muted)] text-[var(--accent-primary)]'
                  : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
                collapsed && 'justify-center px-0'
              )}
              title={collapsed ? item.name : undefined}
            >
              <item.icon size={16} className="shrink-0 opacity-70" />
              {!collapsed && <span className="truncate">{item.name}</span>}
            </Link>
          );
        })}
      </div>
    </aside>
  );
}
