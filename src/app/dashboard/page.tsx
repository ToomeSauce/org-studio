'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Backward compat: /dashboard redirects to /dashboard/projects (default entry point)
 */
export default function DashboardPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/dashboard/projects');
  }, [router]);

  return null;
}
