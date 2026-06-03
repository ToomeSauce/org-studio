/**
 * #1593 — Precedent-aware enrichment for Steward nudges + experiment proposals.
 *
 * Read-enrichment ONLY (hard constraint): memory informs the nudge/proposal
 * text, never auto-acts, never changes classification. The #1589 Steward and
 * the #1585 done-but-unmet pass still decide WHAT to send and to WHOM; this
 * module only appends a "prior context" citation block so the loop learns
 * instead of re-deriving.
 *
 * It hits /api/memory/search (#1592) via an INJECTED fetcher so it stays
 * runtime-neutral and unit-testable with no network. The search results carry
 * citations + links, which we render verbatim so the owner can verify.
 */
import type { StewardReason, StewardTaskLike } from '../domain-steward';

/** One search hit, matching the /api/memory/search result shape (#1592). */
export interface MemoryHit {
  id: string;
  sourceType: string;
  score: number;
  text: string;
  citation?: {
    projectId?: string;
    taskId?: string;
    ticketNumber?: number;
    owner?: string;
    title?: string;
    link?: string;
  };
}

/** Injected search fn — the scheduler passes one backed by /api/memory/search. */
export type MemorySearchFn = (
  query: string,
  filters: { projectId?: string; owner?: string; sourceTypes?: string[] },
  limit: number,
) => Promise<MemoryHit[]>;

/** Don't cite the very ticket/version that triggered the nudge. */
function excludeSelf(hits: MemoryHit[], selfTaskId?: string): MemoryHit[] {
  if (!selfTaskId) return hits;
  return hits.filter((h) => h.citation?.taskId !== selfTaskId);
}

/** Below this cosine score, a "precedent" is too weak to be worth citing. */
export const MIN_PRECEDENT_SCORE = 0.12;

/**
 * The query for a Steward nudge depends on the reason:
 *   - abdication/blocked-too-long → look for prior abdication on the same
 *     owner ("is this owner repeatedly abdicating the same class?").
 *   - else → look for prior handling of this ticket's subject.
 */
export function stewardQuery(reason: StewardReason, ticket: StewardTaskLike): {
  query: string;
  filters: { owner?: string; sourceTypes?: string[] };
} {
  const subject = [ticket.title, (ticket as any).description].filter(Boolean).join(' ').slice(0, 200);
  if (reason === 'blocked-reversible-too-long') {
    return {
      query: `blocked awaiting-review abdication reversible ${subject}`,
      // Bias toward this owner's blocked-reason history → repeated-abdication signal.
      filters: { owner: (ticket as any).assignee || undefined, sourceTypes: ['blocked-reason', 'status-history'] },
    };
  }
  return { query: subject || 'ticket', filters: {} };
}

/**
 * Render a compact, verifiable "prior context" block. Returns '' when there's
 * nothing worth citing — callers append it directly so an empty result simply
 * adds nothing to the nudge.
 */
export function renderPrecedentBlock(hits: MemoryHit[], heading: string): string {
  const strong = hits.filter((h) => h.score >= MIN_PRECEDENT_SCORE).slice(0, 3);
  if (strong.length === 0) return '';
  const lines = strong.map((h) => {
    const c = h.citation || {};
    const ref = c.ticketNumber ? `#${c.ticketNumber}` : (c.title || h.sourceType);
    const link = c.link ? ` (${c.link})` : '';
    const snippet = h.text.replace(/\s+/g, ' ').slice(0, 120);
    return `  • ${ref}${link} — ${snippet}`;
  });
  return `\n\n🧠 **${heading}** (from org-memory; verify before relying):\n${lines.join('\n')}`;
}

/**
 * Enrich a Steward nudge. Best-effort: any search failure → return the base
 * nudge unchanged. NEVER throws.
 */
export async function enrichStewardNudge(
  baseNudge: string,
  reason: StewardReason,
  ticket: StewardTaskLike,
  search: MemorySearchFn,
): Promise<string> {
  try {
    const { query, filters } = stewardQuery(reason, ticket);
    const hits = excludeSelf(await search(query, filters, 5), ticket.id);
    const heading =
      reason === 'blocked-reversible-too-long'
        ? 'Has this owner faced this kind of call before?'
        : 'Prior context on this subject';
    return baseNudge + renderPrecedentBlock(hits, heading);
  } catch {
    return baseNudge;
  }
}

/**
 * Enrich a "propose next experiment" prompt with prior experiments on the same
 * outcome: what was tried, what moved the metric, what failed. Best-effort.
 */
export async function enrichProposePrompt(
  basePrompt: string,
  version: { version: string; successCriteria?: string; id?: string; projectId?: string },
  search: MemorySearchFn,
): Promise<string> {
  try {
    const query = `experiment ${version.successCriteria || ''} ${version.version}`.trim();
    const hits = await search(
      query,
      { projectId: version.projectId, sourceTypes: ['task-description', 'task-review-notes', 'change-history'] },
      5,
    );
    return basePrompt + renderPrecedentBlock(hits, 'Prior experiments toward this goal');
  } catch {
    return basePrompt;
  }
}
