/**
 * Leash block renderer (#1654, Phase A-3 of the Idea → Fruition pipeline).
 *
 * ONE pure function that renders a project's autonomy leash — budget +
 * boundaries — as a compact markdown block (≤15 lines). Consumed by:
 *   1. server.mjs generateOrgMd (per-project, agent workspace ORG.md)
 *   2. src/lib/org-generator.ts generateOrgMd (org-context API variant)
 *   3. src/lib/scheduler.ts buildDispatchMessage (dispatch prompt, owning
 *      project of the dispatched ticket only)
 *
 * Runtime-neutral by construction: it's text on the same ORG.md/dispatch
 * paths both OpenClaw and Hermes agents already read. No enforcement here —
 * rule 6 (#1653) owns enforcement; this is legibility.
 *
 * Returns '' when the project defines neither budget nor boundaries, so
 * unconfigured projects render nothing extra.
 */

export interface LeashProjectLike {
  id: string;
  name?: string;
  budget?: {
    ceilingUsdMonth?: number;
    ceilingUsdVersion?: number;
    alertPct?: number;
  };
  boundaries?: {
    freeToDecide?: string[];
    mustAsk?: string[];
  };
}

/** Optional live spend info (from budget-spend.ts); omit for static render. */
export interface LeashSpendInfo {
  /** Month-to-date metered USD for this project. */
  spendUsd?: number;
}

function paceProjection(spendUsd: number, now: Date): number {
  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getDate();
  if (dayOfMonth <= 0) return spendUsd;
  return (spendUsd / dayOfMonth) * daysInMonth;
}

/**
 * Render the leash block. Compact by design — hard-capped at 15 lines
 * (boundaries lists render at most 3 entries each with a "+N more" tail).
 */
export function renderLeashBlock(
  project: LeashProjectLike | null | undefined,
  spend?: LeashSpendInfo | null,
  now: Date = new Date(),
): string {
  if (!project) return '';
  const hasBudget =
    typeof project.budget?.ceilingUsdMonth === 'number' && project.budget.ceilingUsdMonth > 0;
  const free = (project.boundaries?.freeToDecide || []).filter(Boolean);
  const ask = (project.boundaries?.mustAsk || []).filter(Boolean);
  const hasBoundaries = free.length > 0 || ask.length > 0;
  if (!hasBudget && !hasBoundaries) return '';

  const lines: string[] = [];
  lines.push(`**Autonomy leash — ${project.name || project.id}:**`);

  if (hasBudget) {
    const ceiling = project.budget!.ceilingUsdMonth!;
    if (typeof spend?.spendUsd === 'number' && Number.isFinite(spend.spendUsd)) {
      const s = spend.spendUsd;
      const pct = Math.round((s / ceiling) * 100);
      const projected = paceProjection(s, now);
      lines.push(
        `- Budget: $${s.toFixed(2)} of $${ceiling.toFixed(2)}/mo metered (${pct}%, pace ~$${projected.toFixed(0)}). At ceiling, dispatch holds.`,
      );
    } else {
      lines.push(`- Budget: $${ceiling.toFixed(2)}/mo metered ceiling. At ceiling, dispatch holds.`);
    }
  }

  const renderList = (items: string[]): string => {
    const shown = items.slice(0, 3);
    const tail = items.length > 3 ? ` (+${items.length - 3} more)` : '';
    return shown.join('; ') + tail;
  };

  if (free.length > 0) {
    lines.push(`- Free to decide (no permission needed): ${renderList(free)}`);
  }
  if (ask.length > 0) {
    lines.push(`- Must ask BEFORE acting: ${renderList(ask)}`);
  }
  lines.push(
    '- Doctrine: reversible decisions are yours by default; escalate only what is genuinely irreversible or listed above.',
  );

  return lines.join('\n');
}
