'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Backward compat: /dashboard redirects to /projects (main app entry)
 * Note: The actual routes are in (dashboard)/ group, so the URL is just /projects
 */
export default function DashboardPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/projects');
  }, [router]);

  return null;
}
