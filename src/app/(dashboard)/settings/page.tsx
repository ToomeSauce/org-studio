'use client';

import { PageHeader } from '@/components/PageHeader';
import { useWSData } from '@/lib/ws';
import { useState, useEffect, useMemo, useCallback } from 'react';
import Link from 'next/link';
import { Save, RefreshCw, ChevronDown, ChevronUp, WifiOff, RotateCcw, History, Eye, AlertTriangle, X, Database, Cloud, HardDrive, CheckCircle2 } from 'lucide-react';
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
      <h2 className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">Onboarding Wizard</h2>
      <p className="text-[var(--text-xs)] text-[var(--text-tertiary)]">
        The onboarding wizard helps new users set up their team, projects, and values on first launch. Reset it here to re-run the setup flow.
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

interface BackupEntry {
  filename: string;
  timestamp: string;
  size: number;
  tasks: number;
  projects: number;
  teammates: number;
}

function formatRelativeTime(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function BackupHistorySection() {
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [storageProvider, setStorageProvider] = useState<string | null>(null);
  const [previewFilename, setPreviewFilename] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<any>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [currentCounts, setCurrentCounts] = useState<{ tasks: number; projects: number; teammates: number } | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreResult, setRestoreResult] = useState<string | null>(null);

  const fetchBackups = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/backups');
      const data = await res.json();
      setBackups(data.backups || []);
    } catch {
      setBackups([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBackups();
    fetch('/api/store').then(r => r.json()).then(data => {
      setCurrentCounts({
        tasks: data?.tasks?.length || 0,
        projects: data?.projects?.length || 0,
        teammates: data?.settings?.teammates?.length || 0,
      });
    }).catch(() => {});
    fetch('/api/settings/storage').then(r => r.json()).then(data => {
      setStorageProvider(data?.provider || 'file');
    }).catch(() => setStorageProvider('file'));
  }, [fetchBackups]);

  const handlePreview = async (filename: string) => {
    if (previewFilename === filename) {
      setPreviewFilename(null);
      setPreviewData(null);
      return;
    }
    setPreviewFilename(filename);
    setPreviewLoading(true);
    try {
      const res = await fetch(`/api/backups?filename=${encodeURIComponent(filename)}`);
      const data = await res.json();
      setPreviewData(data);
    } catch {
      setPreviewData(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleRestore = async (filename: string) => {
    setRestoring(true);
    setRestoreResult(null);
    try {
      const res = await fetch('/api/backups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restore', filename }),
      });
      const data = await res.json();
      if (data.ok) {
        setRestoreResult(`Restored ${filename} successfully.`);
        setConfirmRestore(null);
        fetchBackups();
      } else {
        setRestoreResult(`Error: ${data.error || 'Unknown error'}`);
      }
    } catch (e: any) {
      setRestoreResult(`Error: ${e.message}`);
    } finally {
      setRestoring(false);
    }
  };

  const previewBackupCounts = previewData ? {
    tasks: previewData?.tasks?.length || 0,
    projects: previewData?.projects?.length || 0,
    teammates: previewData?.settings?.teammates?.length || 0,
  } : null;

  return (
    <section className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-5 space-y-4 shadow-[var(--shadow-sm),inset_0_1px_0_var(--card-highlight)]">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <History size={15} className="text-[var(--text-secondary)]" />
            <h2 className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">Backup History</h2>
          </div>
          <p className="text-[var(--text-xs)] text-[var(--text-tertiary)] mt-0.5">
            Auto-backups of local <code className="text-[10px] bg-[var(--bg-tertiary)] px-1 py-0.5 rounded font-mono">store.json</code>. Only applies to file-based storage.
          </p>
        </div>
        <button
          onClick={fetchBackups}
          className="p-1.5 rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] transition-colors"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      {storageProvider === 'postgres' && (
        <div className="flex items-center gap-2 px-3 py-2.5 rounded-[var(--radius-md)] bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-[var(--text-xs)] text-[var(--text-tertiary)]">
          <Database size={13} className="shrink-0" />
          <span>Using PostgreSQL — file backups are not created. Backups are managed by your database provider.</span>
        </div>
      )}

      {restoreResult && (
        <div className={clsx(
          'flex items-center gap-2 px-3 py-2 rounded-[var(--radius-md)] text-[var(--text-xs)]',
          restoreResult.startsWith('Error')
            ? 'bg-[color-mix(in_srgb,var(--error)_10%,transparent)] text-[var(--error)] border border-[color-mix(in_srgb,var(--error)_20%,transparent)]'
            : 'bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)] border border-[color-mix(in_srgb,var(--success)_20%,transparent)]'
        )}>
          <span>{restoreResult}</span>
          <button onClick={() => setRestoreResult(null)} className="ml-auto hover:opacity-70">
            <X size={12} />
          </button>
        </div>
      )}

      {loading ? (
        <p className="text-[var(--text-xs)] text-[var(--text-muted)] py-4 text-center">Loading backups...</p>
      ) : backups.length === 0 ? (
        <div className="flex flex-col items-center text-center py-6">
          <History size={20} className="text-[var(--text-muted)] mb-2" />
          <p className="text-[var(--text-sm)] text-[var(--text-muted)]">No backups found.</p>
          <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-1 opacity-60">
            Backups are created automatically on every file store write. When using PostgreSQL, backups are managed by the database.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {backups.map((b) => (
            <div key={b.filename}>
              <div className="flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-md)] bg-[var(--bg-primary)] border border-[var(--border-subtle)] hover:border-[var(--border-default)] transition-colors">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[var(--text-xs)] font-medium text-[var(--text-secondary)]">
                      {formatRelativeTime(b.timestamp)}
                    </span>
                    <span className="text-[var(--text-xs)] text-[var(--text-muted)]">
                      {new Date(b.timestamp).toLocaleString()}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-[var(--text-xs)] text-[var(--text-tertiary)]">
                    <span>{b.tasks} tasks</span>
                    <span>{b.projects} projects</span>
                    <span>{b.teammates} teammates</span>
                    <span>{formatBytes(b.size)}</span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => handlePreview(b.filename)}
                    className={clsx(
                      'flex items-center gap-1 px-2.5 py-1.5 rounded-[var(--radius-md)] text-[var(--text-xs)] font-medium border transition-all',
                      previewFilename === b.filename
                        ? 'bg-[var(--accent-primary)] text-white border-[var(--accent-primary)]'
                        : 'bg-[var(--bg-tertiary)] border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)]'
                    )}
                  >
                    <Eye size={12} /> Preview
                  </button>
                  <button
                    onClick={() => setConfirmRestore(b.filename)}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-[var(--radius-md)] text-[var(--text-xs)] font-medium border transition-all bg-[var(--bg-tertiary)] border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)]"
                  >
                    <RotateCcw size={12} /> Restore
                  </button>
                </div>
              </div>

              {previewFilename === b.filename && (
                <div className="mt-1 px-3 py-3 rounded-[var(--radius-md)] bg-[var(--bg-primary)] border border-[var(--border-subtle)]">
                  {previewLoading ? (
                    <p className="text-[var(--text-xs)] text-[var(--text-muted)]">Loading preview...</p>
                  ) : previewBackupCounts && currentCounts ? (
                    <div className="space-y-2">
                      <p className="text-[var(--text-xs)] font-medium text-[var(--text-secondary)]">Comparison with current data:</p>
                      <div className="grid grid-cols-3 gap-3 text-[var(--text-xs)]">
                        {(['tasks', 'projects', 'teammates'] as const).map(key => {
                          const diff = previewBackupCounts[key] - currentCounts[key];
                          return (
                            <div key={key} className="flex flex-col">
                              <span className="text-[var(--text-tertiary)] capitalize">{key}</span>
                              <span className="text-[var(--text-secondary)]">
                                {previewBackupCounts[key]}
                                {diff !== 0 && (
                                  <span className={diff > 0 ? 'text-[var(--success)] ml-1' : 'text-[var(--error)] ml-1'}>
                                    ({diff > 0 ? '+' : ''}{diff})
                                  </span>
                                )}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <p className="text-[var(--text-xs)] text-[var(--text-muted)]">Unable to load preview.</p>
                  )}
                </div>
              )}

              {confirmRestore === b.filename && (
                <div className="mt-1 px-3 py-3 rounded-[var(--radius-md)] bg-[color-mix(in_srgb,var(--warning)_5%,var(--bg-primary))] border border-[color-mix(in_srgb,var(--warning)_25%,var(--border-default))]">
                  <div className="flex items-start gap-2">
                    <AlertTriangle size={14} className="text-[var(--warning)] mt-0.5 flex-shrink-0" />
                    <div className="flex-1 space-y-2">
                      <p className="text-[var(--text-xs)] text-[var(--text-secondary)]">
                        This will replace all current data. A backup of the current state will be created first.
                      </p>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleRestore(b.filename)}
                          disabled={restoring}
                          className="flex items-center gap-1 px-2.5 py-1.5 rounded-[var(--radius-md)] text-[var(--text-xs)] font-medium border transition-all disabled:opacity-50 disabled:cursor-not-allowed bg-[var(--error)] text-white border-[var(--error)] hover:opacity-90"
                        >
                          <RotateCcw size={12} /> {restoring ? 'Restoring...' : 'Confirm Restore'}
                        </button>
                        <button
                          onClick={() => setConfirmRestore(null)}
                          className="px-2.5 py-1.5 rounded-[var(--radius-md)] text-[var(--text-xs)] font-medium border transition-all bg-[var(--bg-tertiary)] border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)]"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Data Storage section — shows current storage mode and connection info */
function DataStorageSection() {
  const [storageInfo, setStorageInfo] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/settings/storage')
      .then(r => r.json())
      .then(data => setStorageInfo(data))
      .catch(() => setStorageInfo(null))
      .finally(() => setLoading(false));
  }, []);

  const isPostgres = storageInfo?.provider === 'postgres';
  const isFile = storageInfo?.provider === 'file';

  return (
    <section className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-5 space-y-4 shadow-[var(--shadow-sm),inset_0_1px_0_var(--card-highlight)]">
      <div className="flex items-center gap-2">
        <Database size={15} className="text-[var(--text-secondary)]" />
        <h2 className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">Data Storage</h2>
      </div>

      {loading ? (
        <p className="text-[var(--text-xs)] text-[var(--text-muted)]">Checking storage...</p>
      ) : (
        <div className="space-y-3">
          {/* Mode indicator */}
          <div className="flex items-center gap-3 px-4 py-3 rounded-[var(--radius-md)] bg-[var(--bg-primary)] border border-[var(--border-subtle)]">
            {isPostgres ? (
              <Cloud size={18} className="text-[var(--accent-primary)]" />
            ) : (
              <HardDrive size={18} className="text-[var(--text-muted)]" />
            )}
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[var(--text-sm)] font-medium text-[var(--text-primary)]">
                  {isPostgres ? 'PostgreSQL' : 'Local File'}
                </span>
                <span className={clsx(
                  'px-1.5 py-0.5 rounded text-[10px] font-medium',
                  storageInfo?.connected
                    ? 'bg-[color-mix(in_srgb,var(--success)_15%,transparent)] text-[var(--success)]'
                    : 'bg-[color-mix(in_srgb,var(--error)_15%,transparent)] text-[var(--error)]'
                )}>
                  {storageInfo?.connected ? 'Connected' : 'Disconnected'}
                </span>
              </div>
              <p className="text-[var(--text-xs)] text-[var(--text-tertiary)] mt-0.5">
                {isPostgres
                  ? `${storageInfo?.host || 'remote'} — ${storageInfo?.database || 'org_studio_db'}`
                  : storageInfo?.path || 'data/store.json'}
              </p>
            </div>
          </div>

          {/* Configuration help */}
          <div className="text-[var(--text-xs)] text-[var(--text-tertiary)] space-y-1">
            {isPostgres ? (
              <>
                <p>PostgreSQL is configured via the <code className="text-[10px] bg-[var(--bg-tertiary)] px-1 py-0.5 rounded font-mono">DATABASE_URL</code> environment variable.</p>
                <p>Remote instances use this database for shared access. Local instances use it for bidirectional sync via LISTEN/NOTIFY.</p>
              </>
            ) : (
              <>
                <p>Data is stored in <code className="text-[10px] bg-[var(--bg-tertiary)] px-1 py-0.5 rounded font-mono">data/store.json</code>. To enable remote access and multi-instance sync, set <code className="text-[10px] bg-[var(--bg-tertiary)] px-1 py-0.5 rounded font-mono">DATABASE_URL</code> in <code className="text-[10px] bg-[var(--bg-tertiary)] px-1 py-0.5 rounded font-mono">.env.local</code>.</p>
              </>
            )}
          </div>

          {/* Feature comparison */}
          {isFile && (
            <div className="mt-2 px-3 py-2.5 rounded-[var(--radius-md)] bg-[var(--bg-secondary)] border border-[var(--border-subtle)]">
              <p className="text-[var(--text-xs)] font-medium text-[var(--text-secondary)] mb-2">PostgreSQL enables:</p>
              <ul className="text-[var(--text-xs)] text-[var(--text-tertiary)] space-y-1">
                <li className="flex items-center gap-1.5"><CheckCircle2 size={11} className="text-[var(--text-muted)]" /> Remote dashboard access</li>
                <li className="flex items-center gap-1.5"><CheckCircle2 size={11} className="text-[var(--text-muted)]" /> Multi-instance sync (LISTEN/NOTIFY)</li>
                <li className="flex items-center gap-1.5"><CheckCircle2 size={11} className="text-[var(--text-muted)]" /> Remote vision launches via intent bridge</li>
                <li className="flex items-center gap-1.5"><CheckCircle2 size={11} className="text-[var(--text-muted)]" /> Concurrent multi-user access</li>
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}


function RuntimeStatusSection() {
  const [runtimes, setRuntimes] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const pollRuntimes = async () => {
    setLoading(true);
    try {
      const resp = await fetch('/api/runtimes');
      const data = await resp.json();
      if (data.runtimes) setRuntimes(data.runtimes);
    } catch (err) {
      console.error('Failed to poll runtimes:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    pollRuntimes();
    const interval = setInterval(pollRuntimes, 10000);
    return () => clearInterval(interval);
  }, []);

  return (
    <section className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-5 space-y-3 shadow-[var(--shadow-sm),inset_0_1px_0_var(--card-highlight)]">
      <div className="flex items-center justify-between">
        <h2 className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">Agent Runtimes</h2>
        <button
          onClick={pollRuntimes}
          disabled={loading}
          className="flex items-center gap-1.5 px-2 py-1 rounded text-[var(--text-xs)] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          {loading ? 'Checking...' : 'Check'}
        </button>
      </div>
      <p className="text-[var(--text-xs)] text-[var(--text-tertiary)]">
        Org Studio can connect to multiple agent runtimes. Here's the status of each.
      </p>
      {runtimes.length > 0 ? (
        <div className="space-y-2 mt-3">
          {runtimes.map((rt) => (
            <div
              key={rt.id}
              className="flex items-start gap-3 p-3 rounded-[var(--radius-md)] bg-[var(--bg-secondary)] border border-[var(--border-subtle)]"
            >
              <div className="pt-0.5">
                {rt.connected ? (
                  <CheckCircle2 size={16} className="text-[var(--success)]" />
                ) : (
                  <WifiOff size={16} className="text-[var(--text-muted)]" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[var(--text-sm)] font-medium text-[var(--text-primary)]">{rt.name}</p>
                {rt.detail && (
                  <p className="text-[var(--text-xs)] text-[var(--text-tertiary)] leading-relaxed">{rt.detail}</p>
                )}
                {rt.connected && rt.agents?.length > 0 && (
                  <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-1">
                    {rt.agents.length} agent{rt.agents.length !== 1 ? 's' : ''} available
                  </p>
                )}
              </div>
              <span
                className={clsx(
                  'text-[var(--text-xs)] font-medium px-2 py-1 rounded-full whitespace-nowrap',
                  rt.connected
                    ? 'bg-[var(--success-subtle)] text-[var(--success)]'
                    : 'bg-[var(--warning-subtle)] text-[var(--warning)]'
                )}
              >
                {rt.connected ? '● Online' : '○ Offline'}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-2">Click "Check" to detect available runtimes</p>
      )}
    </section>
  );
}

export default function SettingsPage() {
  const storeData = useWSData<any>('store');
  const gatewayStatus = useWSData<any>('gateway-status');
  const gatewayAgents = useWSData<any>('gateway-agents');

  // Derive connection state from WS data
  const gatewayConnected = !!gatewayStatus;

  // System info from gateway status
  const systemInfoEntries = useMemo(() => [
    ['Version', gatewayStatus?.version || '—'],
    ['Uptime', gatewayStatus?.uptime || '—'],
    ['Agents', gatewayAgents ? `${Array.isArray(gatewayAgents) ? gatewayAgents.length : 0} configured` : '—'],
    ['Host', gatewayStatus?.hostname || '—'],
    ['Platform', gatewayStatus?.platform || '—'],
  ] as [string, string][], [gatewayStatus, gatewayAgents]);

  const hasSystemInfo = systemInfoEntries.some(([, value]) => value !== '—');

  // Scheduler loop preamble
  const [preamble, setPreamble] = useState('');
  const [preambleDirty, setPreambleDirty] = useState(false);
  const [preambleSaving, setPreambleSaving] = useState(false);
  const [showRawConfig, setShowRawConfig] = useState(false);

  useEffect(() => {
    if (storeData?.settings?.loopPreamble !== undefined) {
      setPreamble(storeData.settings.loopPreamble || '');
    }
  }, [storeData?.settings?.loopPreamble]);

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

  return (
    <div className="space-y-6 max-w-2xl">
      <PageHeader title="Settings" description="Storage, runtime, and system configuration" />

      {/* Agent Runtimes */}
      <RuntimeStatusSection />

      {/* Data Storage — #1 priority, shows local vs remote */}
      <DataStorageSection />

      {/* Gateway Connection */}
      <section className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-5 space-y-4 shadow-[var(--shadow-sm),inset_0_1px_0_var(--card-highlight)]">
        <h2 className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">OpenClaw Gateway</h2>
        <p className="text-[var(--text-xs)] text-[var(--text-tertiary)]">
          The Gateway runs locally and manages agent sessions. Remote instances use the intent bridge — no direct Gateway connection needed.
        </p>

        <div className="flex items-center gap-2 text-[var(--text-xs)]">
          <span className={clsx(
            'w-2 h-2 rounded-full',
            gatewayConnected ? 'bg-[var(--success)] shadow-[0_0_8px_rgba(52,211,153,0.5)]' : 'bg-[var(--text-muted)]'
          )} />
          <span className="text-[var(--text-secondary)]">
            {gatewayConnected ? 'Connected' : 'Not available'}
          </span>
          {!gatewayConnected && (
            <span className="text-[var(--text-muted)]">
              — normal for remote/cloud instances
            </span>
          )}
        </div>

        {/* System info */}
        {hasSystemInfo && (
          <div className="grid grid-cols-2 gap-3 text-[var(--text-sm)] mt-2">
            {systemInfoEntries.map(([label, value]) => (
              <div key={label}>
                <p className="text-[var(--text-xs)] text-[var(--text-tertiary)]">{label}</p>
                <p className="text-[var(--text-secondary)] truncate">{value}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Scheduler Loop Preamble */}
      <section className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-5 space-y-4 shadow-[var(--shadow-sm),inset_0_1px_0_var(--card-highlight)]">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">Scheduler Preamble</h2>
            <p className="text-[var(--text-xs)] text-[var(--text-tertiary)] mt-0.5">
              Global instructions prepended to every agent&apos;s work loop. Use for team-wide directives.
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
          rows={4}
          placeholder="e.g. Always check for PR review comments before starting new work. Prefer small, focused commits."
          className="w-full bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-md)] px-4 py-3 text-[var(--text-sm)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] resize-y focus:outline-none focus:border-[var(--accent-primary)] transition-colors font-mono leading-relaxed min-h-[100px]"
        />
      </section>

      {/* Onboarding Reset */}
      <ResetOnboardingSection />

      {/* Backup History */}
      <BackupHistorySection />

      {/* Advanced Section */}
      <section className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-5 space-y-3 shadow-[var(--shadow-sm),inset_0_1px_0_var(--card-highlight)]">
        <h2 className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">Advanced</h2>
        <p className="text-[var(--text-xs)] text-[var(--text-tertiary)]">
          Power user features and specialized tools.
        </p>
        {!gatewayConnected && (
          <div className="flex items-start gap-2 px-3 py-2.5 rounded-[var(--radius-md)] bg-[color-mix(in_srgb,var(--warning)_5%,var(--bg-primary))] border border-[color-mix(in_srgb,var(--warning)_25%,var(--border-default))] text-[var(--text-xs)] text-[var(--text-secondary)]">
            <WifiOff size={13} className="mt-0.5 flex-shrink-0" />
            <span>Requires OpenClaw Gateway connection</span>
          </div>
        )}
        <div className="space-y-2 pt-2">
          {gatewayConnected ? (
            <>
              <Link href="/cron" className="flex items-start gap-3 p-3 rounded-[var(--radius-md)] bg-[var(--bg-hover)] hover:bg-[var(--bg-tertiary)] transition-colors">
                <span className="text-sm mt-0.5">⏰</span>
                <div>
                  <p className="text-[var(--text-xs)] font-semibold text-[var(--text-primary)]">Automations</p>
                  <p className="text-[var(--text-xs)] text-[var(--text-muted)]">Manage cron jobs and scheduled tasks</p>
                </div>
              </Link>
              <Link href="/memory" className="flex items-start gap-3 p-3 rounded-[var(--radius-md)] bg-[var(--bg-hover)] hover:bg-[var(--bg-tertiary)] transition-colors">
                <span className="text-sm mt-0.5">🧠</span>
                <div>
                  <p className="text-[var(--text-xs)] font-semibold text-[var(--text-primary)]">Memory</p>
                  <p className="text-[var(--text-xs)] text-[var(--text-muted)]">View agent memory files</p>
                </div>
              </Link>
              <Link href="/docs" className="flex items-start gap-3 p-3 rounded-[var(--radius-md)] bg-[var(--bg-hover)] hover:bg-[var(--bg-tertiary)] transition-colors">
                <span className="text-sm mt-0.5">📚</span>
                <div>
                  <p className="text-[var(--text-xs)] font-semibold text-[var(--text-primary)]">Docs</p>
                  <p className="text-[var(--text-xs)] text-[var(--text-muted)]">Project documentation</p>
                </div>
              </Link>
              <Link href="/activity" className="flex items-start gap-3 p-3 rounded-[var(--radius-md)] bg-[var(--bg-hover)] hover:bg-[var(--bg-tertiary)] transition-colors">
                <span className="text-sm mt-0.5">📋</span>
                <div>
                  <p className="text-[var(--text-xs)] font-semibold text-[var(--text-primary)]">Activity Log</p>
                  <p className="text-[var(--text-xs)] text-[var(--text-muted)]">Historical activity feed</p>
                </div>
              </Link>
              <Link href="/calendar" className="flex items-start gap-3 p-3 rounded-[var(--radius-md)] bg-[var(--bg-hover)] hover:bg-[var(--bg-tertiary)] transition-colors">
                <span className="text-sm mt-0.5">📅</span>
                <div>
                  <p className="text-[var(--text-xs)] font-semibold text-[var(--text-primary)]">Calendar</p>
                  <p className="text-[var(--text-xs)] text-[var(--text-muted)]">Schedule and events</p>
                </div>
              </Link>
            </>
          ) : (
            <>
              <div className="flex items-start gap-3 p-3 rounded-[var(--radius-md)] bg-[var(--bg-hover)] opacity-50 cursor-not-allowed">
                <span className="text-sm mt-0.5">⏰</span>
                <div>
                  <p className="text-[var(--text-xs)] font-semibold text-[var(--text-primary)]">Automations</p>
                  <p className="text-[var(--text-xs)] text-[var(--text-muted)]">Manage cron jobs and scheduled tasks</p>
                </div>
              </div>
              <div className="flex items-start gap-3 p-3 rounded-[var(--radius-md)] bg-[var(--bg-hover)] opacity-50 cursor-not-allowed">
                <span className="text-sm mt-0.5">🧠</span>
                <div>
                  <p className="text-[var(--text-xs)] font-semibold text-[var(--text-primary)]">Memory</p>
                  <p className="text-[var(--text-xs)] text-[var(--text-muted)]">View agent memory files</p>
                </div>
              </div>
              <div className="flex items-start gap-3 p-3 rounded-[var(--radius-md)] bg-[var(--bg-hover)] opacity-50 cursor-not-allowed">
                <span className="text-sm mt-0.5">📚</span>
                <div>
                  <p className="text-[var(--text-xs)] font-semibold text-[var(--text-primary)]">Docs</p>
                  <p className="text-[var(--text-xs)] text-[var(--text-muted)]">Project documentation</p>
                </div>
              </div>
              <div className="flex items-start gap-3 p-3 rounded-[var(--radius-md)] bg-[var(--bg-hover)] opacity-50 cursor-not-allowed">
                <span className="text-sm mt-0.5">📋</span>
                <div>
                  <p className="text-[var(--text-xs)] font-semibold text-[var(--text-primary)]">Activity Log</p>
                  <p className="text-[var(--text-xs)] text-[var(--text-muted)]">Historical activity feed</p>
                </div>
              </div>
              <div className="flex items-start gap-3 p-3 rounded-[var(--radius-md)] bg-[var(--bg-hover)] opacity-50 cursor-not-allowed">
                <span className="text-sm mt-0.5">📅</span>
                <div>
                  <p className="text-[var(--text-xs)] font-semibold text-[var(--text-primary)]">Calendar</p>
                  <p className="text-[var(--text-xs)] text-[var(--text-muted)]">Schedule and events</p>
                </div>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
