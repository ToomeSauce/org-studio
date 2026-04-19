'use client';

import { useState, useEffect } from 'react';
import { FEATURE_FLAGS, isFeatureEnabled, toggleFeatureFlag } from '@/lib/feature-flags';
import { AlertCircle, Zap } from 'lucide-react';

export function FeatureFlagsSection() {
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [hasLoaded, setHasLoaded] = useState(false);

  useEffect(() => {
    // Hydrate from localStorage
    const loaded: Record<string, boolean> = {};
    for (const flag of Object.values(FEATURE_FLAGS)) {
      loaded[flag] = isFeatureEnabled(flag);
    }
    setFlags(loaded);
    setHasLoaded(true);

    // Listen for changes in other tabs
    const handler = (e: CustomEvent) => {
      setFlags(prev => ({ ...prev, [e.detail.flag]: e.detail.enabled }));
    };
    window.addEventListener('feature-flag-changed', handler as EventListener);
    return () => window.removeEventListener('feature-flag-changed', handler as EventListener);
  }, []);

  if (!hasLoaded) return <div className="h-16 bg-[var(--bg-secondary)] rounded-[var(--radius-md)] animate-pulse" />;

  const flagDescriptions: Record<string, { title: string; description: string; experimental?: boolean }> = {
    [FEATURE_FLAGS.MOBILE_FIRST_UX]: {
      title: 'Mobile-First Threaded UX',
      description: 'Try the new tab-based interface with unified inbox and thread view. Experimental — UI may change.',
      experimental: true,
    },
    [FEATURE_FLAGS.PUSH_NOTIFICATIONS]: {
      title: 'Push Notifications',
      description: 'Enable desktop/mobile push notifications for task updates and mentions.',
      experimental: true,
    },
    [FEATURE_FLAGS.TELEGRAM_MIGRATION]: {
      title: 'Telegram Migration Tools',
      description: 'Experimental tools to help migrate from Telegram to native notifications.',
      experimental: true,
    },
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 mb-4">
        <Zap size={16} className="text-[var(--accent-primary)]" />
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Experimental Features</h3>
      </div>

      {Object.entries(flags).map(([flag, enabled]) => {
        const info = flagDescriptions[flag as keyof typeof flagDescriptions];
        if (!info) return null;

        return (
          <div
            key={flag}
            className="p-3 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-secondary)] space-y-2 hover:border-[var(--border-strong)] transition-colors"
          >
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <h4 className="text-sm font-semibold text-[var(--text-primary)]">{info.title}</h4>
                  {info.experimental && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-[10px] font-medium text-amber-400 uppercase tracking-wider">
                      <AlertCircle size={10} /> Experimental
                    </span>
                  )}
                </div>
                <p className="text-xs text-[var(--text-muted)] mt-1">{info.description}</p>
              </div>

              {/* Toggle switch */}
              <button
                role="switch"
                aria-checked={enabled}
                aria-label={`Toggle ${info.title}`}
                onClick={() => {
                  toggleFeatureFlag(flag as any);
                  setFlags(prev => ({ ...prev, [flag]: !prev[flag] }));
                }}
                className={`ml-3 shrink-0 w-10 h-6 rounded-full transition-colors border-2 flex items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)] min-h-[44px] min-w-[44px] justify-center ${
                  enabled
                    ? 'bg-[var(--success)] border-[var(--success)]'
                    : 'bg-[var(--bg-tertiary)] border-[var(--border-default)]'
                }`}
              >
                <span
                  className={`block w-4 h-4 rounded-full bg-white transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0'}`}
                />
              </button>
            </div>

            {/* Warning note */}
            {enabled && info.experimental && (
              <div className="flex gap-2 text-[10px] text-amber-400/70 pt-1 border-t border-[var(--border-subtle)]">
                <AlertCircle size={12} className="mt-0.5 shrink-0" />
                <span>Restart or reload may be required for changes to take effect.</span>
              </div>
            )}
          </div>
        );
      })}

      <div className="text-[11px] text-[var(--text-muted)] pt-2 border-t border-[var(--border-subtle)]">
        These flags control access to experimental and beta features. Feedback welcome — issues report to @Mikey.
      </div>
    </div>
  );
}
