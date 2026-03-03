'use client';

import { PageHeader } from '@/components/PageHeader';
import { useGateway, useGatewayQuery } from '@/lib/hooks';
import { useState, useEffect } from 'react';
import { Save, RefreshCw } from 'lucide-react';

export default function SettingsPage() {
  const { gateway, state } = useGateway();
  const { data: config, refetch } = useGatewayQuery<any>('config.get', {}, 0);
  const { data: health } = useGatewayQuery<any>('health', {}, 0);
  const { data: status } = useGatewayQuery<any>('status', {}, 0);

  // Token is now server-side (GATEWAY_TOKEN env var) — no browser config needed

  return (
    <div className="space-y-6 max-w-2xl">
      <PageHeader title="Settings" description="Gateway connection and configuration" />

      {/* Connection */}
      <section className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg p-4 space-y-4">
        <h2 className="text-sm font-medium text-[var(--text-primary)]">Gateway Connection</h2>

        <div className="space-y-3">
          <div>
            <label className="block text-xs text-[var(--text-tertiary)] mb-1">URL</label>
            <input
              type="text"
              value="ws://127.0.0.1:18789"
              readOnly
              className="w-full px-3 py-2 text-sm bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-md text-[var(--text-secondary)]"
            />
          </div>

          <div>
            <label className="block text-xs text-[var(--text-tertiary)] mb-1">Auth</label>
            <p className="text-sm text-[var(--text-secondary)]">
              Server-side proxy — token configured via <code className="text-xs bg-[var(--bg-tertiary)] px-1 py-0.5 rounded">GATEWAY_TOKEN</code> env var
            </p>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <span className={`w-2 h-2 rounded-full ${state === 'connected' ? 'bg-green-500' : 'bg-red-500'}`} />
            <span className="text-[var(--text-secondary)]">{state}</span>
          </div>
        </div>
      </section>

      {/* System info */}
      <section className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-[var(--text-primary)]">System Info</h2>
          <button
            onClick={refetch}
            className="p-1.5 rounded hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] transition-colors"
          >
            <RefreshCw size={14} />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm">
          {[
            ['Version', status?.version || health?.version || '—'],
            ['Model', status?.model || '—'],
            ['Uptime', health?.uptime || '—'],
            ['Node', health?.node || '—'],
            ['Host', health?.hostname || '—'],
            ['Platform', health?.platform || '—'],
          ].map(([label, value]) => (
            <div key={label as string}>
              <p className="text-xs text-[var(--text-tertiary)]">{label}</p>
              <p className="text-[var(--text-secondary)] truncate">{value as string}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Raw config preview */}
      {config && (
        <section className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg p-4 space-y-3">
          <h2 className="text-sm font-medium text-[var(--text-primary)]">Configuration (read-only)</h2>
          <pre className="text-xs text-[var(--text-tertiary)] bg-[var(--bg-primary)] p-3 rounded-md overflow-auto max-h-[300px]">
            {JSON.stringify(config, null, 2)}
          </pre>
        </section>
      )}
    </div>
  );
}
