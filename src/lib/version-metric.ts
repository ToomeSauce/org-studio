/**
 * Outcome-bound versions (#1263).
 *
 * A version with `successCriteria` set is "outcome-bound": it stays open
 * (won't auto-complete or auto-advance) until the configured measurable
 * goal is hit, even when all child tickets are done.
 *
 * Schema (all optional; additive on top of existing ComponentVersionLike):
 *   - successCriteria?: string                   — free-text statement of the goal
 *   - metricCurrent?:   number                   — last measured value (manual entry v1)
 *   - metricTarget?:    number                   — target value
 *   - metricComparator?: 'gte' | 'lte' | 'eq'    — comparison operator (default 'gte')
 *   - loopPaused?:      boolean                  — human kill-switch on the version
 *
 * Also stored under `meta.metricNotMetCommentedAt` and `meta.systemComments[]`
 * for once-per-transition system-comment idempotency. Those are not part of
 * `ComponentVersionLike`; they live on the rv-table `meta` column.
 *
 * Backward-compat: a version WITHOUT successCriteria is unaffected. The
 * helpers here all short-circuit "no gate" in that case.
 */

import type { ComponentVersionLike } from '@/lib/component-helpers';

export type MetricComparator = 'gte' | 'lte' | 'eq';

/** Subset of `ComponentVersionLike` we touch. Accepts plain rows too. */
export interface VersionWithMetric {
  successCriteria?: string | null;
  metricCurrent?: number | null;
  metricTarget?: number | null;
  metricComparator?: MetricComparator | string | null;
  loopPaused?: boolean | null;
}

/**
 * Returns true iff the metric gate is satisfied (or no gate is set).
 *
 * Semantics:
 *   - No `successCriteria` (undefined / empty string) → no gate → returns true.
 *   - `successCriteria` set but `metricTarget` is undefined → NOT met
 *     (criteria stated without a target == no measurable goal yet).
 *   - `metricCurrent` undefined → NOT met (no measurement taken yet).
 *   - Comparator default: 'gte'. Unknown values fall back to 'gte'.
 */
export function isVersionMetricMet(v: VersionWithMetric | null | undefined): boolean {
  if (!v) return true;
  const criteria = (v.successCriteria || '').toString().trim();
  if (!criteria) return true; // no gate

  if (typeof v.metricTarget !== 'number' || !Number.isFinite(v.metricTarget)) return false;
  if (typeof v.metricCurrent !== 'number' || !Number.isFinite(v.metricCurrent)) return false;

  const comp: MetricComparator =
    v.metricComparator === 'lte' || v.metricComparator === 'eq' ? v.metricComparator : 'gte';

  switch (comp) {
    case 'lte':
      return v.metricCurrent <= v.metricTarget;
    case 'eq':
      return v.metricCurrent === v.metricTarget;
    case 'gte':
    default:
      return v.metricCurrent >= v.metricTarget;
  }
}

/**
 * Returns true iff the version's loop is explicitly paused
 * (human kill-switch). Default false.
 */
export function isVersionLoopPaused(v: VersionWithMetric | null | undefined): boolean {
  return !!(v && v.loopPaused === true);
}

/**
 * Adapter: same logic, but reading from a row-shape used by the rv-table
 * code paths. The rv table stores meta in a separate `meta` jsonb column;
 * we read the metric fields from there if present, falling back to top-level
 * fields (for callers that have already lifted them).
 */
export function isRvRowMetricMet(row: any): boolean {
  if (!row) return true;
  const meta = row.meta && typeof row.meta === 'object' ? row.meta : {};
  return isVersionMetricMet({
    successCriteria: meta.successCriteria ?? row.successCriteria,
    metricCurrent: meta.metricCurrent ?? row.metricCurrent,
    metricTarget: meta.metricTarget ?? row.metricTarget,
    metricComparator: meta.metricComparator ?? row.metricComparator,
  });
}

export function isRvRowLoopPaused(row: any): boolean {
  if (!row) return false;
  const meta = row.meta && typeof row.meta === 'object' ? row.meta : {};
  return isVersionLoopPaused({
    loopPaused: meta.loopPaused ?? row.loopPaused,
  });
}

/**
 * Caps. Hard-coded per spec — no config knob.
 */
export const MAX_OPEN_EXPERIMENTS = 5;
export const MAX_AUTO_TASKS_PER_VERSION_PER_DAY = 3;
