'use client';

/**
 * OrgRefreshSection — #864 silent-drift audit, vector #1.
 * Shows the last ORG.md generation for a given agent: sha, age, section count.
 * Data comes from /api/org-context/refreshes, populated in-memory on every
 * generation by /api/org-context.
 */
import { useEffect, useState } from 'react';

interface Refresh {
  sha: string;
  generatedAt: string;
  sections: number;
  ageMs: number;
}

function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function shortSha(sha: string): string {
  if (!sha || sha.length < 12) return sha || '—';
  return `${sha.slice(0, 8)}…${sha.slice(-4)}`;
}

function ageColor(ms: number): string {
  if (!Number.isFinite(ms)) return 'text-[var(--text-muted)]';
  if (ms < 60 * 60 * 1000) return 'text-green-500';
  if (ms < 6 * 60 * 60 * 1000) return 'text-yellow-500';
  return 'text-red-500';
}

export default function OrgRefreshSection({ agentId }: { agentId?: string }) {
  const [data, setData] = useState<Refresh | null>(null);
  const [state, setState] = useState<'loading' | 'loaded' | 'none' | 'error'>('loading');

  useEffect(() => {
    if (!agentId) {
      setState('none');
      return;
    }
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/org-context/refreshes?agent=${encodeURIComponent(agentId!)}`);
        if (cancelled) return;
        if (res.status === 404) {
          setData(null);
          setState('none');
          return;
        }
        if (!res.ok) {
          setState('error');
          return;
        }
        const json = await res.json();
        setData({
          sha: json.sha,
          generatedAt: json.generatedAt,
          sections: json.sections,
          ageMs: json.ageMs,
        });
        setState('loaded');
      } catch {
        if (!cancelled) setState('error');
      }
    }
    load();
    const iv = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [agentId]);

  if (state === 'loading') {
    return <p className="text-[var(--text-xs)] text-[var(--text-muted)]">Loading…</p>;
  }
  if (state === 'none') {
    return (
      <p className="text-[var(--text-xs)] text-[var(--text-muted)]">
        Never generated for this agent.
      </p>
    );
  }
  if (state === 'error' || !data) {
    return (
      <p className="text-[var(--text-xs)] text-[var(--text-muted)]">
        Unable to load refresh data.
      </p>
    );
  }

  return (
    <div className="space-y-1.5 text-[var(--text-xs)]">
      <div className="flex items-center justify-between">
        <span className="text-[var(--text-muted)]">sha</span>
        <span className="font-mono text-[var(--text-secondary)]" title={data.sha}>
          {shortSha(data.sha)}
        </span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[var(--text-muted)]">generated</span>
        <span className={`font-medium ${ageColor(data.ageMs)}`} title={data.generatedAt}>
          {formatAge(data.ageMs)}
        </span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[var(--text-muted)]">sections</span>
        <span className="text-[var(--text-secondary)]">{data.sections}</span>
      </div>
    </div>
  );
}
