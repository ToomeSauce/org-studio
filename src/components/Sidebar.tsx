'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { clsx } from 'clsx';
import {
  LayoutDashboard, FolderKanban, Layers, Settings, ChevronLeft, ChevronRight, Atom,
  LogOut, X, Menu, Lock, ChevronDown, Users,
} from 'lucide-react';
import { useState, useEffect } from 'react';
import { useGateway } from '@/lib/hooks';
import { useWSConnected } from '@/lib/ws';
import { useWSData } from '@/lib/ws';
import { useMobileMenu } from '@/lib/mobile-menu-context';

// New 5-item navigation structure
const mainNav = [
  { name: 'Home', href: '/', icon: LayoutDashboard, emoji: '🏠' },
  { name: 'Projects', href: '/projects', icon: FolderKanban, emoji: '📋', expandable: true },
  { name: 'Context', href: '/context', icon: Layers, emoji: '📊' },
  { name: 'Team', href: '/team', icon: Users, emoji: '👥' },
];

const bottomNav = [
  { name: 'Settings', href: '/settings', icon: Settings, emoji: '⚙️' },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState(false);
  const { state } = useGateway();
  const wsConnected = useWSConnected();
  const { mobileOpen, setMobileOpen } = useMobileMenu();
  const storeData = useWSData('store');
  const projects = storeData?.projects || [];

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

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      router.push('/login');
    } catch (e) {
      console.error('Logout error:', e);
      setLoggingOut(false);
    }
  };

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
          className={clsx(
            'p-1.5 rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] transition-colors',
            collapsed ? 'mx-auto' : 'ml-auto hidden md:flex'
          )}
        >
          {collapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
        </button>
        {/* Mobile close button */}
        {isMobile && mobileOpen && (
          <button
            onClick={() => setMobileOpen(false)}
            className="p-1.5 rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] ml-auto md:hidden"
          >
            <X size={18} />
          </button>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2.5 py-3 space-y-0.5 overflow-y-auto">
        {mainNav.map((item) => {
          const isActive = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
          const isProjectsSection = item.expandable;
          
          if (isProjectsSection) {
            return (
              <div key={item.name}>
                <div className="flex items-center gap-0">
                  <Link
                    href={item.href}
                    className={clsx(
                      'flex-1 flex items-center gap-3 px-3 py-2.5 rounded-l-[var(--radius-md)] text-[var(--text-sm)] font-medium transition-all duration-100 min-h-[44px] md:min-h-auto',
                      isActive || (pathname.startsWith('/projects') && !pathname.includes('[id]'))
                        ? 'bg-[var(--accent-muted)] text-[var(--accent-primary)]'
                        : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
                      collapsed && 'justify-center px-0'
                    )}
                    title={collapsed ? item.name : undefined}
                    onClick={() => {
                      // Auto-expand projects list when navigating to /projects
                      if (!expandedProjects) {
                        setExpandedProjects(true);
                      }
                    }}
                  >
                    <item.icon size={17} className="shrink-0 opacity-70" />
                    {!collapsed && (
                      <span className="truncate flex-1 text-left">{item.name}</span>
                    )}
                  </Link>
                  {!collapsed && (
                    <button
                      onClick={() => setExpandedProjects(!expandedProjects)}
                      className={clsx(
                        'p-2.5 rounded-r-[var(--radius-md)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] transition-all duration-100',
                        isActive || (pathname.startsWith('/projects') && !pathname.includes('[id]'))
                          ? 'bg-[var(--accent-muted)] text-[var(--accent-primary)]'
                          : ''
                      )}
                    >
                      <ChevronDown
                        size={15}
                        className={clsx(
                          'transition-transform duration-200 opacity-50',
                          expandedProjects && 'rotate-180'
                        )}
                      />
                    </button>
                  )}
                </div>

                {/* Expanded Projects List */}
                {expandedProjects && !collapsed && (
                  <div className="mt-1 ml-4 space-y-0.5 border-l border-[var(--border-subtle)] pl-3">
                    {projects.length === 0 ? (
                      <p className="text-xs text-[var(--text-muted)] py-2">No projects</p>
                    ) : (
                      <>
                        {(() => {
                          // Filter out archived projects
                          const activeProjects = projects.filter((p: any) => !p.isArchived);
                          // Sort projects by updatedAt or createdAt descending (most recent first)
                          const sortedProjects = [...activeProjects].sort((a, b) => {
                            const aTime = (a.updatedAt || a.createdAt || 0) as number;
                            const bTime = (b.updatedAt || b.createdAt || 0) as number;
                            return bTime - aTime; // descending order
                          });
                          return sortedProjects.map((project: any) => {
                            const projectActive = pathname === `/projects/${project.id}`;
                            return (
                              <Link
                                key={project.id}
                                href={`/projects/${project.id}`}
                                className={clsx(
                                  'flex items-center gap-2 px-3 py-2 rounded text-sm transition-all duration-100 min-h-[40px]',
                                  projectActive
                                    ? 'bg-[var(--accent-muted)] text-[var(--accent-primary)]'
                                    : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                                )}
                              >
                                <span className="text-xs">📌</span>
                                <span className="truncate text-xs">{project.name}</span>
                              </Link>
                            );
                          });
                        })()}
                        <Link
                          href="/projects?new=true"
                          className={clsx(
                            'flex items-center gap-2 px-3 py-2 rounded text-sm transition-all duration-100 min-h-[40px]',
                            'text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                          )}
                        >
                          <span className="text-xs">+</span>
                          <span className="truncate text-xs">New Project</span>
                        </Link>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          }

          return (
            <Link key={item.name} href={item.href}
              className={clsx(
                'flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-md)] text-[var(--text-sm)] font-medium transition-all duration-100 min-h-[44px] md:min-h-auto',
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
      <div className="px-2.5 py-3 pb-6 border-t border-[var(--border-subtle)] space-y-0.5 shrink-0">
        {bottomNav.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link key={item.name} href={item.href}
              className={clsx(
                'flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-md)] text-[var(--text-sm)] font-medium transition-all duration-100 min-h-[44px] md:min-h-auto',
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

        {/* Logout Button */}
        <button
          onClick={handleLogout}
          disabled={loggingOut}
          className={clsx(
            'w-full flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-md)] text-[var(--text-sm)] font-medium transition-all duration-100 min-h-[44px] md:min-h-auto',
            'text-red-500 hover:bg-red-50 dark:hover:bg-red-900 dark:hover:bg-opacity-20 hover:text-red-600',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            collapsed && 'justify-center px-0'
          )}
          title={collapsed ? 'Logout' : undefined}
        >
          <LogOut size={17} className="shrink-0 opacity-70" />
          {!collapsed && <span className="truncate">{loggingOut ? 'Logging out...' : 'Logout'}</span>}
        </button>
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

