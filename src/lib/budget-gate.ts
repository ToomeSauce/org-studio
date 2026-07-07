/**
 * Budget gate (#1653, Phase A-2 of the Idea → Fruition pipeline).
 *
 * Pure, side-effect-free budget predicates consumed by dispatch-gate.ts as
 * "rule 6". IO (fetching month-to-date spend) lives in budget-spend.ts —
 * callers fetch a ProjectSpendSnapshot once per scheduling pass and thread
 * it through; these functions only compare numbers.
 *
 * Fail-open doctrine: a missing budget, missing snapshot, or missing project
 * entry NEVER blocks dispatch. Budget enforcement is a leash, not a landmine —
 * absent data means "no ceiling configured / no spend metered", not "hold
 * everything". Enforcement is v1-scoped to ceilingUsdMonth (calendar month,
 * metered dispatch cost only); ceilingUsdVersion is display-only until a
 * follow-up ticket.
 */

export interface ProjectSpendSnapshot {
  /** projectId → current-calendar-month metered spend in USD. */
  [projectId: string]: number;
}

interface BudgetProjectLike {
  id: string;
  budget?: {
    ceilingUsdMonth?: number;
    ceilingUsdVersion?: number;
    alertPct?: number;
  };
}

const DEFAULT_ALERT_PCT = 80;

function monthCeiling(project: BudgetProjectLike | null | undefined): number | null {
  const ceiling = project?.budget?.ceilingUsdMonth;
  if (typeof ceiling !== 'number' || !Number.isFinite(ceiling) || ceiling <= 0) return null;
  return ceiling;
}

function meteredSpend(
  project: BudgetProjectLike | null | undefined,
  snapshot: ProjectSpendSnapshot | null | undefined,
): number | null {
  if (!project?.id || !snapshot) return null;
  const spend = snapshot[project.id];
  if (typeof spend !== 'number' || !Number.isFinite(spend) || spend < 0) return null;
  return spend;
}

/**
 * Rule 6 predicate: true ONLY when a positive monthly ceiling is configured
 * AND the snapshot has a metered spend figure for this project AND that
 * spend has reached/passed the ceiling. Every absent input → false.
 */
export function isProjectBudgetExceeded(
  project: BudgetProjectLike | null | undefined,
  snapshot: ProjectSpendSnapshot | null | undefined,
): boolean {
  const ceiling = monthCeiling(project);
  if (ceiling === null) return false;
  const spend = meteredSpend(project, snapshot);
  if (spend === null) return false;
  return spend >= ceiling;
}

export type BudgetAlertState = 'none' | 'warn' | 'exceeded';

/**
 * Alert state for threshold notifications (#1653 alert-once) and for UI
 * burn-bar coloring (#1655). `warn` starts at alertPct% of the ceiling
 * (default 80, matching autonomy-budget's read-time normalization).
 */
export function budgetAlertState(
  project: BudgetProjectLike | null | undefined,
  snapshot: ProjectSpendSnapshot | null | undefined,
): BudgetAlertState {
  const ceiling = monthCeiling(project);
  if (ceiling === null) return 'none';
  const spend = meteredSpend(project, snapshot);
  if (spend === null) return 'none';
  if (spend >= ceiling) return 'exceeded';
  const rawPct = project?.budget?.alertPct;
  const alertPct =
    Number.isInteger(rawPct) && (rawPct as number) >= 1 && (rawPct as number) <= 99
      ? (rawPct as number)
      : DEFAULT_ALERT_PCT;
  if (spend >= ceiling * (alertPct / 100)) return 'warn';
  return 'none';
}

/** Current calendar month key used by the alert-once dedup marker. */
export function currentMonthKey(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export interface BudgetAlertsMarker {
  [monthKey: string]: { warnedAt?: number; exceededAt?: number };
}

/**
 * Pure dedup decision for the alert-once path: given the project's persisted
 * budgetAlerts marker and the current alert state, should we notify now?
 * Escalation from warn → exceeded within the same month DOES notify again
 * (they are distinct one-shots); repeats of the same state do not.
 */
export function shouldSendBudgetAlert(
  marker: BudgetAlertsMarker | null | undefined,
  state: BudgetAlertState,
  monthKey: string,
): boolean {
  if (state === 'none') return false;
  const month = marker?.[monthKey];
  if (state === 'warn') return !month?.warnedAt && !month?.exceededAt;
  return !month?.exceededAt;
}
