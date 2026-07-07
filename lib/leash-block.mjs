/**
 * Leash block renderer — server.mjs variant (#1654, Phase A-3).
 *
 * Mirror of src/lib/leash-block.ts renderLeashBlock() for the plain-node
 * server process (same pattern as lib/runtimes.mjs mirroring
 * src/lib/runtimes/*.ts). Keep the two in sync — the TS file is canonical.
 *
 * server.mjs renders the STATIC leash (ceiling + boundaries, no live spend):
 * ORG.md regenerates on store changes, so a live spend figure would go stale
 * the moment it was written. Live spend + pace renders in the dispatch
 * prompt (src/lib/scheduler.ts), which is built fresh per dispatch.
 */

export function renderLeashBlock(project) {
  if (!project) return '';
  const ceiling = project?.budget?.ceilingUsdMonth;
  const hasBudget = typeof ceiling === 'number' && Number.isFinite(ceiling) && ceiling > 0;
  const free = (project?.boundaries?.freeToDecide || []).filter(Boolean);
  const ask = (project?.boundaries?.mustAsk || []).filter(Boolean);
  const hasBoundaries = free.length > 0 || ask.length > 0;
  if (!hasBudget && !hasBoundaries) return '';

  const renderList = (items) => {
    const shown = items.slice(0, 3);
    const tail = items.length > 3 ? ` (+${items.length - 3} more)` : '';
    return shown.join('; ') + tail;
  };

  const lines = [];
  lines.push(`**Autonomy leash — ${project.name || project.id}:**`);
  if (hasBudget) {
    lines.push(`- Budget: $${ceiling.toFixed(2)}/mo metered ceiling. At ceiling, dispatch holds.`);
  }
  if (free.length > 0) lines.push(`- Free to decide (no permission needed): ${renderList(free)}`);
  if (ask.length > 0) lines.push(`- Must ask BEFORE acting: ${renderList(ask)}`);
  lines.push('- Doctrine: reversible decisions are yours by default; escalate only what is genuinely irreversible or listed above.');
  return lines.join('\n');
}
