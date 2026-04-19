'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  X, Bell, BellOff, Building2, LogOut, ChevronDown, ChevronRight,
  Shield, Zap, AlertCircle, Settings, Monitor, Smartphone, Tablet,
} from 'lucide-react';
import { clsx } from 'clsx';
import { WorkspaceInfoCard, WorkspaceSwitcher } from '@/components/WorkspaceSwitcher';
import { FEATURE_FLAGS, isFeatureEnabled, toggleFeatureFlag } from '@/lib/feature-flags';

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

interface NotificationPref {
  key: string;
  label: string;
  description: string;
  icon: typeof Bell;
  desktopOnly?: boolean; // hide on mobile for simplicity
}

/* ------------------------------------------------------------------ */
/*  Notification preference definitions                               */
/* ------------------------------------------------------------------ */

const NOTIFICATION_PREFS: NotificationPref[] = [
  {
    key: 'task-updates',
    label: 'Task Updates',
    description: 'Get notified when tasks are assigned, moved, or completed',
    icon: Bell,
  },
  {
    key: 'mentions',
    label: 'Mentions',
    description: 'Alerts when you are @mentioned in comments or chat',
    icon: Bell,
  },
  {
    key: 'dm-messages',
    label: 'Direct Messages',
    description: 'Receive notifications for new DMs',
    icon: Bell,
  },
  {
    key: 'project-activity',
    label: 'Project Activity',
    description: 'Digest of project-wide updates and milestones',
    icon: Bell,
    desktopOnly: true,
  },
  {
    key: 'agent-status',
    label: 'Agent Status Changes',
    description: 'When agents come online/offline or change status',
    icon: Bell,
    desktopOnly: true,
  },
];

/* ------------------------------------------------------------------ */
/*  Helper: localStorage-backed notification prefs                    */
/* ------------------------------------------------------------------ */

function getNotifPref(key: string): boolean {
  if (typeof window === 'undefined') return true;
  const val = localStorage.getItem(`notif:${key}`);
  return val !== 'false'; // default on
}

function setNotifPref(key: string, enabled: boolean): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(`notif:${key}`, String(enabled));
}

/* ------------------------------------------------------------------ */
/*  Toggle component                                                  */
/* ------------------------------------------------------------------ */

function Toggle({
  enabled,
  onChange,
  label,
}: {
  enabled: boolean;
  onChange: (val: boolean) => void;
  label: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      onClick={() => onChange(!enabled)}
      className={clsx(
        'relative shrink-0 w-10 h-6 rounded-full transition-colors border-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)]',
        enabled
          ? 'bg-[var(--success)] border-[var(--success)]'
          : 'bg-[var(--bg-tertiary)] border-[var(--border-default)]',
      )}
    >
      <span
        className={clsx(
          'block w-4 h-4 rounded-full bg-white transition-transform',
          enabled ? 'translate-x-4' : 'translate-x-0',
        )}
      />
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Accordion section (mobile-friendly collapsible)                   */
/* ------------------------------------------------------------------ */

function AccordionSection({
  title,
  icon: Icon,
  defaultOpen = false,
  children,
  badge,
}: {
  title: string;
  icon: typeof Bell;
  defaultOpen?: boolean;
  children: React.ReactNode;
  badge?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border border-[var(--border-default)] rounded-[var(--radius-lg)] overflow-hidden bg-[var(--card)] shadow-[var(--shadow-sm)]">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[var(--bg-hover)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent-primary)]"
      >
        <Icon size={16} className="text-[var(--text-secondary)] shrink-0" />
        <span className="flex-1 text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">
          {title}
        </span>
        {badge && (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-[var(--accent-muted)] text-[var(--accent-primary)]">
            {badge}
          </span>
        )}
        <ChevronDown
          size={14}
          className={clsx(
            'text-[var(--text-muted)] transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      {open && (
        <div className="px-4 pb-4 pt-1 border-t border-[var(--border-subtle)]">
          {children}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Notification Settings Section                                     */
/* ------------------------------------------------------------------ */

function NotificationSettings({ compact = false }: { compact?: boolean }) {
  const [prefs, setPrefs] = useState<Record<string, boolean>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const p: Record<string, boolean> = {};
    for (const n of NOTIFICATION_PREFS) {
      p[n.key] = getNotifPref(n.key);
    }
    setPrefs(p);
    setLoaded(true);
  }, []);

  const handleToggle = (key: string, val: boolean) => {
    setPrefs((prev) => ({ ...prev, [key]: val }));
    setNotifPref(key, val);
  };

  if (!loaded) {
    return <div className="h-16 bg-[var(--bg-secondary)] rounded-[var(--radius-md)] animate-pulse" />;
  }

  // On mobile (compact), only show essential prefs
  const visiblePrefs = compact
    ? NOTIFICATION_PREFS.filter((n) => !n.desktopOnly)
    : NOTIFICATION_PREFS;

  return (
    <div className="space-y-3 mt-2">
      {/* Master toggle */}
      <div className="flex items-center justify-between px-3 py-2.5 rounded-[var(--radius-md)] bg-[var(--bg-primary)] border border-[var(--border-subtle)]">
        <div className="flex items-center gap-2">
          {Object.values(prefs).every(Boolean) ? (
            <Bell size={14} className="text-[var(--success)]" />
          ) : (
            <BellOff size={14} className="text-[var(--text-muted)]" />
          )}
          <span className="text-[var(--text-sm)] font-medium text-[var(--text-primary)]">
            All Notifications
          </span>
        </div>
        <Toggle
          enabled={Object.values(prefs).every(Boolean)}
          onChange={(val) => {
            const updated: Record<string, boolean> = {};
            for (const n of NOTIFICATION_PREFS) {
              updated[n.key] = val;
              setNotifPref(n.key, val);
            }
            setPrefs(updated);
          }}
          label="Toggle all notifications"
        />
      </div>

      {/* Individual toggles */}
      {visiblePrefs.map((n) => (
        <div
          key={n.key}
          className="flex items-start justify-between gap-3 px-3 py-2 rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] transition-colors"
        >
          <div className="flex-1 min-w-0">
            <p className="text-[var(--text-xs)] font-medium text-[var(--text-primary)]">{n.label}</p>
            {!compact && (
              <p className="text-[var(--text-xs)] text-[var(--text-tertiary)] mt-0.5">{n.description}</p>
            )}
          </div>
          <Toggle
            enabled={prefs[n.key] ?? true}
            onChange={(val) => handleToggle(n.key, val)}
            label={`Toggle ${n.label}`}
          />
        </div>
      ))}

      {/* Feature flag callout */}
      <div className="flex items-start gap-2 px-3 py-2.5 rounded-[var(--radius-md)] bg-[color-mix(in_srgb,var(--accent-primary)_5%,var(--bg-primary))] border border-[color-mix(in_srgb,var(--accent-primary)_15%,var(--border-default))] text-[var(--text-xs)] text-[var(--text-tertiary)]">
        <Zap size={12} className="mt-0.5 shrink-0 text-[var(--accent-primary)]" />
        <span>
          Push notifications require the <strong>Push Notifications</strong> feature flag enabled in{' '}
          <span className="text-[var(--accent-primary)] font-medium">Experimental Features</span>.
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Experimental Features Section (inline version)                    */
/* ------------------------------------------------------------------ */

function ExperimentalFlagsInline() {
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const f: Record<string, boolean> = {};
    for (const flag of Object.values(FEATURE_FLAGS)) {
      f[flag] = isFeatureEnabled(flag);
    }
    setFlags(f);
    setLoaded(true);

    const handler = (e: CustomEvent) => {
      setFlags((prev) => ({ ...prev, [e.detail.flag]: e.detail.enabled }));
    };
    window.addEventListener('feature-flag-changed', handler as EventListener);
    return () => window.removeEventListener('feature-flag-changed', handler as EventListener);
  }, []);

  if (!loaded) return null;

  const flagMeta: Record<string, { label: string; desc: string }> = {
    [FEATURE_FLAGS.MOBILE_FIRST_UX]: {
      label: 'Mobile-First UX',
      desc: 'Tab-based interface with threaded inbox',
    },
    [FEATURE_FLAGS.PUSH_NOTIFICATIONS]: {
      label: 'Push Notifications',
      desc: 'Desktop/mobile push for task updates',
    },
    [FEATURE_FLAGS.TELEGRAM_MIGRATION]: {
      label: 'Telegram Migration',
      desc: 'Tools to migrate from Telegram',
    },
  };

  return (
    <div className="space-y-2 mt-2">
      {Object.entries(flags).map(([flag, enabled]) => {
        const meta = flagMeta[flag];
        if (!meta) return null;
        return (
          <div
            key={flag}
            className="flex items-center justify-between gap-3 px-3 py-2 rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="text-[var(--text-xs)] font-medium text-[var(--text-primary)]">{meta.label}</p>
                <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-amber-500/10 text-[9px] font-medium text-amber-400 uppercase tracking-wider">
                  Beta
                </span>
              </div>
              <p className="text-[var(--text-xs)] text-[var(--text-tertiary)] mt-0.5">{meta.desc}</p>
            </div>
            <Toggle
              enabled={enabled}
              onChange={() => {
                toggleFeatureFlag(flag as any);
                setFlags((prev) => ({ ...prev, [flag]: !prev[flag] }));
              }}
              label={`Toggle ${meta.label}`}
            />
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Logout Confirmation                                               */
/* ------------------------------------------------------------------ */

function LogoutSection({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      onClose();
      router.push('/login');
    } catch (e) {
      console.error('Logout error:', e);
      setLoggingOut(false);
      setConfirming(false);
    }
  };

  if (confirming) {
    return (
      <div className="mt-2 px-3 py-3 rounded-[var(--radius-md)] bg-[color-mix(in_srgb,var(--error)_5%,var(--bg-primary))] border border-[color-mix(in_srgb,var(--error)_20%,var(--border-default))]">
        <p className="text-[var(--text-xs)] text-[var(--text-secondary)] mb-3">
          Are you sure you want to log out? You&apos;ll need to sign in again to access the dashboard.
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={handleLogout}
            disabled={loggingOut}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-md)] text-[var(--text-xs)] font-medium bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <LogOut size={12} />
            {loggingOut ? 'Logging out…' : 'Confirm Logout'}
          </button>
          <button
            onClick={() => setConfirming(false)}
            className="px-3 py-1.5 rounded-[var(--radius-md)] text-[var(--text-xs)] font-medium bg-[var(--bg-tertiary)] border border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      className="mt-2 w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-[var(--radius-md)] text-[var(--text-sm)] font-medium text-red-500 border border-red-500/20 hover:bg-red-500/10 transition-colors"
    >
      <LogOut size={14} />
      Logout
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Main SettingsModal                                                */
/* ------------------------------------------------------------------ */

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [isTablet, setIsTablet] = useState(false);

  // Responsive breakpoint tracking
  useEffect(() => {
    const check = () => {
      const w = window.innerWidth;
      setIsMobile(w < 768);
      setIsTablet(w >= 768 && w < 1024);
    };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // Focus trap: return focus to panel on open
  useEffect(() => {
    if (open && panelRef.current) {
      panelRef.current.focus();
    }
  }, [open]);

  // Prevent body scroll when modal is open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  if (!open) return null;

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onClose();
  };

  /* -------------------------------------------------------------- */
  /*  Desktop layout (1024px+): Full sections, vertical stack       */
  /* -------------------------------------------------------------- */
  const DesktopLayout = () => (
    <div className="space-y-5">
      {/* Workspace Section */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <Building2 size={16} className="text-[var(--text-secondary)]" />
          <h3 className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">Workspace</h3>
        </div>
        <div className="px-1">
          <WorkspaceInfoCard />
        </div>
      </section>

      <hr className="border-[var(--border-subtle)]" />

      {/* Notifications Section */}
      <section>
        <div className="flex items-center gap-2 mb-1">
          <Bell size={16} className="text-[var(--text-secondary)]" />
          <h3 className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">Notifications</h3>
        </div>
        <NotificationSettings />
      </section>

      <hr className="border-[var(--border-subtle)]" />

      {/* Experimental Features */}
      <section>
        <div className="flex items-center gap-2 mb-1">
          <Zap size={16} className="text-[var(--text-secondary)]" />
          <h3 className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">Experimental Features</h3>
        </div>
        <ExperimentalFlagsInline />
      </section>

      <hr className="border-[var(--border-subtle)]" />

      {/* Advanced link */}
      <section>
        <div className="flex items-center gap-2 mb-2">
          <Shield size={16} className="text-[var(--text-secondary)]" />
          <h3 className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">Advanced Settings</h3>
        </div>
        <a
          href="/settings"
          className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius-md)] text-[var(--text-xs)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
          onClick={onClose}
        >
          <Settings size={13} />
          <span>Open full Settings page for storage, backups, runtimes, and system config</span>
          <ChevronRight size={12} className="ml-auto text-[var(--text-muted)]" />
        </a>
      </section>

      <hr className="border-[var(--border-subtle)]" />

      {/* Logout */}
      <LogoutSection onClose={onClose} />
    </div>
  );

  /* -------------------------------------------------------------- */
  /*  Tablet layout (768-1024px): Key sections visible              */
  /* -------------------------------------------------------------- */
  const TabletLayout = () => (
    <div className="space-y-4">
      {/* Workspace */}
      <AccordionSection title="Workspace" icon={Building2} defaultOpen>
        <WorkspaceInfoCard />
      </AccordionSection>

      {/* Notifications */}
      <AccordionSection title="Notifications" icon={Bell} defaultOpen>
        <NotificationSettings />
      </AccordionSection>

      {/* Experimental */}
      <AccordionSection title="Experimental Features" icon={Zap}>
        <ExperimentalFlagsInline />
      </AccordionSection>

      {/* Advanced link */}
      <a
        href="/settings"
        className="flex items-center gap-2 px-4 py-3 rounded-[var(--radius-lg)] border border-[var(--border-default)] bg-[var(--card)] text-[var(--text-xs)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors shadow-[var(--shadow-sm)]"
        onClick={onClose}
      >
        <Settings size={14} className="shrink-0" />
        <span className="flex-1">Full settings (storage, backups, runtimes)</span>
        <ChevronRight size={14} className="text-[var(--text-muted)]" />
      </a>

      {/* Logout */}
      <LogoutSection onClose={onClose} />
    </div>
  );

  /* -------------------------------------------------------------- */
  /*  Mobile layout (375-768px): Simplified, essential toggles only */
  /* -------------------------------------------------------------- */
  const MobileLayout = () => (
    <div className="space-y-3">
      {/* Workspace — compact display */}
      <AccordionSection title="Workspace" icon={Building2}>
        <WorkspaceInfoCard />
      </AccordionSection>

      {/* Notifications — compact (fewer options) */}
      <AccordionSection title="Notifications" icon={Bell} defaultOpen>
        <NotificationSettings compact />
      </AccordionSection>

      {/* Full settings link */}
      <a
        href="/settings"
        className="flex items-center gap-2 px-4 py-3 rounded-[var(--radius-lg)] border border-[var(--border-default)] bg-[var(--card)] text-[var(--text-xs)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
        onClick={onClose}
      >
        <Settings size={14} className="shrink-0" />
        <span className="flex-1">All Settings</span>
        <ChevronRight size={14} className="text-[var(--text-muted)]" />
      </a>

      {/* Logout */}
      <LogoutSection onClose={onClose} />
    </div>
  );

  return (
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 backdrop-blur-sm overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={clsx(
          'relative bg-[var(--bg-primary)] border border-[var(--border-default)] shadow-[var(--shadow-lg)] outline-none',
          // Mobile: full-width bottom sheet style
          isMobile && 'w-full min-h-[60vh] max-h-[95vh] mt-auto rounded-t-2xl',
          // Tablet: centered modal, medium width
          isTablet && 'w-[560px] max-h-[85vh] mt-16 rounded-[var(--radius-lg)]',
          // Desktop: wider modal
          !isMobile && !isTablet && 'w-[600px] max-h-[85vh] mt-12 rounded-[var(--radius-lg)]',
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-default)] sticky top-0 bg-[var(--bg-primary)] z-10 rounded-t-[inherit]">
          <div className="flex items-center gap-2">
            <Settings size={16} className="text-[var(--accent-primary)]" />
            <h2 className="text-[var(--text-base)] font-bold text-[var(--text-primary)]">Settings</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close settings"
            className="p-1.5 rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
          >
            <X size={18} />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="px-5 py-5 overflow-y-auto max-h-[calc(85vh-64px)]">
          {isMobile ? (
            <MobileLayout />
          ) : isTablet ? (
            <TabletLayout />
          ) : (
            <DesktopLayout />
          )}
        </div>

        {/* Mobile drag handle */}
        {isMobile && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 w-10 h-1 rounded-full bg-[var(--border-default)]" />
        )}
      </div>
    </div>
  );
}
