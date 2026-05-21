/**
 * #1492 — Stop-window detection for the lease guard.
 *
 * Background: the stale-claim sweep (`sweepExpiredLeases` /
 * `escalateInactiveClaim` in `src/app/api/scheduler/route.ts`) used to
 * tick strikes against any in-progress task whose lease had expired,
 * regardless of why activity had stopped. This punished agents who were
 * correctly yielded per a human STOP directive — exactly the scenario
 * that played out on #1487 on 2026-05-21, where two Level 1/2 strikes
 * fired while Thelma was holding per Billy's 🚨 STOP comment.
 *
 * This module decides, given a task's comment thread and the team's
 * teammate roster, whether the task is currently "held by a human STOP"
 * and therefore should be skipped by the sweep.
 *
 * Detection rules:
 *   1. Explicit `comment.type === 'stop'` from an authority author = held.
 *      Cleared by either: (a) a later `comment.type === 'resume'` from an
 *      authority author, OR (b) any later comment authored by the task's
 *      current assignee (signals they've acknowledged + are unyielding).
 *   2. Regex fallback for legacy STOP comments (back-compat): a comment
 *      from an authority author whose content contains `\bSTOP\b` AND a
 *      yield/hold/do-not verb in the same comment. Same clearing rules.
 *
 * Authority authors:
 *   - Any teammate with empty `agentId` (humans like Basil).
 *   - Any teammate with `role === 'qa'` (QA agents like Billy).
 *   - Authors not in the teammate roster are treated as non-authority
 *     (cannot issue STOPs). Conservative default.
 *
 * Why "non-authority cannot STOP": prevents a misbehaving peer agent
 * from disabling the lease guard on another agent's task by posting a
 * STOP-looking comment. STOPs are a coordination signal from humans /
 * QA, not a generic primitive.
 *
 * Best-effort: this module never throws. On any error it returns
 * `{ held: false }` so the lease guard fails open (i.e. continues
 * its normal escalation). A false negative (STOP missed) is recoverable
 * — Basil/QA can manually clear the strike. A false positive (STOP
 * detected wrongly, sweep silently skipped) would let real stale claims
 * sit forever. Optimize for the recoverable error.
 */

export interface StopComment {
  id?: string;
  author?: string;
  content?: string;
  createdAt?: number;
  type?: string;
}

export interface StopTeammate {
  name?: string;
  agentId?: string;
  role?: string | null;
}

export interface StopTask {
  id?: string;
  assignee?: string;
}

export interface StopWindowResult {
  held: boolean;
  reason?: string;
  stopCommentId?: string;
  stopAuthor?: string;
  stopAt?: number;
}

// Regex fallback: STOP word + at least one yield/hold/do-not verb.
// Narrow on purpose — we want false negatives (missed STOPs) over false
// positives (silent guard disable).
const STOP_WORD = /\bSTOP\b/i;
const YIELD_VERB = /\b(yield|hold|do\s*not|don'?t|stand\s+down|stay\s+yielded|wait)\b/i;

function isAuthorityAuthor(authorName: string | undefined, teammates: StopTeammate[]): boolean {
  if (!authorName) return false;
  const lower = authorName.toLowerCase();
  for (const t of teammates) {
    if ((t.name || '').toLowerCase() === lower) {
      // Human (empty agentId) OR QA-role agent
      if (!t.agentId || t.agentId === '') return true;
      if ((t.role || '').toLowerCase() === 'qa') return true;
      return false;
    }
  }
  // Author not in roster = non-authority (conservative default).
  return false;
}

function isAssigneeComment(authorName: string | undefined, assignee: string | undefined): boolean {
  if (!authorName || !assignee) return false;
  return authorName.toLowerCase() === assignee.toLowerCase();
}

function isExplicitStop(c: StopComment): boolean {
  return c.type === 'stop';
}

function isExplicitResume(c: StopComment): boolean {
  return c.type === 'resume';
}

function isRegexStop(c: StopComment): boolean {
  const content = c.content || '';
  return STOP_WORD.test(content) && YIELD_VERB.test(content);
}

/**
 * Given a task and its comment thread (chronological ASC by createdAt),
 * return whether the task is currently held by a human STOP directive.
 *
 * Walks the comments in order. Tracks the latest STOP state. A STOP from
 * an authority author flips state to held. A resume from an authority
 * author, OR any comment from the current assignee, clears the held state.
 * Returns the final state after the walk.
 */
export function isTaskHeldByHumanStop(
  task: StopTask,
  comments: StopComment[],
  teammates: StopTeammate[],
): StopWindowResult {
  try {
    if (!Array.isArray(comments) || comments.length === 0) return { held: false };

    // Defensive sort — caller usually passes ASC but don't trust it.
    const sorted = [...comments].sort(
      (a, b) => (a.createdAt || 0) - (b.createdAt || 0),
    );

    let held = false;
    let stopCommentId: string | undefined;
    let stopAuthor: string | undefined;
    let stopAt: number | undefined;
    let stopMatchReason: string | undefined;

    for (const c of sorted) {
      const authority = isAuthorityAuthor(c.author, teammates);
      const fromAssignee = isAssigneeComment(c.author, task.assignee);

      // Clearing paths (checked first — a comment can both clear and re-stop,
      // but clearing takes precedence on the same comment which would be a
      // weird edge case; explicit resume wins).
      if (held) {
        if (authority && isExplicitResume(c)) {
          held = false;
          stopCommentId = undefined;
          stopAuthor = undefined;
          stopAt = undefined;
          stopMatchReason = undefined;
          continue;
        }
        if (fromAssignee) {
          // Assignee acknowledged — unyielding themselves.
          held = false;
          stopCommentId = undefined;
          stopAuthor = undefined;
          stopAt = undefined;
          stopMatchReason = undefined;
          // Don't `continue` — the same comment could ALSO be an authority
          // STOP if the assignee somehow has authority, but that'd be an
          // edge case. We'll fall through to setting state below.
        }
      }

      // Setting paths
      if (authority) {
        if (isExplicitStop(c)) {
          held = true;
          stopCommentId = c.id;
          stopAuthor = c.author;
          stopAt = c.createdAt;
          stopMatchReason = 'explicit';
        } else if (isRegexStop(c)) {
          held = true;
          stopCommentId = c.id;
          stopAuthor = c.author;
          stopAt = c.createdAt;
          stopMatchReason = 'regex';
        }
      }
    }

    if (held) {
      return {
        held: true,
        reason: stopMatchReason,
        stopCommentId,
        stopAuthor,
        stopAt,
      };
    }
    return { held: false };
  } catch {
    // Fail open: on any error, don't claim held. See module-level comment.
    return { held: false };
  }
}
