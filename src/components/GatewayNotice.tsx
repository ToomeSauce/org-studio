'use client';

import { Wifi } from 'lucide-react';

export function GatewayNotice({ feature }: { feature?: string }) {
  return (
    <div className="flex items-center gap-3 px-5 py-4 rounded-[var(--radius-lg)] bg-[var(--bg-secondary)] border border-dashed border-[var(--border-default)] text-[var(--text-muted)]">
      <Wifi size={18} className="shrink-0 opacity-40" />
      <div>
        <p className="text-[var(--text-sm)] font-medium">
          Connect an agent runtime for {feature || 'live data'}
        </p>
        <p className="text-[var(--text-xs)] mt-0.5 opacity-70">
          Set GATEWAY_URL and GATEWAY_TOKEN in .env.local to enable real-time agent status, sessions, and cron data.
        </p>
      </div>
    </div>
  );
}
