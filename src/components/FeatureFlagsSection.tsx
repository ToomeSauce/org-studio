'use client';

import { useEffect, useState } from 'react';
import { Beaker } from 'lucide-react';
import { clsx } from 'clsx';
import { FEATURE_FLAGS, isFeatureEnabled, toggleFeatureFlag, type FeatureFlag } from '@/lib/feature-flags';

interface FlagDef {
  flag: FeatureFlag;
  label: string;
  blurb: string;
  experimental?: boolean;
}

const FLAG_DEFS: FlagDef[] = [
  {
    flag: FEATURE_FLAGS.STUDIO_LEDGER_UX,
    label: 'Studio Ledger UX',
    blurb:
      'Project pages render in the editorial Studio Ledger theme — Fraunces serif, paper palette, oxblood + gilt accents. Will become default once the rollout is complete.',
    experimental: true,
  },
  {
    flag: FEATURE_FLAGS.MOBILE_FIRST_UX,
    label: 'Mobile-first threaded UX',
    blurb:
      'Reshapes the dashboard around tabs, threads, and a unified inbox. Companion to the v0.15 mobile app port. Experimental.',
    experimental: true,
  },
  {
    flag: FEATURE_FLAGS.PUSH_NOTIFICATIONS,
    label: 'Web push notifications',
    blurb:
      'Receive browser push notifications when tasks transition or comments are added. Requires permission grant.',
  },
  {
    flag: FEATURE_FLAGS.TELEGRAM_MIGRATION,
    label: 'Telegram migration tools',
    blurb:
      'Surface tools for migrating Telegram-based comms to native push. Hidden by default while the migration script is being authored.',
  },
];

export function FeatureFlagsSection() {
  // Hydrate flags client-side after mount to avoid SSR/CSR divergence.
  const [hydrated, setHydrated] = useState(false);
  const [flags, setFlags] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const next: Record<string, boolean> = {};
    for (const def of FLAG_DEFS) next[def.flag] = isFeatureEnabled(def.flag);
    setFlags(next);
    setHydrated(true);

    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail) return;
      setFlags((f) => ({ ...f, [detail.flag]: detail.enabled }));
    };
    window.addEventListener('feature-flag-changed', handler as EventListener);
    return () => window.removeEventListener('feature-flag-changed', handler as EventListener);
  }, []);

  return (
    <section className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-5 space-y-4 shadow-[var(--shadow-sm),inset_0_1px_0_var(--card-highlight)]">
      <div className="flex items-center gap-2">
        <Beaker size={15} className="text-[var(--text-secondary)]" />
        <h2 className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">Experimental UX</h2>
      </div>
      <p className="text-[var(--text-xs)] text-[var(--text-tertiary)]">
        Opt into in-flight UX experiments. Toggling is per-browser (stored in localStorage); your team
        is unaffected.
      </p>

      <div className="space-y-2">
        {FLAG_DEFS.map((def) => {
          const enabled = !!flags[def.flag];
          return (
            <div
              key={def.flag}
              className="flex items-start gap-4 p-3 rounded-[var(--radius-md)] bg-[var(--bg-hover)] border border-[var(--border-subtle)]"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">
                    {def.label}
                  </p>
                  {def.experimental && (
                    <span className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border border-[var(--accent-2)] text-[var(--accent-2)] bg-[var(--accent-2-subtle)]">
                      Experimental
                    </span>
                  )}
                </div>
                <p className="text-[var(--text-xs)] text-[var(--text-tertiary)] mt-1 leading-relaxed">
                  {def.blurb}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label={`Toggle ${def.label}`}
                disabled={!hydrated}
                onClick={() => toggleFeatureFlag(def.flag)}
                className={clsx(
                  'relative shrink-0 w-11 h-6 rounded-full transition-colors duration-150 mt-1',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)]',
                  enabled ? 'bg-[var(--accent-primary)]' : 'bg-[var(--bg-tertiary)] border border-[var(--border-default)]',
                  !hydrated && 'opacity-50 cursor-not-allowed'
                )}
              >
                <span
                  className={clsx(
                    'absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform duration-150 shadow-sm',
                    enabled && 'translate-x-5'
                  )}
                />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
