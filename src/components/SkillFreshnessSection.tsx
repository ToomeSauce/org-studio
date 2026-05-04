'use client';

/**
 * SkillFreshnessSection — #861 + #980 instrumentation widget.
 *
 * #861: per-agent last install-ping for org-studio + commit hash, color-coded by freshness.
 * #980: extended to every installed skill, not just org-studio. Renders one row per
 *       (agent, skill) pair with an optional skill filter.
 */
import { useEffect, useMemo, useState } from 'react';

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
  const [skillFilter, setSkillFilter] = useState<string>('all');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [instRes, storeRes] = await Promise.all([
          fetch('/api/skill-install-ping?skill=all'),
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

  // Distinct skills observed in the install table
  const skillOptions = useMemo(() => {
    const s = new Set<string>();
    for (const r of installs || []) s.add(r.skill);
    return Array.from(s).sort();
  }, [installs]);

  // Filter installs by selected skill (or all)
  const filteredInstalls = useMemo(() => {
    if (skillFilter === 'all') return installs || [];
    return (installs || []).filter((r) => r.skill === skillFilter);
  }, [installs, skillFilter]);

  // Build rows: one per (teammate, skill) pair with an install + orphan rows
  // for agents who pinged but aren't in the teammate list.
  const rows = useMemo(() => {
    const teammateByKey = new Map<string, Teammate>();
    for (const tm of teammates) {
      if (tm.isHuman) continue;
      if (tm.agentId) teammateByKey.set(tm.agentId.toLowerCase(), tm);
      if (tm.name) teammateByKey.set(tm.name.toLowerCase(), tm);
    }

    const out: Array<{
      key: string;
      agentId: string;
      name: string;
      emoji: string;
      skill: string;
      install: InstallRow;
      orphan: boolean;
    }> = [];

    for (const inst of filteredInstalls) {
      const key = inst.agent_id.toLowerCase();
      const tm = teammateByKey.get(key);
      out.push({
        key: `${inst.agent_id}::${inst.skill}`,
        agentId: tm?.agentId || inst.agent_id,
        name: tm?.name || inst.agent_id,
        emoji: tm?.emoji || (tm ? '🤖' : '👻'),
        skill: inst.skill,
        install: inst,
        orphan: !tm,
      });
    }

    return out.sort((a, b) => {
      const n = a.name.localeCompare(b.name);
      if (n !== 0) return n;
      return a.skill.localeCompare(b.skill);
    });
  }, [filteredInstalls, teammates]);

  // Distinct agent count for the header summary
  const distinctAgents = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) s.add(r.agentId);
    return s.size;
  }, [rows]);

  return (
    <div className="bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-md)] p-5 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">
          🔬 Skill Freshness
        </h3>
        <div className="flex items-center gap-2 text-xs">
          <label className="text-[var(--text-muted)]">Skill:</label>
          <select
            value={skillFilter}
            onChange={(e) => setSkillFilter(e.target.value)}
            className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded px-2 py-0.5 text-[var(--text-primary)]"
          >
            <option value="all">all ({skillOptions.length})</option>
            {skillOptions.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <span className="text-[var(--text-muted)]">
            · {rows.length} pair{rows.length === 1 ? '' : 's'}, {distinctAgents} agent{distinctAgents === 1 ? '' : 's'} · 60s refresh
          </span>
        </div>
      </div>

      {loading && <p className="text-xs text-[var(--text-muted)]">Loading…</p>}

      {!loading && rows.length === 0 && (
        <p className="text-xs text-[var(--text-muted)]">
          {skillFilter === 'all'
            ? 'No skill installs recorded yet. Agents ping after running the API Reference snippet at session start.'
            : `No installs recorded for skill "${skillFilter}".`}
        </p>
      )}

      {!loading && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[var(--text-muted)] border-b border-[var(--border-default)]">
                <th className="py-2 pr-3">Agent</th>
                <th className="py-2 pr-3">Skill</th>
                <th className="py-2 pr-3">Last Install</th>
                <th className="py-2 pr-3">Version</th>
                <th className="py-2 pr-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const age = r.install.age_seconds;
                const fr = freshnessClass(age);
                return (
                  <tr key={r.key} className="border-b border-[var(--border-default)]/30">
                    <td className="py-2 pr-3 text-[var(--text-primary)]">
                      {r.emoji} {r.name}
                      {r.orphan && (
                        <span className="ml-1 text-[var(--text-muted)] italic">
                          (orphan)
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-[var(--text-secondary)]">
                      <code className="text-[11px]">{r.skill}</code>
                    </td>
                    <td className="py-2 pr-3 text-[var(--text-secondary)]">{formatAge(age)}</td>
                    <td className="py-2 pr-3 font-mono text-[var(--text-secondary)]">
                      {r.install.commit_hash ? r.install.commit_hash.slice(0, 7) : '—'}
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
        Agents ping at session start (#861 + #980 hook in ORG.md). Each row is one (agent, skill) pair.
        <span className="text-green-500"> fresh</span> = within 24h,
        <span className="text-yellow-500"> stale</span> = 1–3 days,
        <span className="text-red-500"> old/never</span> = 3+ days. Version = git short SHA, <code>skill.json#version</code>, or sha1 of <code>SKILL.md</code>.
      </p>
    </div>
  );
}
