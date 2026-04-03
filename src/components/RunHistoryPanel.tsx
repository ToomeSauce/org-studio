'use client';

import { useState, useEffect, useCallback } from 'react';
import { clsx } from 'clsx';
import { RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────

interface CronRunEntry {
  ts: number;
  jobId: string;
  action: string;
  status: string;
  summary?: string;
  runAtMs: number;
  durationMs: number;
  nextRunAtMs?: number;
  model?: string;
  provider?: string;
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
  sessionId?: string;
  sessionKey?: string;
}

interface RunHistoryPanelProps {
  loopId: string;
  cronJobId?: string;
  visible: boolean;
  onStatsLoaded?: (stats: { ok: number; total: number }) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function formatFullDate(ts: number): string {
  return new Date(ts).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function shortModel(model?: string): string {
  if (!model) return '';
  // Strip provider prefix (e.g. "foundry-openai/gpt-5.3-codex" → "gpt-5.3-codex")
  const slash = model.lastIndexOf('/');
  return slash >= 0 ? model.slice(slash + 1) : model;
}

// ─── Status Badge ─────────────────────────────────────────────────

function StatusDot({ status }: { status: string }) {
  return (
    <span
      className={clsx(
        'inline-block w-2 h-2 rounded-full shrink-0',
        status === 'ok' && 'bg-[var(--success)]',
        status === 'error' && 'bg-[var(--error)]',
        status === 'timeout' && 'bg-[var(--warning)]',
        !['ok', 'error', 'timeout'].includes(status) && 'bg-[var(--text-muted)]',
      )}
      title={status}
    />
  );
}

// ─── Skeleton Row ─────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 px-3 py-2 animate-pulse">
      <span className="w-2 h-2 rounded-full bg-[var(--bg-tertiary)]" />
      <span className="h-3 w-16 rounded bg-[var(--bg-tertiary)]" />
      <span className="h-3 w-12 rounded bg-[var(--bg-tertiary)]" />
      <span className="h-3 flex-1 rounded bg-[var(--bg-tertiary)]" />
      <span className="h-3 w-20 rounded bg-[var(--bg-tertiary)]" />
      <span className="h-3 w-10 rounded bg-[var(--bg-tertiary)]" />
    </div>
  );
}

// ─── Run Row ──────────────────────────────────────────────────────

function RunRow({ entry }: { entry: CronRunEntry }) {
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const summary = entry.summary || '';
  const truncated = summary.length > 100;
  const displaySummary = summaryExpanded ? summary : summary.slice(0, 100);
  const totalTokens = entry.usage?.total_tokens;

  return (
    <div className="flex items-start gap-3 px-3 py-2 rounded-[var(--radius-sm)] hover:bg-[var(--bg-hover)] transition-colors text-[var(--text-xs)]">
      {/* Status */}
      <div className="pt-1">
        <StatusDot status={entry.status} />
      </div>

      {/* Time */}
      <span
        className="text-[var(--text-muted)] shrink-0 w-[60px]"
        title={formatFullDate(entry.runAtMs || entry.ts)}
      >
        {formatRelative(entry.runAtMs || entry.ts)}
      </span>

      {/* Duration */}
      <span className="text-[var(--text-tertiary)] shrink-0 w-[48px] font-mono">
        {entry.durationMs ? formatDuration(entry.durationMs) : '—'}
      </span>

      {/* Summary */}
      <div className="flex-1 min-w-0">
        {summary ? (
          <span
            className={clsx(
              'text-[var(--text-secondary)] leading-relaxed',
              truncated && 'cursor-pointer'
            )}
            onClick={() => truncated && setSummaryExpanded(!summaryExpanded)}
          >
            {displaySummary}
            {truncated && !summaryExpanded && (
              <span className="text-[var(--text-muted)]">…</span>
            )}
          </span>
        ) : (
          <span className="text-[var(--text-muted)] italic">No summary</span>
        )}
      </div>

      {/* Model */}
      <span className="text-[var(--text-muted)] shrink-0 max-w-[110px] truncate" title={entry.model}>
        {shortModel(entry.model)}
      </span>

      {/* Tokens */}
      <span className="text-[var(--text-muted)] shrink-0 w-[44px] text-right font-mono">
        {totalTokens != null ? formatTokens(totalTokens) : '—'}
      </span>
    </div>
  );
}

// ─── Main Panel ───────────────────────────────────────────────────

export default function RunHistoryPanel({ loopId, cronJobId, visible, onStatsLoaded }: RunHistoryPanelProps) {
  const [entries, setEntries] = useState<CronRunEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [limit, setLimit] = useState(10);

  const fetchHistory = useCallback(async (fetchLimit: number) => {
    if (!cronJobId) {
      setEntries([]);
      setLoaded(true);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/scheduler', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'runHistory', loopId, limit: fetchLimit }),
      });
      const data = await res.json();
      const fetched: CronRunEntry[] = data.entries || [];
      setEntries(fetched);
      setLoaded(true);

      // Report aggregate stats
      if (onStatsLoaded && fetched.length > 0) {
        const okCount = fetched.filter(e => e.status === 'ok').length;
        onStatsLoaded({ ok: okCount, total: fetched.length });
      }
    } catch (e) {
      console.error('Failed to fetch run history:', e);
      setLoaded(true);
    } finally {
      setLoading(false);
    }
  }, [cronJobId, loopId, onStatsLoaded]);

  // Fetch when visible and not yet loaded
  useEffect(() => {
    if (visible && !loaded && cronJobId) {
      fetchHistory(limit);
    }
  }, [visible, loaded, cronJobId, limit, fetchHistory]);

  const handleRefresh = () => {
    fetchHistory(limit);
  };

  const handleLoadMore = () => {
    const newLimit = limit + 10;
    setLimit(newLimit);
    fetchHistory(newLimit);
  };

  if (!visible) return null;

  return (
    <div className="px-5 py-3 border-t border-[var(--border-default)]">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <p className="text-[var(--text-xs)] font-semibold text-[var(--text-secondary)] uppercase tracking-[0.05em]">
          Run History
        </p>
        <button
          onClick={handleRefresh}
          disabled={loading}
          className="p-1 rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-all"
          title="Refresh history"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Content */}
      {!loaded && loading ? (
        <div className="space-y-1">
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : entries.length === 0 ? (
        <p className="text-[var(--text-xs)] text-[var(--text-muted)] py-4 text-center">
          No runs yet
        </p>
      ) : (
        <>
          {/* Column headers */}
          <div className="flex items-center gap-3 px-3 py-1 text-[var(--text-xs)] text-[var(--text-muted)] border-b border-[var(--border-subtle)]">
            <span className="w-2" />
            <span className="w-[60px]">Time</span>
            <span className="w-[48px]">Dur.</span>
            <span className="flex-1">Summary</span>
            <span className="max-w-[110px]">Model</span>
            <span className="w-[44px] text-right">Tokens</span>
          </div>

          {/* Rows */}
          <div className="space-y-0.5">
            {entries.map((entry, i) => (
              <RunRow key={`${entry.ts}-${i}`} entry={entry} />
            ))}
          </div>

          {/* Load more */}
          {entries.length >= limit && (
            <button
              onClick={handleLoadMore}
              disabled={loading}
              className="w-full mt-2 py-1.5 text-[var(--text-xs)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] rounded-[var(--radius-sm)] transition-colors"
            >
              {loading ? 'Loading…' : 'Load more'}
            </button>
          )}
        </>
      )}
    </div>
  );
}
