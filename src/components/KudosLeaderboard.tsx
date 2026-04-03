'use client';

import { useEffect, useState } from 'react';

interface Kudos {
  id: string;
  agentId: string;
  givenBy: string;
  values: string[];
  type: 'kudos' | 'flag';
  createdAt: number;
}

interface LeaderboardEntry {
  agentId: string;
  kudos: number;
  flags: number;
  topValue: string | null;
  net: number;
}

export function KudosLeaderboard() {
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/kudos?limit=1000');
        const data = await res.json();
        const allKudos: Kudos[] = data.kudos || [];

        // Group by agent
        const byAgent: Record<string, { kudos: number; flags: number; values: string[] }> = {};

        for (const k of allKudos) {
          if (!byAgent[k.agentId]) {
            byAgent[k.agentId] = { kudos: 0, flags: 0, values: [] };
          }
          if (k.type === 'kudos') {
            byAgent[k.agentId].kudos++;
            byAgent[k.agentId].values.push(...(k.values || []));
          } else {
            byAgent[k.agentId].flags++;
          }
        }

        // Convert to leaderboard
        const entries: LeaderboardEntry[] = Object.entries(byAgent).map(
          ([agentId, stats]) => {
            const valueCounts: Record<string, number> = {};
            for (const v of stats.values) {
              valueCounts[v] = (valueCounts[v] || 0) + 1;
            }
            const topValue =
              Object.entries(valueCounts).sort(([, a], [, b]) => b - a)[0]?.[0] ||
              null;

            return {
              agentId,
              kudos: stats.kudos,
              flags: stats.flags,
              topValue,
              net: stats.kudos - stats.flags,
            };
          }
        );

        // Sort by net descending
        entries.sort((a, b) => b.net - a.net);
        setLeaderboard(entries);
      } catch (err) {
        console.error('Failed to load leaderboard:', err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-8 text-center">
        <p className="text-[var(--text-muted)]">Loading leaderboard...</p>
      </div>
    );
  }

  if (leaderboard.length === 0) {
    return (
      <div className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-8 text-center">
        <p className="text-[var(--text-muted)] text-[var(--text-sm)]">
          No kudos data yet
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {leaderboard.slice(0, 10).map((entry, idx) => (
        <div
          key={entry.agentId}
          className="flex items-center justify-between p-3 bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-md)] hover:border-[var(--border-strong)] transition-colors"
        >
          <div className="flex items-center gap-3">
            <span className="text-[var(--text-xs)] font-bold text-[var(--text-muted)] w-6 text-right">
              #{idx + 1}
            </span>
            <div>
              <p className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">
                {entry.agentId}
              </p>
              {entry.topValue && (
                <p className="text-[var(--text-xs)] text-[var(--text-muted)]">
                  Top: #{entry.topValue}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-4 text-right">
            <div className="text-center">
              <div className="text-[var(--text-sm)] font-bold text-[var(--text-primary)]">
                {entry.kudos}
              </div>
              <div className="text-[10px] text-[var(--text-muted)]">
                {entry.kudos === 1 ? 'kudos' : 'kudos'}
              </div>
            </div>

            {entry.flags > 0 && (
              <div className="text-center text-amber-500">
                <div className="text-[var(--text-sm)] font-bold">-{entry.flags}</div>
                <div className="text-[10px]">flags</div>
              </div>
            )}

            <div className="w-16 text-right">
              <div className="flex justify-end gap-0.5">
                {Array.from({ length: Math.min(5, entry.net) }).map((_, i) => (
                  <span key={i} className="text-xs">
                    ⭐
                  </span>
                ))}
                {entry.net > 5 && (
                  <span className="text-[10px] text-[var(--text-muted)] font-semibold">
                    +{entry.net - 5}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
