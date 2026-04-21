'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Backward compat: /dashboard redirects to / (the home page).
 * The actual home lives in the (dashboard) route group at `/` and renders
 * Mission Statement, Needs Your Attention, Team Activity, etc.
 */
export default function DashboardPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/');
  }, [router]);

  return null;
}
