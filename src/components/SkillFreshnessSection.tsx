'use client';

/**
 * SkillFreshnessSection — #861 instrumentation widget.
 * Shows per-agent last skill install-ping + commit hash, color-coded by freshness.
 * Flags drift when an agent has been active recently but hasn't pinged in 24h.
 */
import { useEffect, useState } from 'react';

interface InstallRow {
  agent_id: string;
  skill: string;
  commit_hash: string | null;
  installed_at: string;
  age_seconds: number;
}

interface Teammate {
  agentId?: string;
  name?: string;
  emoji?: string;
  isHuman?: boolean;
}

function freshnessClass(ageSec: number | null): { cls: string; label: string } {
  if (ageSec == null) return { cls: 'text-red-500', label: 'never' };
  if (ageSec < 60 * 60 * 24) return { cls: 'text-green-500', label: 'fresh' };
  if (ageSec < 60 * 60 * 24 * 3) return { cls: 'text-yellow-500', label: 'stale' };
  return { cls: 'text-red-500', label: 'old' };
}

function formatAge(ageSec: number | null): string {
  if (ageSec == null) return '—';
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
  if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h ago`;
  return `${Math.floor(ageSec / 86400)}d ago`;
}

export default function SkillFreshnessSection() {
  const [installs, setInstalls] = useState<InstallRow[] | null>(null);
  const [teammates, setTeammates] = useState<Teammate[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [instRes, storeRes] = await Promise.all([
          fetch('/api/skill-install-ping'),
          fetch('/api/store'),
        ]);
        const instJson = await instRes.json();
        const storeJson = await storeRes.json();
        if (cancelled) return;
        setInstalls(Array.isArray(instJson.installs) ? instJson.installs : []);
        setTeammates(storeJson?.settings?.teammates || storeJson?.teammates || []);
      } catch {
        if (!cancelled) setInstalls([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const iv = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, []);

  // Join teammates ∪ installs: one row per non-human teammate + any orphan installs.
  const rows = (() => {
    const instByKey = new Map<string, InstallRow>();
    for (const r of installs || []) {
      instByKey.set(r.agent_id.toLowerCase(), r);
    }
    const out: Array<{
      agentId: string;
      name: string;
      emoji: string;
      install?: InstallRow;
    }> = [];
    for (const tm of teammates) {
      if (tm.isHuman) continue;
      const key = String(tm.agentId || tm.name || '').toLowerCase();
      const name = tm.name || tm.agentId || 'unknown';
      const install =
        instByKey.get(key) ||
        instByKey.get(String(tm.name || '').toLowerCase()) ||
        instByKey.get(String(tm.agentId || '').toLowerCase());
      if (install) instByKey.delete(install.agent_id.toLowerCase());
      out.push({ agentId: tm.agentId || tm.name || '', name, emoji: tm.emoji || '🤖', install });
    }
    // Orphan installs (agent pinged but no matching teammate)
    for (const [, install] of instByKey) {
      out.push({ agentId: install.agent_id, name: install.agent_id, emoji: '👻', install });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  })();

  return (
    <div className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-md)] p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">
          🔬 Skill Freshness
        </h3>
        <span className="text-xs text-[var(--text-muted)]">
          Last install-ping per agent · auto-refresh 60s
        </span>
      </div>

      {loading && <p className="text-xs text-[var(--text-muted)]">Loading…</p>}

      {!loading && rows.length === 0 && (
        <p className="text-xs text-[var(--text-muted)]">
          No agents configured.
        </p>
      )}

      {!loading && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[var(--text-muted)] border-b border-[var(--border-default)]">
                <th className="py-2 pr-3">Agent</th>
                <th className="py-2 pr-3">Last Install</th>
                <th className="py-2 pr-3">Commit</th>
                <th className="py-2 pr-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const age = r.install?.age_seconds ?? null;
                const fr = freshnessClass(age);
                return (
                  <tr key={r.agentId} className="border-b border-[var(--border-default)]/30">
                    <td className="py-2 pr-3 text-[var(--text-primary)]">
                      {r.emoji} {r.name}
                    </td>
                    <td className="py-2 pr-3 text-[var(--text-secondary)]">{formatAge(age)}</td>
                    <td className="py-2 pr-3 font-mono text-[var(--text-secondary)]">
                      {r.install?.commit_hash
                        ? r.install.commit_hash.slice(0, 7)
                        : '—'}
                    </td>
                    <td className={`py-2 pr-3 font-medium ${fr.cls}`}>{fr.label}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
        Agents run <code>npx skills add</code> at session start and post an install-ping.
        <span className="text-green-500"> fresh</span> = within 24h,
        <span className="text-yellow-500"> stale</span> = 1–3 days,
        <span className="text-red-500"> old/never</span> = 3+ days or never seen.
      </p>
    </div>
  );
}
