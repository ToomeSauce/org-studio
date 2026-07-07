/**
 * AutonomyPanel — #1655 (Phase A-4, Idea → Fruition pipeline).
 *
 * The three-dials view from the proto-idea-pipeline mockup (screen 6),
 * rendered inside Project Settings: Horizon · Budget · Boundaries, plus
 * the loopPaused kill switch — one glance, one leash.
 *
 * Design constraints (One Leash convention, ticket #1655):
 *   - Horizon edits go through the EXISTING approval flow — the same
 *     `updateComponent { approvedVersions[] }` write that
 *     RoadmapWithApprovalHorizon uses. No parallel approval path.
 *   - Budget edits round-trip through the A-1 (#1652) updateProject API
 *     (`budget` validated server-side by validateBudget).
 *   - Spend/burn reads from /api/observability/costs (#1644). Only
 *     METERED spend fills the burn bar; unmetered activity is an honest
 *     separate line. Version ceiling is display-only (v1 enforces monthly).
 *   - Kill switch = the version-level `loopPaused` flag on the current
 *     version (the one the dispatcher actually reads) — surfaced, not
 *     buried in the roadmap edit form.
 */

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import clsx from 'clsx';
import {
  getEffectiveComponents,
  getComponentVersions,
  getPrimaryComponent,
} from '@/lib/component-helpers';
import { compareVersions } from '@/lib/version-utils';
import {
  computeBurnBar,
  estimateMonthEndPace,
  monthToDateWindowDays,
} from '@/lib/autonomy-panel-math';

interface Props {
  project: any; // full project object from the store snapshot
}

const inputCls =
  'w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]';
const labelCls = 'text-xs uppercase tracking-[0.1em] text-[var(--text-muted)]';

function DialCard({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4">
      <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">{title}</h3>
      <p className="text-[11px] text-[var(--text-muted)] mb-3">{sub}</p>
      {children}
    </div>
  );
}

export default function AutonomyPanel({ project }: Props) {
  const projectId: string = project?.id;

  /* ------------------------------------------------------------------ */
  /* Horizon dial — component.approvedVersions[] on the primary component */
  /* ------------------------------------------------------------------ */
  const primaryComponent = useMemo(
    () => (project ? getPrimaryComponent(project) ?? getEffectiveComponents(project)[0] ?? null : null),
    [project],
  );
  const versions = useMemo<any[]>(() => {
    if (!project || !primaryComponent) return [];
    return [...(getComponentVersions(project, primaryComponent.id) as any[])].sort((a, b) =>
      compareVersions(a.version, b.version),
    );
  }, [project, primaryComponent]);

  // Optimistic local override for approvedVersions — same pattern as
  // RoadmapWithApprovalHorizon (#1188): prop wins once the WS push lands.
  const [optimisticApproved, setOptimisticApproved] = useState<string[] | null>(null);
  useEffect(() => setOptimisticApproved(null), [project]);
  const approvedList: string[] =
    optimisticApproved ??
    (Array.isArray((primaryComponent as any)?.approvedVersions)
      ? (primaryComponent as any).approvedVersions
      : []);

  const [horizonBusy, setHorizonBusy] = useState<string | null>(null);
  const toggleApproval = useCallback(
    async (versionStr: string) => {
      if (!primaryComponent) return;
      const prev = approvedList;
      const next = prev.includes(versionStr)
        ? prev.filter((v) => v !== versionStr)
        : [...prev, versionStr];
      setOptimisticApproved(next);
      setHorizonBusy(versionStr);
      try {
        // One Leash: the exact same write RoadmapWithApprovalHorizon does.
        // updateComponent's approvedVersions handler also fires the
        // auto-promote flow server-side — no parallel approval path here.
        const resp = await fetch('/api/store', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'updateComponent',
            projectId,
            componentId: primaryComponent.id,
            updates: { approvedVersions: next },
          }),
        });
        if (!resp.ok) setOptimisticApproved(prev);
      } catch {
        setOptimisticApproved(prev);
      } finally {
        setHorizonBusy(null);
      }
    },
    [projectId, primaryComponent, approvedList],
  );

  const horizonMax = useMemo(() => {
    if (approvedList.length === 0) return null;
    return [...approvedList].sort(compareVersions)[approvedList.length - 1];
  }, [approvedList]);

  /* ------------------------------------------------------------------ */
  /* Budget dial — project.budget (#1652) + spend from /api/observability */
  /* ------------------------------------------------------------------ */
  const budget = project?.budget || {};
  const [ceilingStr, setCeilingStr] = useState<string>(
    budget.ceilingUsdMonth != null ? String(budget.ceilingUsdMonth) : '',
  );
  const [alertPctStr, setAlertPctStr] = useState<string>(
    budget.alertPct != null ? String(budget.alertPct) : '80',
  );
  useEffect(() => {
    setCeilingStr(budget.ceilingUsdMonth != null ? String(budget.ceilingUsdMonth) : '');
    setAlertPctStr(budget.alertPct != null ? String(budget.alertPct) : '80');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, budget.ceilingUsdMonth, budget.alertPct]);

  const [budgetSaving, setBudgetSaving] = useState(false);
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [budgetSavedAt, setBudgetSavedAt] = useState<number | null>(null);

  const ceilingNum = ceilingStr.trim() === '' ? null : Number(ceilingStr);
  const alertPctNum = alertPctStr.trim() === '' ? 80 : Number(alertPctStr);
  const budgetDirty =
    (ceilingNum ?? undefined) !== budget.ceilingUsdMonth ||
    alertPctNum !== (budget.alertPct ?? 80);
  const budgetValid =
    (ceilingNum === null || (Number.isFinite(ceilingNum) && ceilingNum > 0)) &&
    Number.isInteger(alertPctNum) &&
    alertPctNum >= 1 &&
    alertPctNum <= 99;

  const saveBudget = useCallback(async () => {
    if (!budgetValid || budgetSaving) return;
    setBudgetSaving(true);
    setBudgetError(null);
    try {
      // Whole-object replace (validateBudget on the server rejects unknown
      // keys) — preserve the display-only version ceiling untouched.
      const nextBudget: any = { alertPct: alertPctNum };
      if (ceilingNum != null) nextBudget.ceilingUsdMonth = ceilingNum;
      if (budget.ceilingUsdVersion != null) nextBudget.ceilingUsdVersion = budget.ceilingUsdVersion;
      const resp = await fetch('/api/store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'updateProject',
          id: projectId,
          updates: { budget: nextBudget },
        }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({} as any));
        throw new Error(body?.error || `HTTP ${resp.status}`);
      }
      setBudgetSavedAt(Date.now());
    } catch (e: any) {
      setBudgetError(e?.message || 'Save failed');
    } finally {
      setBudgetSaving(false);
    }
  }, [projectId, budgetValid, budgetSaving, ceilingNum, alertPctNum, budget.ceilingUsdVersion]);

  // Spend read — /api/observability/costs, month-to-date-ish window
  // (windowDays anchored to day-of-month; costs API is a rolling window,
  // labeled honestly below).
  const [spend, setSpend] = useState<{
    metered: number;
    unmeteredCalls: number;
    loaded: boolean;
    error: boolean;
  }>({ metered: 0, unmeteredCalls: 0, loaded: false, error: false });

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    fetch(`/api/observability/costs?windowDays=${monthToDateWindowDays()}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        if (cancelled) return;
        const row = (d?.byProject || []).find((p: any) => p.key === projectId);
        setSpend({
          metered: row ? Number(row.cost) || 0 : 0,
          unmeteredCalls: row ? Math.max(0, (Number(row.calls) || 0) - (Number(row.meteredCalls) || 0)) : 0,
          loaded: true,
          error: false,
        });
      })
      .catch(() => {
        if (!cancelled) setSpend((s) => ({ ...s, loaded: true, error: true }));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const effectiveCeiling = budget.ceilingUsdMonth ?? null;
  const burn = computeBurnBar(spend.metered, effectiveCeiling, budget.alertPct);
  const pace = estimateMonthEndPace(spend.loaded && !spend.error ? spend.metered : null);

  /* ------------------------------------------------------------------ */
  /* Boundaries dial — project.boundaries (#1652)                        */
  /* ------------------------------------------------------------------ */
  const boundaries = project?.boundaries || { freeToDecide: [], mustAsk: [] };
  const [freeText, setFreeText] = useState<string>((boundaries.freeToDecide || []).join('\n'));
  const [mustText, setMustText] = useState<string>((boundaries.mustAsk || []).join('\n'));
  useEffect(() => {
    setFreeText((project?.boundaries?.freeToDecide || []).join('\n'));
    setMustText((project?.boundaries?.mustAsk || []).join('\n'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  const [boundariesSaving, setBoundariesSaving] = useState(false);
  const [boundariesError, setBoundariesError] = useState<string | null>(null);
  const [boundariesSavedAt, setBoundariesSavedAt] = useState<number | null>(null);

  const parseLines = (t: string) => t.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const boundariesDirty =
    parseLines(freeText).join('\u0000') !== (boundaries.freeToDecide || []).join('\u0000') ||
    parseLines(mustText).join('\u0000') !== (boundaries.mustAsk || []).join('\u0000');

  const saveBoundaries = useCallback(async () => {
    if (boundariesSaving) return;
    setBoundariesSaving(true);
    setBoundariesError(null);
    try {
      const resp = await fetch('/api/store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'updateProject',
          id: projectId,
          updates: {
            boundaries: { freeToDecide: parseLines(freeText), mustAsk: parseLines(mustText) },
          },
        }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({} as any));
        throw new Error(body?.error || `HTTP ${resp.status}`);
      }
      setBoundariesSavedAt(Date.now());
    } catch (e: any) {
      setBoundariesError(e?.message || 'Save failed');
    } finally {
      setBoundariesSaving(false);
    }
  }, [projectId, freeText, mustText, boundariesSaving]);

  /* ------------------------------------------------------------------ */
  /* Kill switch — loopPaused on the current version                     */
  /* ------------------------------------------------------------------ */
  const killTargetVersion = useMemo<any | null>(() => {
    // The version the dispatcher is actually working: explicit 'current',
    // else the first unshipped approved version (semver asc).
    const explicit = versions.find((v) => v.status === 'current');
    if (explicit) return explicit;
    return versions.find((v) => v.status !== 'shipped' && approvedList.includes(v.version)) ?? null;
  }, [versions, approvedList]);

  const [optimisticPaused, setOptimisticPaused] = useState<boolean | null>(null);
  useEffect(() => setOptimisticPaused(null), [project, killTargetVersion?.version]);
  const paused = optimisticPaused ?? !!killTargetVersion?.loopPaused;

  const [killBusy, setKillBusy] = useState(false);
  const toggleKillSwitch = useCallback(async () => {
    if (!killTargetVersion || killBusy) return;
    const next = !paused;
    setOptimisticPaused(next);
    setKillBusy(true);
    try {
      // Full-field upsert (title/status/items echoed back) — the roadmap
      // upsert replaces those columns, so a meta-only payload would clobber
      // them. Same shape RoadmapWithApprovalHorizon's saveVersion sends.
      const resp = await fetch(`/api/roadmap/${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'upsert',
          version: killTargetVersion.version,
          title: killTargetVersion.title,
          status: killTargetVersion.status,
          items: killTargetVersion.items || [],
          versionType: killTargetVersion.version_type || 'outcome',
          loopPaused: next,
        }),
      });
      if (!resp.ok) setOptimisticPaused(!next);
    } catch {
      setOptimisticPaused(!next);
    } finally {
      setKillBusy(false);
    }
  }, [projectId, killTargetVersion, paused, killBusy]);

  if (!project) return null;

  const fmtUsd = (n: number) =>
    n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2).replace(/\.00$/, '')}`;

  return (
    <section aria-label="Autonomy" className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Autonomy</h3>
        <p className="text-[11px] text-[var(--text-muted)]">
          Three dials, one glance. Agents decide anything reversible by default — you only hear
          about what crosses a line.
        </p>
      </div>

      {/* ---- Horizon ---- */}
      <DialCard
        title="Horizon"
        sub={
          horizonMax
            ? `approved through ${horizonMax} — agents execute approved versions, never above`
            : 'nothing approved — dispatcher holds all versioned work'
        }
      >
        {versions.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)]">
            No roadmap versions on the primary component yet.
          </p>
        ) : (
          <div className="space-y-1 max-h-44 overflow-y-auto pr-1">
            {versions.map((v) => {
              const approved = approvedList.includes(v.version);
              const shipped = v.status === 'shipped';
              return (
                <label
                  key={v.version}
                  className={clsx(
                    'flex items-center gap-2 text-xs rounded px-1.5 py-1 cursor-pointer hover:bg-[var(--bg-tertiary)]',
                    shipped && 'opacity-60',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={approved}
                    disabled={horizonBusy === v.version}
                    onChange={() => toggleApproval(v.version)}
                    className="w-3.5 h-3.5 accent-[var(--accent-primary)]"
                  />
                  <span className="font-mono text-[var(--text-secondary)]">{v.version}</span>
                  <span className="flex-1 truncate text-[var(--text-muted)]">{v.title}</span>
                  {horizonBusy === v.version && <Loader2 size={11} className="animate-spin" />}
                  {shipped && <span className="text-[10px] text-[var(--text-muted)]">shipped</span>}
                  {v.status === 'current' && (
                    <span className="text-[10px] px-1 rounded bg-[var(--bg-tertiary)] text-[var(--accent)]">current</span>
                  )}
                </label>
              );
            })}
          </div>
        )}
        <p className="mt-2 text-[10px] text-[var(--text-muted)]">
          Same switch as the roadmap approval checkboxes — one leash, no second path.
        </p>
      </DialCard>

      {/* ---- Budget ---- */}
      <DialCard title="Budget" sub="hard monthly ceiling — dispatch holds beyond it">
        <div className="flex items-end gap-2">
          <label className="block flex-1">
            <span className={labelCls}>Ceiling ($/month)</span>
            <input
              type="number"
              min={1}
              step="any"
              value={ceilingStr}
              onChange={(e) => setCeilingStr(e.target.value)}
              placeholder="none — unlimited"
              className={clsx(inputCls, 'mt-1 font-mono text-sm')}
            />
          </label>
          <label className="block w-24">
            <span className={labelCls}>Alert %</span>
            <input
              type="number"
              min={1}
              max={99}
              value={alertPctStr}
              onChange={(e) => setAlertPctStr(e.target.value)}
              className={clsx(inputCls, 'mt-1 font-mono text-sm')}
            />
          </label>
          <button
            type="button"
            onClick={saveBudget}
            disabled={!budgetDirty || !budgetValid || budgetSaving}
            className="px-3 py-2 rounded text-xs font-medium bg-[var(--accent-primary)] text-white hover:opacity-90 disabled:opacity-40 transition-opacity"
          >
            {budgetSaving ? <Loader2 size={12} className="animate-spin" /> : 'Save'}
          </button>
        </div>
        {!budgetValid && (
          <p className="mt-1 text-[11px] text-red-500">
            Ceiling must be a positive number; alert % an integer 1–99.
          </p>
        )}
        {budgetError && <p className="mt-1 text-[11px] text-red-500">{budgetError}</p>}
        {budgetSavedAt && !budgetDirty && !budgetError && (
          <p className="mt-1 text-[11px] text-emerald-600">Saved.</p>
        )}

        {/* Burn bar — metered spend only */}
        <div className="mt-3">
          {burn ? (
            <>
              <div className="flex items-baseline justify-between text-[11px] font-mono text-[var(--text-secondary)]">
                <span>
                  {spend.loaded && !spend.error ? fmtUsd(spend.metered) : '…'} metered · month to date
                </span>
                <span className="text-[var(--text-muted)]">of {fmtUsd(effectiveCeiling!)}</span>
              </div>
              <div className="relative mt-1 h-2 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
                <div
                  data-testid="burn-fill"
                  className={clsx(
                    'h-full rounded-full transition-all',
                    burn.state === 'exceeded'
                      ? 'bg-red-500'
                      : burn.state === 'warn'
                        ? 'bg-amber-500'
                        : 'bg-emerald-500',
                  )}
                  style={{ width: `${burn.fillPct}%` }}
                />
                {/* alertPct marker */}
                <div
                  className="absolute top-0 h-full w-px bg-[var(--text-muted)] opacity-60"
                  style={{ left: `${burn.alertPct}%` }}
                  title={`Alert at ${burn.alertPct}%`}
                />
              </div>
              <div className="mt-1 flex justify-between text-[10px] font-mono text-[var(--text-muted)]">
                <span>
                  {pace != null && spend.loaded && !spend.error
                    ? `pace: ~${fmtUsd(pace)}/mo at current burn`
                    : ''}
                </span>
                <span>alert at {burn.alertPct}%</span>
              </div>
            </>
          ) : (
            <p className="text-[11px] text-[var(--text-muted)]">
              No monthly ceiling set — spend is unenforced.{' '}
              {spend.loaded && !spend.error ? `Metered month-to-date: ${fmtUsd(spend.metered)}.` : ''}
            </p>
          )}
          {/* Honest lines: unmetered + version ceiling (display-only) */}
          <div className="mt-2 space-y-0.5 text-[10px] font-mono text-[var(--text-muted)]">
            {spend.error && <div>spend read unavailable — enforcement still runs server-side</div>}
            {!spend.error && spend.loaded && (
              <div>
                unmetered: {spend.unmeteredCalls} call{spend.unmeteredCalls === 1 ? '' : 's'} this
                month (no cost data — shown, never enforced)
              </div>
            )}
            {budget.ceilingUsdVersion != null && (
              <div>version ceiling: {fmtUsd(budget.ceilingUsdVersion)} (display-only — v1 enforces monthly)</div>
            )}
          </div>
        </div>
      </DialCard>

      {/* ---- Boundaries ---- */}
      <DialCard title="Boundaries" sub="structured contract, enforced in dispatch prompts — not prose">
        <div className="grid grid-cols-1 gap-2">
          <label className="block">
            <span className={labelCls}>Free to decide (one per line)</span>
            <textarea
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              rows={3}
              placeholder={'Any reversible decision (default)\nTech stack & architecture'}
              className={clsx(inputCls, 'mt-1 text-xs')}
            />
          </label>
          <label className="block">
            <span className={labelCls}>Must ask (one per line)</span>
            <textarea
              value={mustText}
              onChange={(e) => setMustText(e.target.value)}
              rows={3}
              placeholder={'Spending real money beyond budget line\nAnything user-visible going public'}
              className={clsx(inputCls, 'mt-1 text-xs')}
            />
          </label>
        </div>
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[10px] text-[var(--text-muted)]">
            Reversible decisions are the agent&apos;s by default.
          </span>
          <button
            type="button"
            onClick={saveBoundaries}
            disabled={!boundariesDirty || boundariesSaving}
            className="px-3 py-1.5 rounded text-xs font-medium bg-[var(--accent-primary)] text-white hover:opacity-90 disabled:opacity-40 transition-opacity"
          >
            {boundariesSaving ? <Loader2 size={12} className="animate-spin" /> : 'Save'}
          </button>
        </div>
        {boundariesError && <p className="mt-1 text-[11px] text-red-500">{boundariesError}</p>}
        {boundariesSavedAt && !boundariesDirty && !boundariesError && (
          <p className="mt-1 text-[11px] text-emerald-600">Saved.</p>
        )}
      </DialCard>

      {/* ---- Kill switch ---- */}
      <div
        className={clsx(
          'flex items-center justify-between rounded-lg border p-4',
          paused
            ? 'border-amber-400/60 bg-amber-50 dark:bg-amber-950/20'
            : 'border-[var(--border-color)] bg-[var(--bg-secondary)]',
        )}
      >
        <div>
          <div className="text-[13px] font-semibold text-[var(--text-primary)]">
            {paused ? 'Loop paused' : 'Loop active'}
            {killTargetVersion && (
              <span className="ml-2 font-mono text-[11px] text-[var(--text-muted)]">
                v{killTargetVersion.version}
              </span>
            )}
          </div>
          <div className="text-[11px] text-[var(--text-muted)]">
            {killTargetVersion
              ? 'loopPaused kill switch on the active version — always visible, never buried'
              : 'no active version to pause — approve/launch one first'}
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={!paused}
          aria-label={paused ? 'Resume loop' : 'Pause loop'}
          disabled={!killTargetVersion || killBusy}
          onClick={toggleKillSwitch}
          className={clsx(
            'relative w-11 h-6 rounded-full border transition-colors disabled:opacity-40',
            !paused
              ? 'bg-emerald-100 dark:bg-emerald-950/40 border-emerald-500'
              : 'bg-[var(--bg-tertiary)] border-[var(--border-strong)]',
          )}
        >
          <span
            className={clsx(
              'absolute top-0.5 w-4.5 h-4.5 rounded-full transition-all',
              !paused ? 'left-[22px] bg-emerald-500' : 'left-0.5 bg-[var(--text-muted)]',
            )}
            style={{ width: 18, height: 18 }}
          />
        </button>
      </div>
    </section>
  );
}
