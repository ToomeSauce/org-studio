'use client';

/**
 * BootstrapDriftSection — #864 silent-drift audit, vector #5.
 * Shows per-file bootstrap SHA match/drift for an agent.
 * Fetches from /api/agent/bootstrap-ping?agent=<id>&drift=true.
 */
import { useEffect, useState } from 'react';

interface FileStatus {
  path: string;
  reportedSha: string | null;
  sourceSha: string | null;
  match: boolean;
  drifted: boolean;
  pingedAt: string | null;
  ageSeconds: number | null;
}

interface DriftData {
  agentId: string;
  files: FileStatus[];
  hasDrift: boolean;
  lastPingedAt: string | null;
}

function formatAge(sec: number | null): string {
  if (sec == null) return '—';
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function shortSha(sha: string | null): string {
  if (!sha || sha.length < 12) return sha || '—';
  return sha.slice(0, 8);
}

export default function BootstrapDriftSection({ agentId }: { agentId?: string }) {
  const [data, setData] = useState<DriftData | null>(null);
  const [state, setState] = useState<'loading' | 'loaded' | 'none' | 'error'>('loading');

  useEffect(() => {
    if (!agentId) {
      setState('none');
      return;
    }
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(
          `/api/agent/bootstrap-ping?agent=${encodeURIComponent(agentId!)}&drift=true`
        );
        if (cancelled) return;
        if (!res.ok) {
          setState('error');
          return;
        }
        const json = await res.json();
        if (!json.drift || json.drift.files.length === 0) {
          setState('none');
          return;
        }
        setData(json.drift);
        setState('loaded');
      } catch {
        if (!cancelled) setState('error');
      }
    }
    load();
    const iv = setInterval(load, 60_000);
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
        No bootstrap ping received from this agent yet.
      </p>
    );
  }
  if (state === 'error' || !data) {
    return (
      <p className="text-[var(--text-xs)] text-[var(--text-muted)]">
        Unable to load bootstrap drift data.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {data.hasDrift && (
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-[var(--radius-sm)] bg-red-500/10 text-red-400 text-[var(--text-xs)] font-medium">
          ⚠️ Drift detected — agent may be reading stale files
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-[var(--text-xs)]">
          <thead>
            <tr className="text-left text-[var(--text-muted)] border-b border-[var(--border-default)]">
              <th className="py-1.5 pr-2">File</th>
              <th className="py-1.5 pr-2">Reported</th>
              <th className="py-1.5 pr-2">Source</th>
              <th className="py-1.5 pr-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {data.files.map((f) => (
              <tr key={f.path} className="border-b border-[var(--border-default)]/30">
                <td className="py-1.5 pr-2 text-[var(--text-primary)]">{f.path}</td>
                <td className="py-1.5 pr-2 font-mono text-[var(--text-secondary)]">
                  {shortSha(f.reportedSha)}
                </td>
                <td className="py-1.5 pr-2 font-mono text-[var(--text-secondary)]">
                  {shortSha(f.sourceSha)}
                </td>
                <td className="py-1.5 pr-2 font-medium">
                  {f.match ? (
                    <span className="text-green-500">✓ match</span>
                  ) : f.drifted ? (
                    <span className="text-red-500">✗ drifted</span>
                  ) : !f.reportedSha ? (
                    <span className="text-[var(--text-muted)]">not reported</span>
                  ) : !f.sourceSha ? (
                    <span className="text-yellow-500">no source</span>
                  ) : (
                    <span className="text-[var(--text-muted)]">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data.lastPingedAt && (
        <p className="text-[11px] text-[var(--text-muted)]">
          Last ping: {formatAge(data.files[0]?.ageSeconds ?? null)}
        </p>
      )}
    </div>
  );
}
