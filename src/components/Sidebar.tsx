'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { clsx } from 'clsx';
import {
  LayoutDashboard, FolderKanban, Layers, Bot, Zap, Calendar,
  Activity, Settings, ChevronLeft, ChevronRight, Atom,
  Brain, FileText, Users, Eye, Timer,
} from 'lucide-react';
import { useState } from 'react';
import { useGateway } from '@/lib/hooks';

const navigation = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Team', href: '/team', icon: Users },
  { name: 'Scheduler', href: '/scheduler', icon: Timer },
  { name: 'Context', href: '/context', icon: Layers },
  { name: 'Vision', href: '/vision', icon: Eye },
  { name: 'Calendar', href: '/calendar', icon: Calendar },
  { name: 'Agents', href: '/agents', icon: Bot },
  { name: 'Automations', href: '/cron', icon: Zap },
  { name: 'Activity', href: '/activity', icon: Activity },
  { name: 'Memory', href: '/memory', icon: Brain },
  { name: 'Docs', href: '/docs', icon: FileText },
];

const bottomNav = [
  { name: 'Settings', href: '/settings', icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const { state } = useGateway();

  return (
    <aside className={clsx(
      'flex flex-col h-screen border-r border-[var(--border-default)] bg-[var(--bg-primary)]',
      'transition-all duration-200',
      collapsed ? 'w-[56px]' : 'w-[210px]'
    )}>
      {/* Header */}
      <div className="flex items-center gap-2.5 h-14 px-3.5 border-b border-[var(--border-default)]">
        {!collapsed && (
          <>
            <Atom size={18} className="text-[var(--accent-primary)] shrink-0" />
            <span className="text-[var(--text-base)] font-bold tracking-tight text-[var(--text-primary)] leading-tight truncate">
              Org Studio
            </span>
          </>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className={clsx(
            'p-1.5 rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] transition-colors',
            collapsed ? 'mx-auto' : 'ml-auto'
          )}
        >
          {collapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
        </button>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2.5 py-3 space-y-0.5 overflow-y-auto">
        {navigation.map((item) => {
          const isActive = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
          return (
            <Link key={item.name} href={item.href}
              className={clsx(
                'flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-[var(--text-sm)] font-medium transition-all duration-100',
                isActive
                  ? 'bg-[var(--accent-muted)] text-[var(--accent-primary)]'
                  : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
                collapsed && 'justify-center px-0'
              )}
              title={collapsed ? item.name : undefined}
            >
              <item.icon size={17} className={clsx('shrink-0', isActive ? 'opacity-100' : 'opacity-70')} />
              {!collapsed && <span className="truncate">{item.name}</span>}
            </Link>
          );
        })}
      </nav>

      {/* Bottom */}
      <div className="px-2.5 py-3 border-t border-[var(--border-subtle)]">
        {bottomNav.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link key={item.name} href={item.href}
              className={clsx(
                'flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-[var(--text-sm)] font-medium transition-all duration-100',
                isActive
                  ? 'bg-[var(--accent-muted)] text-[var(--accent-primary)]'
                  : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
                collapsed && 'justify-center px-0'
              )}
              title={collapsed ? item.name : undefined}
            >
              <item.icon size={17} className="shrink-0 opacity-70" />
              {!collapsed && <span className="truncate">{item.name}</span>}
            </Link>
          );
        })}
      </div>
    </aside>
  );
}
