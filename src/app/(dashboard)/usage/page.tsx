'use client';

/**
 * /usage — Token & Cost Analytics (#1651)
 *
 * Dedicated entry point for spend: totals, cost by agent, model table,
 * week-over-week anomalies. Moved out of /performance (which is team
 * delivery metrics, now folded into /team). Data: GET /api/observability/costs (#1644).
 */

import dynamic from 'next/dynamic';

const CostAnalyticsSection = dynamic(() => import('@/components/CostAnalyticsSection'), {
  ssr: false,
  loading: () => <div className="h-32 animate-pulse bg-[var(--bg-secondary)] rounded-[var(--radius-md)]" />,
});

export default function UsagePage() {
  return (
    <div className="flex-1 overflow-auto bg-[var(--bg-primary)]">
      <div className="max-w-6xl mx-auto p-6 space-y-4">
        <div>
          <h1 className="text-3xl font-bold text-[var(--text-primary)]">💰 Usage</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">
            Token consumption and cost — totals, by agent, by model, week-over-week trends.
          </p>
        </div>
        <CostAnalyticsSection />
      </div>
    </div>
  );
}
