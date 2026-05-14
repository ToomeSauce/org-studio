/**
 * Fuzzy match: "is this ticket already shipped?" (#1351 slice 2)
 * ==============================================================
 *
 * Given a ticket's title + description and the project's linked repos,
 * score the ticket against:
 *   (1) merged PRs from the last 90 days (via gh-pr-cache)
 *   (2) done Org Studio tasks from the last 90 days (in-memory snapshot)
 *
 * Return ranked candidate matches above a tuned threshold so the
 * create/update path can populate `task.possibly_already_shipped` and
 * the UI can render a banner.
 *
 * Algorithm (kept simple — KISS, no embeddings, no LLM):
 *   - Tokenize each side into a normalized lowercase term-frequency map,
 *     stripping markdown, stopwords, and ticket-number boilerplate
 *     ("#1234", "fix(#1234)", "feat(scope):" prefixes, etc.).
 *   - Score = Jaccard similarity over the high-signal token set,
 *     boosted by:
 *       + exact title-substring match (covers "exit Child Mode" ⊂
 *         "Fix #1312 require password to exit Child Mode")
 *       + shared ticket-number references in either body
 *       + recency (newer match scores slightly higher)
 *   - Hard cutoff at MIN_SCORE; cap at MAX_MATCHES per ticket.
 *
 * Why not embeddings? They'd be more accurate, but:
 *   - We're best-effort (constraint: never block create/update).
 *   - We'd need a vector store + an embedding-API call per ticket.
 *   - The #1349 case is satisfied by overlap + title-signal alone
 *     (verified — see `scripts/test-matcher-1349.ts`).
 *   - We can swap in embeddings later if precision drops.
 *
 * TODO (slice 6 / future): ticket-graph traversal. Trevor's closure of
 * #1349 cited PR #93 (a feature-flag cleanup) as deploy evidence even
 * though #93 doesn't share enough action-vocabulary with #1349 to score
 * above threshold by text alone. The principled fix is: if PR X
 * references ticket #N, and ticket #N references the source ticket,
 * propagate the match (with attenuated score). Requires walking the
 * comment/description graph; intentionally out of scope for slice 2 so
 * we ship a working matcher and add graph signal as a separate layer.
 */

import type { MergedPR } from './gh-pr-cache';

export interface MatchableTask {
  id: string;
  ticketNumber?: number;
  title: string;
  description?: string;
  doneWhen?: string;
  status: string;
  /** When the task was created/last updated, ms epoch */
  createdAt?: number;
  /** When the task entered done, ms epoch (preferred for recency scoring) */
  doneAt?: number;
}

export interface MatchCandidate {
  type: 'pr' | 'task';
  id: string;
  title: string;
  url?: string;
  /** ms epoch — PR mergedAt or task doneAt/createdAt */
  recency?: number;
  score: number; // 0..1
}

/**
 * Threshold below which a candidate is suppressed. Tuned against the
 * #1349 regression with a noise-control sweep over unrelated tickets:
 *   - 0.25 — too tight, misses related shipped work
 *   - 0.20 — the sweet spot. Catches all three #1349 PRs (canonical fix
 *     0.40, related BE 0.22, follow-up cleanup 0.21) and stays silent on
 *     billing / infra / generic onboarding tickets that share no
 *     project vocabulary. A single dim hit on a topical onboarding
 *     ticket is acceptable since the banner is advisory.
 *   - 0.15 — false positives leak in across the corpus.
 * Bumping this trades false positives for missed duplicates; bumping
 * down does the reverse. See `scripts/test-matcher-1349.ts` and
 * `scripts/noise-check.ts` for the calibration evidence.
 */
const MIN_SCORE = 0.20;

/**
 * Maximum candidates returned per ticket. Set to 8 because shipped
 * work on a feature area often spans many PRs (canonical fix +
 * hot-patches + cleanup PRs + related-area work); capping too low hides
 * legitimately-related shipped work. The banner UI (slice 3) can group
 * or collapse if 8 is too many to render at once.
 */
const MAX_MATCHES = 8;

/** Recency half-life in ms (90 days). Older matches lose score. */
const RECENCY_HALF_LIFE_MS = 90 * 24 * 60 * 60 * 1000;

/** Tokens shorter than this are dropped (after stopword filter) */
const MIN_TOKEN_LEN = 3;

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
  'has', 'have', 'he', 'in', 'is', 'it', 'its', 'of', 'on', 'or',
  'that', 'the', 'this', 'to', 'was', 'were', 'will', 'with', 'we',
  'i', 'you', 'they', 'our', 'their', 'them', 'us', 'me', 'my',
  'when', 'where', 'who', 'what', 'which', 'how', 'why', 'so', 'if',
  'but', 'not', 'no', 'yes', 'can', 'should', 'would', 'could', 'may',
  'do', 'does', 'did', 'done', 'doing', 'todo', 'fix', 'feat', 'feature',
  'chore', 'spike', 'bug', 'followup', 'follow', 'up', 'fixes', 'fixed',
  'add', 'added', 'adds', 'remove', 'removed', 'removes', 'update', 'updates',
  'updated', 'change', 'changed', 'changes', 'use', 'used', 'using', 'make',
  'made', 'makes', 'new', 'old', 'also', 'all', 'any', 'some', 'each', 'every',
  'into', 'onto', 'about', 'before', 'after', 'over', 'under', 'than', 'then',
  'now', 'just', 'only', 'see', 'note', 'task', 'ticket', 'pr', 'issue',
]);

/** Tokenize a string into a Set of high-signal terms. */
export function tokenize(input: string | null | undefined): Set<string> {
  if (!input) return new Set();
  let s = String(input).toLowerCase();
  // Strip markdown links: [text](url) → text
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Strip code fences
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/`[^`]*`/g, ' ');
  // Strip conventional-commit prefixes: "feat(scope):", "fix:", etc.
  s = s.replace(/^(feat|fix|chore|spike|bug|followup|refactor|docs|test|perf|ci|build|style|revert)(\([^)]*\))?\s*:\s*/i, '');
  // Strip "Fix #1234" / "fixes #1234" / "(#1234)" — keeps the number aside
  // for the ticket-number signal which is computed separately.
  s = s.replace(/[(\[]?#\d+[)\]]?/g, ' ');
  // Replace non-word chars with space
  s = s.replace(/[^a-z0-9_-]+/g, ' ');
  // Split SNAKE_CASE / kebab-case identifiers into subwords. Without this,
  // "NEXT_PUBLIC_THRIVOR_CHILD_MODE_V2_ENABLED" tokenizes as one giant
  // opaque term and hides the meaningful subwords (thrivor, child, mode).
  s = s.replace(/[_-]+/g, ' ');
  const out = new Set<string>();
  for (const raw of s.split(/\s+/)) {
    const tok = raw.trim();
    if (tok.length < MIN_TOKEN_LEN) continue;
    if (STOPWORDS.has(tok)) continue;
    if (/^\d+$/.test(tok)) continue; // bare numbers
    out.add(tok);
  }
  return out;
}

/** Extract ticket-number references ("#1234") from text — for cross-link signal. */
export function extractTicketRefs(input: string | null | undefined): Set<number> {
  if (!input) return new Set();
  const out = new Set<number>();
  for (const m of String(input).matchAll(/#(\d+)/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0 && n < 100000) out.add(n);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Overlap coefficient — intersection / min(|A|, |B|).
 *
 * We use this instead of (alongside) Jaccard because the question we're
 * actually asking is asymmetric: "is this short ticket already covered by
 * this much-larger shipped PR / done task?". With Jaccard, a small ticket
 * matched against a long PR body gets penalized by every PR-only term in
 * the union, hiding genuine matches. Overlap is the right measure for
 * containment-style similarity.
 */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const denom = Math.min(a.size, b.size);
  return denom === 0 ? 0 : inter / denom;
}

/**
 * Title-level signal. Token-overlap on the *titles only* (excluding
 * descriptions) is a strong indicator of duplication because titles are
 * already condensed summaries — they share vocabulary when the work is
 * the same. We use overlap (not Jaccard) for the same asymmetric reason
 * as the body-level scorer.
 */
function titleSignal(aTitle: string, bTitle: string): number {
  const a = tokenize(aTitle);
  const b = tokenize(bTitle);
  return overlap(a, b);
}

function recencyFactor(now: number, when: number | undefined): number {
  if (!when || !Number.isFinite(when)) return 0.6;
  const age = Math.max(0, now - when);
  // 1.0 at age=0, ~0.5 at half-life, asymptote ~0
  return Math.exp(-Math.LN2 * (age / RECENCY_HALF_LIFE_MS));
}

interface ScoreInput {
  sourceTitle: string;
  sourceText: string;
  sourceTokens: Set<string>;
  sourceTicketRefs: Set<number>;
  now: number;
}

function scorePR(src: ScoreInput, pr: MergedPR): number {
  const prText = `${pr.title}\n${pr.body || ''}`;
  const prTokens = tokenize(prText);
  // Body-level overlap (containment): "are the source's high-signal terms
  // present in this PR?"
  const body = overlap(src.sourceTokens, prTokens);
  // Title-level overlap: "do the titles share concept vocabulary?"
  const title = titleSignal(src.sourceTitle, pr.title);
  // Cross-ticket reference signal — strong indicator if either side
  // explicitly mentions the same parent ticket.
  const refs = extractTicketRefs(prText);
  let refSignal = 0;
  for (const r of src.sourceTicketRefs) if (refs.has(r)) { refSignal = 0.25; break; }
  const rec = recencyFactor(src.now, pr.mergedAt);
  // Weighted blend; recency only nudges, doesn't dominate.
  const base = 0.45 * body + 0.40 * title + refSignal;
  return Math.min(1, base * (0.7 + 0.3 * rec));
}

function scoreTask(src: ScoreInput, t: MatchableTask): number {
  const text = `${t.title}\n${t.description || ''}\n${t.doneWhen || ''}`;
  const tTokens = tokenize(text);
  const body = overlap(src.sourceTokens, tTokens);
  const title = titleSignal(src.sourceTitle, t.title);
  const refs = extractTicketRefs(text);
  let refSignal = 0;
  if (t.ticketNumber && src.sourceTicketRefs.has(t.ticketNumber)) refSignal = 0.25;
  for (const r of src.sourceTicketRefs) if (refs.has(r)) { refSignal = Math.max(refSignal, 0.2); }
  const rec = recencyFactor(src.now, t.doneAt || t.createdAt);
  const base = 0.45 * body + 0.40 * title + refSignal;
  return Math.min(1, base * (0.7 + 0.3 * rec));
}

export interface FindMatchesInput {
  /** The ticket being evaluated */
  sourceTitle: string;
  sourceDescription?: string;
  /** Optional — if the source already has a ticket number, exclude self-match */
  sourceTicketNumber?: number;
  /** Optional — exclude self when matching against tasks */
  sourceTaskId?: string;
  /** Merged PRs from the project's linked repos */
  prs: MergedPR[];
  /** Done Org Studio tasks (last 90d) to consider */
  doneTasks: MatchableTask[];
  /** Override clock for tests */
  now?: number;
  /** Override threshold for tests */
  minScore?: number;
}

export function findMatches(input: FindMatchesInput): MatchCandidate[] {
  const now = input.now ?? Date.now();
  const minScore = input.minScore ?? MIN_SCORE;
  const sourceTitle = input.sourceTitle || '';
  const sourceText = `${sourceTitle}\n${input.sourceDescription || ''}`;
  const src: ScoreInput = {
    sourceTitle,
    sourceText,
    sourceTokens: tokenize(sourceText),
    sourceTicketRefs: extractTicketRefs(sourceText),
    now,
  };
  if (src.sourceTokens.size < 2) return []; // too little signal

  const out: MatchCandidate[] = [];

  for (const pr of input.prs) {
    const score = scorePR(src, pr);
    if (score < minScore) continue;
    out.push({
      type: 'pr',
      id: pr.id,
      title: pr.title,
      url: pr.url,
      recency: pr.mergedAt,
      score,
    });
  }

  for (const t of input.doneTasks) {
    if (input.sourceTaskId && t.id === input.sourceTaskId) continue;
    if (input.sourceTicketNumber && t.ticketNumber === input.sourceTicketNumber) continue;
    const score = scoreTask(src, t);
    if (score < minScore) continue;
    out.push({
      type: 'task',
      id: t.ticketNumber ? `#${t.ticketNumber}` : t.id,
      title: t.title,
      recency: t.doneAt || t.createdAt,
      score,
    });
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, MAX_MATCHES);
}

export const _internal = {
  MIN_SCORE,
  MAX_MATCHES,
  RECENCY_HALF_LIFE_MS,
  scorePR,
  scoreTask,
};
