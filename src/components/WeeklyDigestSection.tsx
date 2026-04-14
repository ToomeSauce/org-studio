'use client';

import { useEffect, useState, useCallback } from 'react';
import type { WeeklyDigest } from '@/lib/weekly-digest';

// ─── Subcomponents ────────────────────────────────────────────────────────────

function TopPerformerCard({
  emoji,
  label,
  agentId,
  metric,
}: {
  emoji: string;
  label: string;
  agentId: string | null;
  metric: string | null;
}) {
  return (
    <div className="p-4 bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-md)] flex flex-col gap-1.5 min-h-[96px]">
      <div className="flex items-center gap-1.5">
        <span className="text-base">{emoji}</span>
        <span className="text-xs text-[var(--text-muted)] font-medium">{label}</span>
      </div>
      {agentId ? (
        <>
          <p className="font-semibold text-[var(--text-primary)] text-sm leading-tight">{agentId}</p>
          <p className="text-xs text-[var(--text-muted)]">{metric}</p>
        </>
      ) : (
        <p className="text-xs text-[var(--text-muted)] italic">No data</p>
      )}
    </div>
  );
}

function VersionProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? (done / total) * 100 : 0;
  const complete = done === total;
  return (
    <div className="flex items-center gap-2 w-full">
      <div className="flex-1 h-1.5 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${complete ? 'bg-green-500' : 'bg-[var(--accent-primary)]'}`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <span className="text-xs text-[var(--text-muted)] tabular-nums whitespace-nowrap">
        {done}/{total}{complete ? ' ✅' : ''}
      </span>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function WeeklyDigestSection() {
  const [digest, setDigest]   = useState<WeeklyDigest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sentMsg, setSentMsg] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const fetchDigest = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch('/api/metrics/weekly-digest')
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => {
        setDigest(data.digest || null);
        setLoading(false);
      })
      .catch(e => {
        setError(e.message || 'Unknown error');
        setLoading(false);
      });
  }, []);

  useEffect(() => { fetchDigest(); }, [fetchDigest]);

  const handleSend = useCallback(async () => {
    setSending(true);
    setSentMsg(null);
    try {
      const res = await fetch('/api/metrics/weekly-digest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'send' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setSentMsg(data.telegramSent ? '✅ Sent!' : '⚠️ Digest generated (Telegram not configured)');
    } catch (e: any) {
      setSentMsg(`❌ ${e.message || 'Failed to send'}`);
    } finally {
      setSending(false);
      setTimeout(() => setSentMsg(null), 4000);
    }
  }, []);

  // ── Loading state ──────────────────────────────────────────────────────────
  if (loading) {
    return (
      <section className="border border-[var(--border-default)] rounded-[var(--radius-md)] bg-[var(--card)] p-6">
        <p className="text-sm text-[var(--text-muted)]">Generating digest...</p>
      </section>
    );
  }

  // ── Error state ────────────────────────────────────────────────────────────
  if (error || !digest) {
    return (
      <section className="border border-[var(--border-default)] rounded-[var(--radius-md)] bg-[var(--card)] p-6">
        <p className="text-sm text-red-500">Unable to generate digest{error ? `: ${error}` : '.'}</p>
        <button
          onClick={fetchDigest}
          className="mt-2 text-xs text-[var(--accent-primary)] hover:underline"
        >
          Retry
        </button>
      </section>
    );
  }

  const { summary, topPerformers: tp, areasOfAttention, versionProgress, recentKudos, coachingHighlights } = digest;
  const showCoaching = expanded ? coachingHighlights : coachingHighlights.slice(0, 3);

  return (
    <section className="border border-[var(--border-default)] rounded-[var(--radius-md)] bg-[var(--card)] overflow-hidden">
      {/* ── Header ── */}
      <div className="flex items-start justify-between px-6 pt-5 pb-4 border-b border-[var(--border-subtle)]">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text-primary)] flex items-center gap-2">
            📊 Weekly Digest
          </h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">{digest.weekLabel}</p>
        </div>
        <div className="flex items-center gap-2">
          {sentMsg && (
            <span className="text-xs text-[var(--text-secondary)]">{sentMsg}</span>
          )}
          <button
            onClick={handleSend}
            disabled={sending}
            className="px-3 py-1.5 text-xs font-medium rounded-[var(--radius-md)] bg-[var(--accent-primary)] text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {sending ? 'Sending…' : 'Send to Telegram'}
          </button>
        </div>
      </div>

      <div className="p-6 space-y-6">
        {/* ── Summary Row ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <SummaryChip label="Completed" value={summary.totalCompleted} />
          <SummaryChip label="First Pass" value={`${Math.round(summary.avgFirstPass * 100)}%`} />
          <SummaryChip label="Bounces" value={summary.totalBounces} />
          <SummaryChip label="Active Agents" value={summary.activeAgents} />
        </div>

        {/* ── Top Performers ── */}
        <div>
          <h3 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">
            🏆 Top Performers
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <TopPerformerCard
              emoji="📦"
              label="Most Completed"
              agentId={tp.mostCompleted?.agentId ?? null}
              metric={tp.mostCompleted ? `${tp.mostCompleted.count} tasks` : null}
            />
            <TopPerformerCard
              emoji="⚡"
              label="Highest Throughput"
              agentId={tp.highestThroughput?.agentId ?? null}
              metric={tp.highestThroughput ? `${tp.highestThroughput.value.toFixed(1)}/hr` : null}
            />
            <TopPerformerCard
              emoji="🎯"
              label="Best Quality"
              agentId={tp.bestFirstPass?.agentId ?? null}
              metric={
                tp.bestFirstPass
                  ? `${Math.round(tp.bestFirstPass.rate * 100)}% first-pass, ${tp.bestFirstPass.tasks} tasks`
                  : null
              }
            />
            <TopPerformerCard
              emoji="🔥"
              label="Longest Streak"
              agentId={tp.longestStreak?.agentId ?? null}
              metric={tp.longestStreak ? `${tp.longestStreak.streak} clean tasks` : null}
            />
          </div>
        </div>

        {/* ── Areas of Attention ── */}
        {areasOfAttention.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">
              ⚠️ Attention Needed
            </h3>
            <ul className="space-y-1.5">
              {areasOfAttention.map((item, i) => (
                <li
                  key={i}
                  className="text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 rounded-[var(--radius-md)] border border-amber-200 dark:border-amber-800"
                >
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ── Version Progress ── */}
        {versionProgress.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">
              📈 Version Progress
            </h3>
            <div className="space-y-2">
              {versionProgress.map((vp, i) => (
                <div key={i} className="flex items-center gap-3">
                  <span className="text-xs text-[var(--text-secondary)] w-48 truncate shrink-0">
                    {vp.projectName} <span className="text-[var(--text-muted)]">v{vp.version}</span>
                  </span>
                  <VersionProgressBar done={vp.done} total={vp.total} />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Recent Kudos ── */}
        {recentKudos.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">
              🌟 Recent Kudos
            </h3>
            <ul className="space-y-1.5">
              {recentKudos.map((k, i) => (
                <li key={i} className="text-sm text-[var(--text-secondary)] flex items-start gap-2">
                  <span>{k.type === 'flag' ? '🚩' : '⭐'}</span>
                  <span>
                    <span className="font-medium text-[var(--text-primary)]">{k.agentId}:</span>{' '}
                    {k.note}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ── Coaching Highlights ── */}
        {coachingHighlights.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">
              💡 Coaching Highlights
            </h3>
            <ul className="space-y-1.5">
              {showCoaching.map((ch, i) => (
                <li key={i} className="text-sm text-[var(--text-secondary)] flex items-start gap-2">
                  <span className="shrink-0">•</span>
                  <span>
                    <span className="font-medium text-[var(--text-primary)]">{ch.agentId}:</span>{' '}
                    {ch.insight}
                  </span>
                </li>
              ))}
            </ul>
            {coachingHighlights.length > 3 && (
              <button
                onClick={() => setExpanded(v => !v)}
                className="mt-2 text-xs text-[var(--accent-primary)] hover:underline"
              >
                {expanded
                  ? 'Show less'
                  : `Show ${coachingHighlights.length - 3} more…`}
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function SummaryChip({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-[var(--radius-md)]">
      <p className="text-xs text-[var(--text-muted)]">{label}</p>
      <p className="text-xl font-bold text-[var(--text-primary)]">{value}</p>
    </div>
  );
}
