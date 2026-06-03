/**
 * #1585 — "Done-but-unmet" nudge (Phase B of experiment-loop legibility).
 *
 * When EVERY child ticket of an outcome-bound version is done but the
 * measured metric still misses its target, the loop isn't finished — the
 * hypothesis didn't move the number. This surfaces that state as an
 * actionable "propose the next experiment" prompt:
 *   - in the UI (the hypothesis card shows a call-to-action), and
 *   - as a scheduler signal to the OWNING agent (one nudge, on-demand).
 *
 * It does NOT auto-spawn unsupervised experiment chains (#1263 already
 * refuses to auto-complete an unmet version). On-demand, summarize-once,
 * idempotent — same discipline as the Domain Steward (#1589).
 *
 * Pure module (mirrors domain-steward.ts / claim-contract.ts): no clock,
 * no IO, no RPC. `now` injected; the scheduler route owns dispatch.
 */

import { isVersionMetricMet } from './version-metric';
import type { VersionWithMetric } from './version-metric';

/** Don't re-nudge the same version's done-but-unmet state within this window. */
export const PROPOSE_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 h

export interface DoneUnmetVersionLike extends VersionWithMetric {
  /** Stable id for idempotency keys + cooldown stamps. */
  id: string;
  version: string;
  status?: string;
  /** Owner agent NAME (free text; matches teammate name). */
  owner?: string;
  /** Child roadmap items. `done` reflects ticket completion. */
  items?: Array<{ done?: boolean; taskId?: string }>;
  /** #1585 idempotency stamp: last time we nudged this done-but-unmet state. */
  lastProposeNudgeAt?: number | null;
}

/**
 * True iff the version is in the "done-but-unmet" state:
 *   - it is outcome-bound (has successCriteria),
 *   - it has at least one child item,
 *   - EVERY child item is done,
 *   - the metric is NOT met,
 *   - the loop is not paused (human kill-switch).
 *
 * Pure predicate — UI and the sweep both call it so they never disagree.
 */
export function isDoneButUnmet(v: DoneUnmetVersionLike | null | undefined): boolean {
  if (!v) return false;
  if (v.loopPaused === true) return false;
  const criteria = (v.successCriteria || '').toString().trim();
  if (!criteria) return false; // not outcome-bound → no hypothesis to chase
  const items = v.items || [];
  if (items.length === 0) return false; // nothing shipped yet → not "done"
  const allDone = items.every((i) => !!i.done);
  if (!allDone) return false;
  // The whole point: tickets done, number still short.
  return !isVersionMetricMet(v);
}

/** True if we already nudged this version's state within the cooldown. */
export function onProposeCooldown(v: DoneUnmetVersionLike, now: number): boolean {
  const last = v.lastProposeNudgeAt || 0;
  return last > 0 && now - last < PROPOSE_COOLDOWN_MS;
}

export type ProposeAction =
  | { kind: 'nudge-owner'; owner: string; version: DoneUnmetVersionLike }
  | { kind: 'skip'; why: 'not-done-but-unmet' | 'on-cooldown' | 'no-owner' };

/**
 * Classify a single version. Only `current`/`planned` versions are eligible
 * — a `shipped` version is closed, don't chase it. Pure; `now` injected.
 */
export function classifyProposeNext(v: DoneUnmetVersionLike, now: number): ProposeAction {
  if (v.status === 'shipped') return { kind: 'skip', why: 'not-done-but-unmet' };
  if (!isDoneButUnmet(v)) return { kind: 'skip', why: 'not-done-but-unmet' };
  const owner = (v.owner || '').trim();
  if (!owner) return { kind: 'skip', why: 'no-owner' };
  if (onProposeCooldown(v, now)) return { kind: 'skip', why: 'on-cooldown' };
  return { kind: 'nudge-owner', owner, version: v };
}

export interface ProposePlan {
  nudges: Array<{ owner: string; version: DoneUnmetVersionLike }>;
  skipped: Array<{ version: DoneUnmetVersionLike; why: string }>;
}

/** Plan the done-but-unmet sweep over all versions. Pure. */
export function planProposeSweep(versions: DoneUnmetVersionLike[], now: number): ProposePlan {
  const plan: ProposePlan = { nudges: [], skipped: [] };
  for (const v of versions) {
    const a = classifyProposeNext(v, now);
    if (a.kind === 'nudge-owner') plan.nudges.push({ owner: a.owner, version: a.version });
    else plan.skipped.push({ version: v, why: a.why });
  }
  return plan;
}

/**
 * The owner prompt: offer the unmet version as actionable work. It frames
 * the choice (propose a next experiment OR conclude the hypothesis didn't
 * pan out) — it never auto-spawns the experiment.
 */
export function buildProposeNextPrompt(v: DoneUnmetVersionLike): string {
  const cur = typeof v.metricCurrent === 'number' ? v.metricCurrent : '?';
  const tgt = typeof v.metricTarget === 'number' ? v.metricTarget : '?';
  const cmp = v.metricComparator === 'lte' ? '≤' : v.metricComparator === 'eq' ? '=' : '≥';
  return (
    `🧪 **Done-but-unmet (#1585).** Every ticket in \`${v.version}\` is shipped, but the metric still misses target ` +
    `(${cur} ${cmp} ${tgt} — goal: ${(v.successCriteria || '').toString().trim()}). The hypothesis didn't move the number yet. ` +
    `Your call as owner: **propose the next experiment** for this version (add a ticket and keep the loop going), or conclude ` +
    `the hypothesis and adjust the goal. I'm not spawning anything — this is yours to decide. (One nudge; I won't repeat until the state changes.)`
  );
}
