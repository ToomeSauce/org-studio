/**
 * Feature flags for toggling experimental UX modes.
 * Controlled by env vars and stored in localStorage.
 */

import * as React from 'react';

export const FEATURE_FLAGS = {
  // Mobile-first threaded UX (v0.15+): tabs, threads, unified inbox
  MOBILE_FIRST_UX: 'mobile-first-ux',
  // Push notifications (v0.15+)
  PUSH_NOTIFICATIONS: 'push-notifications',
  // Telegram migration tools (v0.16+)
  TELEGRAM_MIGRATION: 'telegram-migration',
} as const;

export type FeatureFlag = (typeof FEATURE_FLAGS)[keyof typeof FEATURE_FLAGS];

/**
 * Client-side: read from localStorage + env overrides
 */
export function isFeatureEnabled(flag: FeatureFlag): boolean {
  if (typeof window === 'undefined') return false;
  
  // Check env override first (for testing/CI)
  const envKey = `NEXT_PUBLIC_${flag.toUpperCase().replace(/-/g, '_')}`;
  const envVal = (globalThis as any).__NEXT_PUBLIC_ENV?.[envKey] || 
                 (typeof process !== 'undefined' ? process.env[envKey] : undefined);
  if (envVal === 'true') return true;
  if (envVal === 'false') return false;
  
  // Fall back to localStorage (user preference)
  const stored = localStorage.getItem(`ff:${flag}`);
  return stored === 'true';
}

/**
 * Client-side: toggle a feature flag (persists to localStorage)
 */
export function toggleFeatureFlag(flag: FeatureFlag): void {
  if (typeof window === 'undefined') return;
  const current = isFeatureEnabled(flag);
  localStorage.setItem(`ff:${flag}`, (!current).toString());
  // Broadcast to other tabs
  window.dispatchEvent(new CustomEvent('feature-flag-changed', { detail: { flag, enabled: !current } }));
}

/**
 * Server-side: check env vars only (no localStorage on server)
 */
export function isFeatureEnabledServer(flag: FeatureFlag): boolean {
  const envKey = `${flag.toUpperCase().replace(/-/g, '_')}`;
  return process.env[envKey] === 'true';
}

/**
 * Get all feature flags state (client-side)
 */
export function getAllFeatureFlags(): Record<FeatureFlag, boolean> {
  return Object.values(FEATURE_FLAGS).reduce((acc, flag) => {
    acc[flag] = isFeatureEnabled(flag);
    return acc;
  }, {} as Record<FeatureFlag, boolean>);
}

/**
 * Hook for React components to listen to feature flag changes
 */
export function useFeatureFlag(flag: FeatureFlag): [boolean, () => void] {
  // Initial render must be deterministic across SSR/CSR — start at the
  // SSR-safe value (false) and re-sync from localStorage after mount.
  const [enabled, setEnabled] = React.useState<boolean>(false);

  React.useEffect(() => {
    setEnabled(isFeatureEnabled(flag));
    const handler = (e: CustomEvent) => {
      if (e.detail.flag === flag) setEnabled(e.detail.enabled);
    };
    window.addEventListener('feature-flag-changed', handler as EventListener);
    // Cross-tab sync
    const storage = (e: StorageEvent) => {
      if (e.key === `ff:${flag}`) setEnabled(isFeatureEnabled(flag));
    };
    window.addEventListener('storage', storage);
    return () => {
      window.removeEventListener('feature-flag-changed', handler as EventListener);
      window.removeEventListener('storage', storage);
    };
  }, [flag]);

  return [enabled, () => toggleFeatureFlag(flag)];
}

