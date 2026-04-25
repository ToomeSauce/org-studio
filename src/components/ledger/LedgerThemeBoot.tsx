'use client';

/**
 * Applies/removes the `data-theme="ledger"` attribute on <html> based on the
 * STUDIO_LEDGER_UX feature flag. Runs as soon as the body mounts to minimise
 * theme flash. Listens to feature-flag-changed events for live toggling.
 */

import { useEffect } from 'react';
import { FEATURE_FLAGS, isFeatureEnabled } from '@/lib/feature-flags';

export function LedgerThemeBoot() {
  useEffect(() => {
    const apply = () => {
      const on = isFeatureEnabled(FEATURE_FLAGS.STUDIO_LEDGER_UX);
      const root = document.documentElement;
      if (on) root.setAttribute('data-theme', 'ledger');
      else if (root.getAttribute('data-theme') === 'ledger') root.removeAttribute('data-theme');
    };
    apply();
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.flag === FEATURE_FLAGS.STUDIO_LEDGER_UX) apply();
    };
    window.addEventListener('feature-flag-changed', handler as EventListener);
    // Cross-tab sync via storage event
    const storage = (e: StorageEvent) => {
      if (e.key === `ff:${FEATURE_FLAGS.STUDIO_LEDGER_UX}`) apply();
    };
    window.addEventListener('storage', storage);
    return () => {
      window.removeEventListener('feature-flag-changed', handler as EventListener);
      window.removeEventListener('storage', storage);
    };
  }, []);
  return null;
}
