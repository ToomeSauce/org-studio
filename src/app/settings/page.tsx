'use client';

import { PageHeader } from '@/components/PageHeader';
import { useGateway, useGatewayQuery } from '@/lib/hooks';
import { useState, useEffect, useMemo } from 'react';
import { Save, RefreshCw, ChevronDown, ChevronUp, WifiOff, RotateCcw } from 'lucide-react';
import { clsx } from 'clsx';

function ResetOnboardingSection() {
  const [resetting, setResetting] = useState(false);
  const [resetDone, setResetDone] = useState(false);

  const resetOnboarding = async () => {
    setResetting(true);
    try {
      await fetch('/api/store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'updateSettings', settings: { onboardingComplete: false } }),
      });
      setResetDone(true);
    } finally {
      setResetting(false);
    }
  };

  return (
    <section className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-5 space-y-3 shadow-[var(--shadow-sm),inset_0_1px_0_var(--card-highlight)]">
      <h2 className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">Onboarding</h2>
      <p className="text-[var(--text-xs)] text-[var(--text-tertiary)]">
        Reset the onboarding wizard so it shows again on the dashboard (for demo purposes).
      </p>
      <button
        onClick={resetOnboarding}
        disabled={resetting || resetDone}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-md)] text-[var(--text-xs)] font-medium border transition-all disabled:opacity-50 disabled:cursor-not-allowed bg-[var(--bg-tertiary)] border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)]"
      >
        <RotateCcw size={13} />
        {resetDone ? 'Reset — reload to see wizard' : resetting ? 'Resetting...' : 'Reset Onboarding'}
      </button>
    </section>
  );
}

export default function SettingsPage() {
  const { gateway, state } = useGateway();
  const { data: config, refetch } = useGatewayQuery<any>('config.get', {}, 0);
  const { data: health } = useGatewayQuery<any>('health', {}, 0);
  const { data: status } = useGatewayQuery<any>('status', {}, 0);

  // Loop preamble state
  const [preamble, setPreamble] = useState('');
  const [preambleDirty, setPreambleDirty] = useState(false);
  const [preambleSaving, setPreambleSaving] = useState(false);
  const [showRawConfig, setShowRawConfig] = useState(false);

  useEffect(() => {
    fetch('/api/store').then(r => r.json()).then(data => {
      setPreamble(data?.settings?.loopPreamble || '');
    }).catch(() => {});
  }, []);

  const savePreamble = async () => {
    setPreambleSaving(true);
    try {
      await fetch('/api/store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'updateLoopPreamble', loopPreamble: preamble }),
      });
      setPreambleDirty(false);
    } finally {
      setPreambleSaving(false);
    }
  };

  // Check if system info is all dashes (not connected)
  const systemInfoEntries = useMemo(() => [
    ['Version', status?.version || health?.version || '—'],
    ['Model', status?.model || '—'],
    ['Uptime', health?.uptime || '—'],
    ['Node', health?.node || '—'],
    ['Host', health?.hostname || '—'],
    ['Platform', health?.platform || '—'],
  ] as [string, string][], [status, health]);

  const hasSystemInfo = systemInfoEntries.some(([, value]) => value !== '—');

  // Token is now server-side (GATEWAY_TOKEN env var) — no browser config needed

  return (
    <div className="space-y-6 max-w-2xl">
      <PageHeader title="Settings" description="Gateway connection and configuration" />

      {/* Connection */}
      <section className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-5 space-y-4 shadow-[var(--shadow-sm),inset_0_1px_0_var(--card-highlight)]">
        <h2 className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">Runtime Connection</h2>

        <div className="space-y-3">
          <div>
            <label className="block text-[var(--text-xs)] text-[var(--text-tertiary)] mb-1">URL</label>
            <p className="text-[var(--text-sm)] text-[var(--text-secondary)]">
              Configured via <code className="text-[var(--text-xs)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded-[var(--radius-sm)] font-mono">GATEWAY_URL</code> env var in <code className="text-[var(--text-xs)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded-[var(--radius-sm)] font-mono">.env.local</code>
            </p>
          </div>

          <div>
            <label className="block text-[var(--text-xs)] text-[var(--text-tertiary)] mb-1">Auth</label>
            <p className="text-[var(--text-sm)] text-[var(--text-secondary)]">
              Server-side proxy — token configured via <code className="text-[var(--text-xs)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded-[var(--radius-sm)] font-mono">GATEWAY_TOKEN</code> env var
            </p>
          </div>

          <div className="flex items-center gap-2 text-[var(--text-xs)]">
            <span className={clsx(
              'w-2 h-2 rounded-full',
              state === 'connected' ? 'bg-[var(--success)] shadow-[0_0_8px_rgba(52,211,153,0.5)]' : 'bg-[var(--error)]'
            )} />
            <span className="text-[var(--text-secondary)] capitalize">{state}</span>
          </div>
        </div>
      </section>

      {/* Scheduler Loop Preamble */}
      <section className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-5 space-y-4 shadow-[var(--shadow-sm),inset_0_1px_0_var(--card-highlight)]">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">Scheduler Loop</h2>
            <p className="text-[var(--text-xs)] text-[var(--text-tertiary)] mt-0.5">
              Global instructions prepended to every agent&apos;s loop prompt.
            </p>
          </div>
          <button
            onClick={savePreamble}
            disabled={!preambleDirty || preambleSaving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-md)] text-[var(--text-xs)] font-medium border transition-all disabled:opacity-40 disabled:cursor-not-allowed bg-[var(--accent-primary)] text-white border-[var(--accent-primary)] hover:bg-[var(--accent-hover)]"
          >
            <Save size={13} /> {preambleSaving ? 'Saving...' : 'Save'}
          </button>
        </div>

        <textarea
          value={preamble}
          onChange={e => { setPreamble(e.target.value); setPreambleDirty(true); }}
          rows={6}
          placeholder="e.g. Always check for PR review comments before starting new work. Prefer small, focused commits. Never deploy to production."
          className="w-full bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-md)] px-4 py-3 text-[var(--text-sm)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] resize-y focus:outline-none focus:border-[var(--accent-primary)] transition-colors font-mono leading-relaxed min-h-[140px]"
        />

        <p className="text-[var(--text-xs)] text-[var(--text-muted)]">
          These instructions are injected at the top of every scheduler loop cycle for all agents.
          Use per-loop system prompts (on each agent&apos;s loop card) for agent-specific overrides.
        </p>
      </section>

      {/* System info */}
      <section className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-5 space-y-3 shadow-[var(--shadow-sm),inset_0_1px_0_var(--card-highlight)]">
        <div className="flex items-center justify-between">
          <h2 className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">System Info</h2>
          <button
            onClick={refetch}
            className="p-1.5 rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] transition-colors"
          >
            <RefreshCw size={14} />
          </button>
        </div>

        {hasSystemInfo ? (
          <div className="grid grid-cols-2 gap-3 text-[var(--text-sm)]">
            {systemInfoEntries.map(([label, value]) => (
              <div key={label}>
                <p className="text-[var(--text-xs)] text-[var(--text-tertiary)]">{label}</p>
                <p className="text-[var(--text-secondary)] truncate">{value}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center text-center py-6">
            <WifiOff size={20} className="text-[var(--text-muted)] mb-2" />
            <p className="text-[var(--text-sm)] text-[var(--text-muted)]">Not connected to a gateway</p>
            <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-1 opacity-60">
              System info will appear once a runtime is connected.
            </p>
          </div>
        )}
      </section>

      {/* Raw config preview — collapsible */}

      {/* Reset Onboarding — for demo purposes */}
      <ResetOnboardingSection />

      {config && (
        <section className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] overflow-hidden shadow-[var(--shadow-sm),inset_0_1px_0_var(--card-highlight)]">
          <button
            onClick={() => setShowRawConfig(!showRawConfig)}
            className="w-full flex items-center justify-between px-5 py-4 hover:bg-[var(--bg-hover)] transition-colors"
          >
            <h2 className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">Raw Configuration</h2>
            <div className="flex items-center gap-2 text-[var(--text-muted)]">
              <span className="text-[var(--text-xs)]">{showRawConfig ? 'Hide' : 'Show'}</span>
              {showRawConfig ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </div>
          </button>
          {showRawConfig && (
            <div className="px-5 pb-5 border-t border-[var(--border-subtle)]">
              <pre className="text-[var(--text-xs)] text-[var(--text-tertiary)] bg-[var(--bg-primary)] p-4 rounded-[var(--radius-md)] overflow-auto max-h-[400px] mt-4 font-mono leading-relaxed border border-[var(--border-subtle)]">
                {JSON.stringify(config, null, 2)}
              </pre>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
