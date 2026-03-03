'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { clsx } from 'clsx';
import {
  LayoutDashboard,
  Kanban,
  Bot,
  Clock,
  Calendar,
  Activity,
  Settings,
  Zap,
  ChevronLeft,
  ChevronRight,
  Circle,
} from 'lucide-react';
import { useState } from 'react';
import { useGateway } from '@/lib/hooks';

interface NavItem {
  name: string;
  href: string;
  icon: React.ElementType;
  badge?: string | number;
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
    disconnected: 'text-zinc-500',
    error: 'text-red-500',
  }[state];

  return (
    <aside
      className={clsx(
        'flex flex-col h-screen border-r border-[var(--border-default)] bg-[var(--bg-secondary)]',
        'transition-all duration-200 ease-in-out',
        collapsed ? 'w-[52px]' : 'w-[220px]'
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 h-12 px-3 border-b border-[var(--border-default)]">
        {!collapsed && (
          <>
            <Zap size={18} className="text-[var(--accent-primary)] shrink-0" />
            <span className="text-sm font-semibold text-[var(--text-primary)] truncate">
              Mission Control
            </span>
          </>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className={clsx(
            'p-1 rounded hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)]',
            'transition-colors',
            collapsed ? 'mx-auto' : 'ml-auto'
          )}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </button>
      </div>

      {/* Connection status */}
      <div className={clsx(
        'flex items-center gap-2 px-3 py-1.5',
        'text-xs',
        collapsed && 'justify-center'
      )}>
        <Circle size={6} className={clsx(connectionColor, 'fill-current')} />
        {!collapsed && (
          <span className="text-[var(--text-tertiary)] truncate">
            {state === 'connected' ? 'Gateway' : state}
          </span>
        )}
      </div>

      {/* Main nav */}
      <nav className="flex-1 px-2 py-1 space-y-0.5 overflow-y-auto">
        {navigation.map((item) => {
          const isActive = pathname === item.href ||
            (item.href !== '/' && pathname.startsWith(item.href));
          return (
            <Link
              key={item.name}
              href={item.href}
              className={clsx(
                'flex items-center gap-2.5 px-2 py-1.5 rounded-md text-[13px]',
                'transition-colors duration-100',
                isActive
                  ? 'bg-[var(--accent-muted)] text-[var(--accent-primary)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
                collapsed && 'justify-center px-0'
              )}
              title={collapsed ? item.name : undefined}
            >
              <item.icon size={16} className="shrink-0" />
              {!collapsed && (
                <>
                  <span className="truncate">{item.name}</span>
                  {item.badge !== undefined && (
                    <span className="ml-auto text-[11px] bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] px-1.5 py-0.5 rounded-full">
                      {item.badge}
                    </span>
                  )}
                </>
              )}
            </Link>
          );
        })}
      </nav>

      {/* Bottom nav */}
      <div className="px-2 py-2 border-t border-[var(--border-subtle)]">
        {bottomNav.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.name}
              href={item.href}
              className={clsx(
                'flex items-center gap-2.5 px-2 py-1.5 rounded-md text-[13px]',
                'transition-colors duration-100',
                isActive
                  ? 'bg-[var(--accent-muted)] text-[var(--accent-primary)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
                collapsed && 'justify-center px-0'
              )}
              title={collapsed ? item.name : undefined}
            >
              <item.icon size={16} className="shrink-0" />
              {!collapsed && <span className="truncate">{item.name}</span>}
            </Link>
          );
        })}
      </div>
    </aside>
  );
}
