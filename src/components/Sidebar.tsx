'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { clsx } from 'clsx';
import {
  LayoutDashboard, FolderKanban, Layers, ChevronLeft, ChevronRight, Atom,
  X, Users, Activity, Radio, CircleDollarSign,
} from 'lucide-react';
import { useState, useEffect } from 'react';
import { useMobileMenu } from '@/lib/mobile-menu-context';

// New 5-item navigation structure
const mainNav = [
  { name: 'Home', href: '/', icon: LayoutDashboard, emoji: '🏠' },
  { name: 'Projects', href: '/projects', icon: FolderKanban, emoji: '📋' },
  { name: 'Context', href: '/context', icon: Layers, emoji: '📊' },
  { name: 'Team', href: '/team', icon: Users, emoji: '👥' },
];

const bottomNav = [
  { name: 'System', href: '/system', icon: Radio, emoji: '📡' },
  { name: 'Usage', href: '/usage', icon: CircleDollarSign, emoji: '💰' },
  { name: 'Health', href: '/health', icon: Activity, emoji: '🩺' },
];

// Baked in at build time by the Docker build (--build-arg BUILD_SHA).
// Local dev builds fall back to 'dev'. Hovering the pill shows the full SHA.
const BUILD_SHA = process.env.NEXT_PUBLIC_BUILD_SHA || 'dev';

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const { mobileOpen, setMobileOpen } = useMobileMenu();

  // Close mobile menu when pathname changes
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Track window size for responsive behavior
  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768);
    };
    
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const SidebarContent = () => (
    <>
      {/* Header */}
      <div className="flex items-center gap-2.5 h-14 px-3.5 border-b border-[var(--border-default)] shrink-0">
        {!collapsed && (
          <>
            <Atom size={18} className="text-[var(--accent-primary)] shrink-0" />
            <span className="text-[var(--text-base)] font-bold tracking-tight text-[var(--text-primary)] leading-tight truncate">
              Org Studio
            </span>
          </>
        )}
        <button
          onClick={() => collapsed ? setCollapsed(false) : setCollapsed(true)}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={clsx(
            'p-1.5 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)]',
            collapsed ? 'mx-auto' : 'ml-auto hidden md:flex'
          )}
        >
          {collapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
        </button>
        {/* Mobile close button */}
        {isMobile && mobileOpen && (
          <button
            onClick={() => setMobileOpen(false)}
            aria-label="Close sidebar"
            className="p-1.5 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] ml-auto md:hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)]"
          >
            <X size={18} />
          </button>
        )}
      </div>

      {/* Nav */}
      <nav aria-label="Main navigation" className="flex-1 px-2.5 py-3 space-y-0.5 overflow-y-auto">
        {mainNav.map((item) => {
          const isActive = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
          
          return (
            <Link key={item.name} href={item.href}
              className={clsx(
                'flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-md)] text-[var(--text-sm)] font-medium transition-all duration-100 min-h-[44px] md:min-h-auto',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)]',
                isActive
                  ? 'bg-[var(--accent-muted)] text-[var(--accent-primary)]'
                  : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
                collapsed && 'justify-center px-0'
              )}
              title={collapsed ? item.name : undefined}
              aria-current={isActive ? 'page' : undefined}
            >
              <item.icon size={17} className={clsx('shrink-0', isActive ? 'opacity-100' : 'opacity-70')} />
              {!collapsed && <span className="truncate">{item.name}</span>}
            </Link>
          );
        })}
      </nav>

      {/* Bottom */}
      <div className="px-2.5 py-3 pb-6 border-t border-[var(--border-subtle)] space-y-0.5 shrink-0">
        {bottomNav.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link key={item.name} href={item.href}
              className={clsx(
                'flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-md)] text-[var(--text-sm)] font-medium transition-all duration-100 min-h-[44px] md:min-h-auto',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)]',
                isActive
                  ? 'bg-[var(--accent-muted)] text-[var(--accent-primary)]'
                  : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
                collapsed && 'justify-center px-0'
              )}
              title={collapsed ? item.name : undefined}
              aria-current={isActive ? 'page' : undefined}
            >
              <item.icon size={17} className="shrink-0 opacity-70" />
              {!collapsed && <span className="truncate">{item.name}</span>}
              {!collapsed && (
                <span
                  className="ml-auto font-mono text-[10px] leading-none px-1.5 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--text-tertiary)] tabular-nums"
                  title={`Build: ${BUILD_SHA}`}
                >
                  {BUILD_SHA.slice(0, 7)}
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </>
  );

  return (
    <>
      {/* Desktop Sidebar */}
      <aside className={clsx(
        'hidden md:flex flex-col h-screen border-r border-[var(--border-default)] bg-[var(--bg-primary)]',
        'transition-all duration-200',
        collapsed ? 'w-[56px]' : 'w-[210px]'
      )}>
        <SidebarContent />
      </aside>

      {/* Mobile Menu Button (in TopBar) - handled separately */}
      {/* Mobile Overlay */}
      {isMobile && mobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Mobile Sidebar */}
      <aside className={clsx(
        'fixed top-0 left-0 h-screen w-[210px] border-r border-[var(--border-default)] bg-[var(--bg-primary)] z-50 md:hidden',
        'transition-transform duration-200 transform',
        mobileOpen ? 'translate-x-0' : '-translate-x-full'
      )}>
        <div className="flex flex-col h-screen">
          <SidebarContent />
        </div>
      </aside>
    </>
  );
}
