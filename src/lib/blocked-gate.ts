/**
 * #1588 — Blocked Gate.
 *
 * Org Studio agents over-use the `blocked` column: when they hit a fork,
 * have a PR to merge that they were told to merge themselves, or just want
 * a sanity-check, they park the ticket on the human. `blocked` ends up
 * overloaded — a few tickets are *legitimately* blocked, most are
 * *abdications* of ownership.
 *
 * This gate inverts the friction. Blocking now COSTS something (a typed
 * classification), and the abdication type is auto-bounced back to the
 * owner with the ownership mantra baked in — so the system pushes the
 * owner to own, instead of the human repeating the mantra by hand.
 *
 * Pure function: no I/O. The route applies the decision (reject / bounce /
 * allow) and owns the side effects (posting the bounce system comment).
 *
 * Design constraints (from the #1588 ticket):
 *   - Deterministic, no LLM.
 *   - blockedBy[] dependency blocks (#1102 case-a) pass through UNTOUCHED —
 *     a task waiting on other tickets is legitimately blocked.
 *   - Runtime-neutral (this is store-layer logic, not a runtime concern).
 */

export type BlockedReasonType =
  | 'irreversible-decision'
  | 'external-dependency'
  | 'needs-human-judgment'
  | 'awaiting-review';

export const BLOCK_TYPES: BlockedReasonType[] = [
  'irreversible-decision',
  'external-dependency',
  'needs-human-judgment',
  'awaiting-review',
];

/** Types that mean "a human genuinely must act" — these pass the gate. */
export const HUMAN_QUEUE_TYPES: BlockedReasonType[] = [
  'irreversible-decision',
  'external-dependency',
  'needs-human-judgment',
];

/** Types that are an ownership abdication — these get bounced back. */
export const ABDICATION_TYPES: BlockedReasonType[] = ['awaiting-review'];

export interface BlockedGateInput {
  /** The current task, read fresh from the store. */
  task: {
    id: string;
    ticketNumber?: number;
    status?: string;
    assignee?: string;
    blockedReason?: string;
    blockedReasonType?: string;
    blockedBy?: number[];
  };
  /** The incoming `updates` patch from the updateTask payload. */
  updates: {
    status?: string;
    blockedReason?: string;
    blockedReasonType?: string;
    blockedBy?: number[];
  };
}

export type BlockedGateDecision =
  | { kind: 'allow' }
  | { kind: 'reject'; status: number; error: string }
  | { kind: 'bounce'; status: number; error: string; mantra: string; owner: string };

/**
 * The ownership mantra posted as a system comment when an `awaiting-review`
 * block is bounced. Kept as a builder so the test asserts on stable text.
 */
export function buildBounceMantra(): string {
  return (
    `🚫 **Blocked-gate bounce (#1588).** This was flagged \`awaiting-review\` — an ownership call, not a true blocker. ` +
    `If it's reversible (\`git revert <sha>\` + redeploy undoes it), per your domain contract **you own this** — ` +
    `merge/decide and move it yourself. ` +
    `Re-block ONLY if it's genuinely irreversible (DDL drop, billing, irreversible side-effect) or waiting on an ` +
    `external party — and then use \`irreversible-decision\` or \`external-dependency\`, not \`awaiting-review\`.`
  );
}

/**
 * Evaluate the Blocked Gate for a status transition.
 *
 * Only meaningful when the transition is INTO `blocked` from a non-blocked
 * status; callers should only invoke it in that case (it also self-guards).
 */
export function evaluateBlockedGate(input: BlockedGateInput): BlockedGateDecision {
  const { task, updates } = input;

  // Self-guard: only gate a real transition INTO blocked.
  if (updates.status !== 'blocked' || task.status === 'blocked') {
    return { kind: 'allow' };
  }

  // #1102 case-a: a dependency block (blockedBy[]) is legitimate — the
  // auto-unblock handles it. Never gate or bounce these.
  const hasDependencyBlock =
    Array.isArray(updates.blockedBy) ? updates.blockedBy.length > 0
    : Array.isArray(task.blockedBy) ? task.blockedBy.length > 0
    : false;
  if (hasDependencyBlock) {
    return { kind: 'allow' };
  }

  // #1138: a non-empty blockedReason is required (incoming or already set).
  const incomingReason = typeof updates.blockedReason === 'string' ? updates.blockedReason.trim() : '';
  const existingReason = typeof task.blockedReason === 'string' ? task.blockedReason.trim() : '';
  if (!incomingReason && !existingReason) {
    return {
      kind: 'reject',
      status: 400,
      error:
        "Moving a task to status='blocked' requires a non-empty blockedReason. " +
        "Describe what's blocking it and what would unblock.",
    };
  }

  // #1588: a typed classification is required.
  const incomingType = typeof updates.blockedReasonType === 'string' ? updates.blockedReasonType.trim() : '';
  const existingType = typeof task.blockedReasonType === 'string' ? task.blockedReasonType.trim() : '';
  const blockType = incomingType || existingType;
  if (!blockType || !BLOCK_TYPES.includes(blockType as BlockedReasonType)) {
    return {
      kind: 'reject',
      status: 400,
      error:
        `Moving to status='blocked' requires blockedReasonType to be one of: ${BLOCK_TYPES.join(', ')}. ` +
        `Got: '${blockType || '(empty)'}'. Pick 'irreversible-decision' or 'external-dependency' only if a human ` +
        `genuinely must act; 'awaiting-review' for a PR/work you were told to handle yourself will be bounced back to you.`,
    };
  }

  // #1588: abdication types are bounced back to the owner.
  if (ABDICATION_TYPES.includes(blockType as BlockedReasonType)) {
    return {
      kind: 'bounce',
      status: 409,
      error:
        "Block refused (#1588): 'awaiting-review' is an ownership call, not a blocker. " +
        "If reversible, do it yourself; re-block only if irreversible/external (and use the right type). " +
        "A system comment with the rationale was posted.",
      mantra: buildBounceMantra(),
      owner: task.assignee || '',
    };
  }

  // Legitimate human-queue block — let it through.
  return { kind: 'allow' };
}
