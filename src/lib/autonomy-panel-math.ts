/**
 * autonomy-panel-math.ts — #1655 (Phase A-4, Idea → Fruition pipeline).
 *
 * Pure burn-bar / pace math for the Autonomy panel. Kept out of the React
 * component so the numbers are unit-testable without a DOM.
 *
 * Conventions (match budget-gate.ts semantics):
 *   - Only METERED spend is enforced/compared against the ceiling.
 *     Unmetered activity is surfaced as an honest separate line, never
 *     mixed into the burn bar.
 *   - alertPct defaults to 80 (same default as validateBudget in
 *     autonomy-budget.ts / budget-gate.ts).
 */

export interface BurnBarModel {
  /** 0..100 — fill percent of the burn bar (clamped). */
  fillPct: number;
  /** 0..100 — where the alert marker sits. */
  alertPct: number;
  /** 'ok' | 'warn' | 'exceeded' — bar color state (mirrors budgetAlertState). */
  state: 'ok' | 'warn' | 'exceeded';
}

/**
 * Burn bar geometry from spend vs ceiling. Returns null when there is no
 * ceiling to burn against (no bar without a budget line).
 */
export function computeBurnBar(
  spendUsd: number | null | undefined,
  ceilingUsdMonth: number | null | undefined,
  alertPct?: number | null,
): BurnBarModel | null {
  if (ceilingUsdMonth == null || !Number.isFinite(ceilingUsdMonth) || ceilingUsdMonth <= 0) {
    return null;
  }
  const spend = typeof spendUsd === 'number' && Number.isFinite(spendUsd) && spendUsd > 0 ? spendUsd : 0;
  const alert =
    Number.isInteger(alertPct) && (alertPct as number) >= 1 && (alertPct as number) <= 99
      ? (alertPct as number)
      : 80;
  const rawPct = (spend / ceilingUsdMonth) * 100;
  const fillPct = Math.max(0, Math.min(100, rawPct));
  const state: BurnBarModel['state'] =
    spend >= ceilingUsdMonth ? 'exceeded' : rawPct >= alert ? 'warn' : 'ok';
  return { fillPct, alertPct: alert, state };
}

/**
 * Naive linear month-end pace estimate: spend so far ÷ elapsed days ×
 * days in month. Returns null when spend is unknown or the month has
 * barely started (day 0 guard).
 *
 * `now` injectable for tests.
 */
export function estimateMonthEndPace(
  spendUsd: number | null | undefined,
  now: Date = new Date(),
): number | null {
  if (typeof spendUsd !== 'number' || !Number.isFinite(spendUsd) || spendUsd < 0) return null;
  const dayOfMonth = now.getDate();
  if (dayOfMonth < 1) return null;
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return (spendUsd / dayOfMonth) * daysInMonth;
}

/** Days elapsed in the current month — used as the windowDays for the
 *  month-to-date-ish read of /api/observability/costs (rolling window,
 *  anchored "close enough" to the month start; labeled as such in the UI). */
export function monthToDateWindowDays(now: Date = new Date()): number {
  return Math.max(1, now.getDate());
}
