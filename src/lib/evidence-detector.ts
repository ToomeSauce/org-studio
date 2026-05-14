/**
 * #1351 slice 4 — Evidence detector for the P0/P1 done-move gate.
 *
 * Spec (from ticket doneWhen #3): "P0/P1 done moves without commit/PR/test/
 * duplicate ref trigger confirm dialog citing missing evidence; closure
 * still allowed, absence logged."
 *
 * Evidence categories detected on a task:
 *   - commit:    git SHA (7+ hex) anywhere in title/description/comments/
 *                reviewNotes. We intentionally accept short SHAs because
 *                that's how agents reference them in comments
 *                ("shipped on `b1c9382`"). Length 7..40 hex.
 *   - pr:        #NNN or a github.com/.../pull/NNN URL in the same text
 *                surfaces. We require at least one digit so that mentions
 *                of literal `#` in shell-snippets don't false-positive.
 *   - test:      task.testPlan populated with non-whitespace content.
 *   - duplicate: task.duplicate_of set (numeric > 0) — explicitly marking
 *                a ticket as a duplicate IS the evidence that the prior
 *                ticket carries the work.
 *
 * Returns the categories that have at least one match. An empty array
 * means the ticket has NO evidence and is a candidate for the soft gate.
 *
 * Best-effort by design. False positives (e.g. a #NNN that isn't actually
 * a PR number) are preferable to false negatives — the gate is soft, the
 * confirm dialog never blocks closure, and the goal is to nudge, not
 * police. Per the ticket constraint: "Evidence gate soft in v1 — no
 * auto-reject."
 */

import type { Task, TaskComment } from '@/lib/store';

export type EvidenceKind = 'commit' | 'pr' | 'test' | 'duplicate';

// 7..40-char hex string preceded by a non-hex/word boundary so we don't
// match the middle of a longer hex blob. Lowercase only — git SHAs are
// always lowercase. Anchored on either a word boundary or backtick to
// catch the common `c4f722d` markdown-formatted reference.
const COMMIT_SHA_REGEX = /(?:^|[^0-9a-f])[`']?([0-9a-f]{7,40})[`']?(?:[^0-9a-f]|$)/i;

// #NNN where NNN is 1+ digits, OR a full github PR URL.
const PR_REGEX = /(?:#\d+\b)|(?:github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+)/i;

function collectText(task: Task): string {
  const parts: string[] = [];
  parts.push(task.title || '');
  parts.push(task.description || '');
  parts.push(task.reviewNotes || '');
  parts.push(task.testPlan || '');
  for (const c of (task.comments || []) as TaskComment[]) {
    const text = (c as any)?.content ?? (c as any)?.body ?? (c as any)?.text ?? '';
    if (typeof text === 'string') parts.push(text);
  }
  return parts.join('\n');
}

export interface EvidenceReport {
  kinds: EvidenceKind[];
  hasEvidence: boolean;
  // Human-readable summary like "commit, PR, test plan" for the
  // confirm-dialog absence message. Empty when hasEvidence is true.
  missingLabel: string;
}

export function detectEvidence(task: Task): EvidenceReport {
  const kinds: EvidenceKind[] = [];
  const text = collectText(task);

  if (COMMIT_SHA_REGEX.test(text)) kinds.push('commit');
  if (PR_REGEX.test(text)) kinds.push('pr');
  if ((task.testPlan || '').trim().length > 0) kinds.push('test');
  if (typeof task.duplicate_of === 'number' && task.duplicate_of > 0) kinds.push('duplicate');

  const hasEvidence = kinds.length > 0;
  const missingLabel = hasEvidence ? '' : 'commit SHA, PR reference, test plan, or duplicate-of pointer';

  return { kinds, hasEvidence, missingLabel };
}

/**
 * Human-readable list of evidence categories found, for the audit comment
 * we post when the user closes WITHOUT evidence (so the absence is logged
 * per the ticket spec).
 */
export function formatEvidenceList(kinds: EvidenceKind[]): string {
  if (kinds.length === 0) return 'none';
  const labels: Record<EvidenceKind, string> = {
    commit: 'commit',
    pr: 'PR',
    test: 'test plan',
    duplicate: 'duplicate-of',
  };
  return kinds.map((k) => labels[k]).join(', ');
}
