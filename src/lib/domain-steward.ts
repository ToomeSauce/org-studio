/**
 * #1589 — Domain Steward: pure decision logic for the active-stewardship
 * sweep.
 *
 * A scheduled SYSTEM sweep (not a teammate agent) that finds tickets stuck
 * on a *reversible* reason and nudges the OWNING agent to own them, and
 * batches genuine *irreversible* gates into a single human-facing summary
 * per sweep. It pushes the owner to own — it does NOT do the owner's work
 * and does NOT manage another agent's domain.
 *
 * Built on top of #1588 (Blocked Gate): the typed `blockedReasonType` is
 * what lets this sweep tell "you're abdicating, own it" (reversible →
 * nudge the owner) from "a human genuinely must act" (irreversible →
 * escalate to human, once). We reuse HUMAN_QUEUE_TYPES / ABDICATION_TYPES
 * rather than re-deriving the taxonomy here.
 *
 * This module mirrors src/lib/claim-contract.ts (#1352): intentionally
 * PURE — no Date.now(), no provider calls, no logging, no RPC. Everything
 * that varies between calls comes in as a parameter. The scheduler route
 * owns all IO (provider reads/writes, addComment, sendToAgent, chat.send).
 *
 * Constraints honored (from the ticket):
 *   - System role, NOT a new teammate agent.
 *   - Nudge the OWNER, never manage their domain.
 *   - Human escalation ONLY for irreversible gates, summarized once.
 *   - Idempotent — no duplicate nudges within a window.
 *   - Precedent-aware pushback is explicitly DEFERRED to Org Brain (2026.08);
 *     this sweep is deterministic.
 */

import { HUMAN_QUEUE_TYPES, ABDICATION_TYPES } from './blocked-gate';
import type { BlockedReasonType } from './blocked-gate';

// ---- Timing constants ----
// A ticket must be stuck at least this long before the steward says anything.
// Deliberately generous: the steward is a backstop, not a micromanager.
export const BLOCKED_STALE_MS = 24 * 60 * 60 * 1000; // 24 h blocked on a reversible reason
export const IN_PROGRESS_STALL_MS = 8 * 60 * 60 * 1000; // 8 h in-progress with no activity
// Don't re-nudge the same owner about the same ticket within this window.
// Idempotency guard — the sweep can run hourly; nudges shouldn't.
export const NUDGE_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 h

// ---- Shapes ----
// Loosely typed to stay decoupled from store.ts (Task has ~40 unrelated
// fields). The scheduler builds minimal fixtures from the real rows.
export interface StewardTaskLike {
  id: string;
  ticketNumber?: number;
  title?: string;
  status?: string;
  assignee?: string;
  blockedReasonType?: string;
  blockedReason?: string;
  /** Dependency blocks (#1102 case-a): ticket numbers this is waiting on. */
  blockedBy?: number[];
  /** When the ticket entered its current status. */
  statusChangedAt?: number;
  /** Last time the owner touched anything on this ticket. */
  lastActivityAt?: number;
  /** #1589 idempotency stamp: last time the steward nudged about this ticket. */
  lastStewardNudgeAt?: number | null;
}

// ---- 1. Candidate classification ----

export type StewardAction =
  /** Reversible stall: push the OWNER to own it (sendToAgent). */
  | { kind: 'nudge-owner'; owner: string; reason: StewardReason; ticket: StewardTaskLike }
  /** Irreversible gate: collect for the once-per-sweep human summary. */
  | { kind: 'escalate-human'; reason: StewardReason; ticket: StewardTaskLike }
  /** Nothing to do (not stale, on cooldown, dependency unresolved, etc.). */
  | { kind: 'skip'; why: SkipReason };

export type StewardReason =
  | 'blocked-reversible-too-long'   // awaiting-review style abdication left to rot
  | 'blocked-dependency-resolved'   // blockedBy[] deps all done, but still blocked
  | 'in-progress-stalled'           // claimed, no activity past horizon
  | 'blocked-irreversible';         // genuine human gate

export type SkipReason =
  | 'not-stale'
  | 'on-cooldown'
  | 'no-owner'
  | 'dependency-unresolved'
  | 'not-a-candidate-status';

/**
 * Returns true if every ticket number in `blockedBy` is in `doneTicketNumbers`.
 * An empty/absent blockedBy is treated as "no outstanding deps" → true.
 */
export function dependenciesResolved(
  blockedBy: number[] | undefined,
  doneTicketNumbers: ReadonlySet<number>,
): boolean {
  if (!blockedBy || blockedBy.length === 0) return true;
  return blockedBy.every((n) => doneTicketNumbers.has(n));
}

/** True if the steward already nudged about this ticket within the cooldown. */
export function onNudgeCooldown(task: StewardTaskLike, now: number): boolean {
  const last = task.lastStewardNudgeAt || 0;
  return last > 0 && now - last < NUDGE_COOLDOWN_MS;
}

/**
 * Classify a single ticket into a steward action.
 *
 * `doneTicketNumbers` lets us detect a ticket still sitting in `blocked`
 * whose `blockedBy[]` dependencies have all shipped — a reversible state
 * the owner should clear.
 *
 * Pure: no clock, no IO. `now` is injected.
 */
export function classifyForSteward(
  task: StewardTaskLike,
  doneTicketNumbers: ReadonlySet<number>,
  now: number,
): StewardAction {
  const owner = (task.assignee || '').trim();

  if (task.status === 'blocked') {
    const type = (task.blockedReasonType || '').trim() as BlockedReasonType;

    // (a) Dependency block (#1102 case-a) whose deps have ALL shipped.
    //     The ticket is no longer truly blocked — nudge the owner to move it.
    //     This takes precedence over the typed-reason check: a resolved
    //     dependency is reversible regardless of the recorded reason.
    if (task.blockedBy && task.blockedBy.length > 0) {
      if (!dependenciesResolved(task.blockedBy, doneTicketNumbers)) {
        return { kind: 'skip', why: 'dependency-unresolved' };
      }
      // deps resolved → reversible nudge (no staleness threshold needed:
      // the moment the blocker ships, the owner should unblock).
      if (!owner) return { kind: 'skip', why: 'no-owner' };
      if (onNudgeCooldown(task, now)) return { kind: 'skip', why: 'on-cooldown' };
      return { kind: 'nudge-owner', owner, reason: 'blocked-dependency-resolved', ticket: task };
    }

    // (b) Genuine human gate — collect for the once-per-sweep summary.
    //     No owner nudge: the owner can't unblock these; a human must.
    if (HUMAN_QUEUE_TYPES.includes(type)) {
      if (!isStale(task.statusChangedAt, now, BLOCKED_STALE_MS)) {
        return { kind: 'skip', why: 'not-stale' };
      }
      return { kind: 'escalate-human', reason: 'blocked-irreversible', ticket: task };
    }

    // (c) Abdication left to rot (`awaiting-review` or unknown/empty type).
    //     Reversible by definition (#1588) — push the owner to own it.
    if (ABDICATION_TYPES.includes(type) || !type) {
      if (!isStale(task.statusChangedAt, now, BLOCKED_STALE_MS)) {
        return { kind: 'skip', why: 'not-stale' };
      }
      if (!owner) return { kind: 'skip', why: 'no-owner' };
      if (onNudgeCooldown(task, now)) return { kind: 'skip', why: 'on-cooldown' };
      return { kind: 'nudge-owner', owner, reason: 'blocked-reversible-too-long', ticket: task };
    }

    return { kind: 'skip', why: 'not-a-candidate-status' };
  }

  if (task.status === 'in-progress') {
    // Stalled claim: no activity past the horizon. This nudges the owner
    // to own it BEFORE the lease-sweep (#1352) auto-bounces it — a softer,
    // ownership-framed touch, not a bounce. We use lastActivityAt (not the
    // lease stamp) so an actively-working agent is never nudged.
    const lastTouch = task.lastActivityAt || task.statusChangedAt || 0;
    if (!isStale(lastTouch, now, IN_PROGRESS_STALL_MS)) {
      return { kind: 'skip', why: 'not-stale' };
    }
    if (!owner) return { kind: 'skip', why: 'no-owner' };
    if (onNudgeCooldown(task, now)) return { kind: 'skip', why: 'on-cooldown' };
    return { kind: 'nudge-owner', owner, reason: 'in-progress-stalled', ticket: task };
  }

  return { kind: 'skip', why: 'not-a-candidate-status' };
}

/** True if `since` is set and older than `thresholdMs` relative to `now`. */
export function isStale(since: number | undefined | null, now: number, thresholdMs: number): boolean {
  if (!since) return false; // unknown timestamp → don't nudge (no false positives)
  return now - since >= thresholdMs;
}

// ---- 2. Sweep planning ----

export interface StewardPlan {
  /** Owner nudges to dispatch via sendToAgent(). One per ticket. */
  nudges: Array<{ owner: string; reason: StewardReason; ticket: StewardTaskLike }>;
  /** Irreversible gates to fold into ONE human summary this sweep. */
  humanEscalations: Array<{ reason: StewardReason; ticket: StewardTaskLike }>;
  /** Skips, for observability/logging only. */
  skipped: Array<{ ticket: StewardTaskLike; why: SkipReason }>;
}

/**
 * Run classifyForSteward over the whole task list and bucket the results.
 * Pure planner — the caller performs the IO (sendToAgent per nudge, ONE
 * chat.send for the human summary, stamp lastStewardNudgeAt on nudged
 * tickets).
 */
export function planStewardSweep(
  tasks: StewardTaskLike[],
  now: number,
): StewardPlan {
  const doneTicketNumbers = new Set<number>();
  for (const t of tasks) {
    if (t.status === 'done' && typeof t.ticketNumber === 'number') {
      doneTicketNumbers.add(t.ticketNumber);
    }
  }

  const plan: StewardPlan = { nudges: [], humanEscalations: [], skipped: [] };
  for (const t of tasks) {
    const action = classifyForSteward(t, doneTicketNumbers, now);
    if (action.kind === 'nudge-owner') {
      plan.nudges.push({ owner: action.owner, reason: action.reason, ticket: action.ticket });
    } else if (action.kind === 'escalate-human') {
      plan.humanEscalations.push({ reason: action.reason, ticket: action.ticket });
    } else {
      plan.skipped.push({ ticket: t, why: action.why });
    }
  }
  return plan;
}

// ---- 3. Message construction ----

function tref(t: StewardTaskLike): string {
  const num = typeof t.ticketNumber === 'number' ? `#${t.ticketNumber}` : t.id;
  return t.title ? `${num} — ${t.title}` : num;
}

/**
 * The ownership-framed prompt sent to the OWNER via sendToAgent().
 * It pushes them to own; it never tells them how to do the work.
 */
export function buildOwnerNudge(reason: StewardReason, ticket: StewardTaskLike): string {
  const ref = tref(ticket);
  switch (reason) {
    case 'blocked-reversible-too-long':
      return (
        `🧭 **Domain Steward (#1589).** Your ticket ${ref} has sat in \`blocked\` for over a day on a reversible reason ` +
        `(\`awaiting-review\`/untyped). That's an ownership call, not a true blocker — if \`git revert\` + redeploy undoes any ` +
        `mistake, **you own this**: unblock it and ship to \`done\`, or re-block with a genuine \`irreversible-decision\` / ` +
        `\`external-dependency\` reason. I'm not doing the work for you and I'm not escalating to a human — this is yours to move.`
      );
    case 'blocked-dependency-resolved':
      return (
        `🧭 **Domain Steward (#1589).** ${ref} is still \`blocked\`, but every ticket it was waiting on has shipped. ` +
        `The dependency is cleared — unblock it and pick it back up. It's yours.`
      );
    case 'in-progress-stalled':
      return (
        `🧭 **Domain Steward (#1589).** ${ref} has been \`in-progress\` with no activity for a while. If you're still on it, ` +
        `a quick status comment keeps the lease alive. If you've hit a real blocker, move it to \`blocked\` with a typed ` +
        `reason. If it's stalled because it's actually done, ship it. Either way — own the next move before the lease sweep bounces it.`
      );
    default:
      return `🧭 **Domain Steward (#1589).** ${ref} needs your attention — own the next move.`;
  }
}

/**
 * The SINGLE human-facing summary for irreversible gates this sweep.
 * Returns null when there's nothing genuinely human-gated — no chatter.
 * This is the "summarize once, not per-event" requirement.
 */
export function buildHumanSummary(
  escalations: Array<{ reason: StewardReason; ticket: StewardTaskLike }>,
): string | null {
  if (escalations.length === 0) return null;
  const lines = escalations.map((e) => {
    const t = e.ticket;
    const type = (t.blockedReasonType || 'unknown').trim();
    return `• ${tref(t)} — \`${type}\`${t.assignee ? ` (owner: ${t.assignee})` : ''}`;
  });
  const n = escalations.length;
  return (
    `🧭 **Domain Steward — ${n} ticket${n === 1 ? '' : 's'} genuinely need${n === 1 ? 's' : ''} a human.**\n` +
    `These are blocked on irreversible / external gates an agent can't clear on its own:\n\n` +
    lines.join('\n') +
    `\n\n_(One summary per sweep — I won't re-ping until something changes.)_`
  );
}
