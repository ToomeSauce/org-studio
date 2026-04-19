'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isFeatureEnabled, FEATURE_FLAGS } from '@/lib/feature-flags';

/**
 * Route dispatcher based on feature flags.
 * Mobile-first UX goes to (tabs), classic UX stays on (dashboard).
 */
export default function Page() {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;

    // Determine which experience to show
    const useMobileFirstUX = isFeatureEnabled(FEATURE_FLAGS.MOBILE_FIRST_UX);

    // Redirect to appropriate experience
    if (useMobileFirstUX) {
      router.replace('/tabs/inbox');
    } else {
      router.replace('/dashboard');
    }
  }, [mounted, router]);

  // Loading state while redirecting
  return (
    <div className="flex items-center justify-center min-h-screen bg-[var(--bg-primary)]">
      <div className="text-center space-y-4">
        <div className="w-12 h-12 rounded-full border-2 border-[var(--border-default)] border-t-[var(--accent-primary)] animate-spin mx-auto" />
        <p className="text-sm text-[var(--text-muted)]">Loading Org Studio…</p>
      </div>
    </div>
  );
}
