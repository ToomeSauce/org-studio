/**
 * #1351 slice 5/5 — Backfill possibly_already_shipped on existing
 * backlog + in-progress tickets.
 *
 * Spec from doneWhen #5: "Backfill on first deploy: auto-link pass
 * against current backlog + in-progress, banner shown retroactively."
 *
 * Behavior
 * - Read the live store via /api/store (single round-trip).
 * - For every task with status in {backlog, in-progress} AND
 *   possibly_already_shipped not already populated (undefined OR empty
 *   array): call computeMatches() from the slice-2 hook and PATCH the
 *   task with the result via the existing /api/store updateTask path.
 * - Idempotent: tickets that already carry matches are skipped, so
 *   re-runs on a partially-completed run are safe.
 * - Throttled: 250ms sleep between tasks. GitHub PR fetches are
 *   already cached + de-duped per-repo inside gh-pr-cache, so the
 *   throttle is really about giving the dashboard's event loop room
 *   to breathe during a one-shot batch.
 * - CPU-bounded by the slice-2 matcher itself (token-overlap math is
 *   O(words²) per pair, fine at the current task scale).
 *
 * Usage
 *   npx tsx scripts/backfill-possibly-shipped.ts
 *   npx tsx scripts/backfill-possibly-shipped.ts --dry-run
 *   npx tsx scripts/backfill-possibly-shipped.ts --limit=20
 *
 * Notes
 * - Designed to be run once on first deploy of the #1351 feature, OR
 *   re-run safely later (only fills the gaps).
 * - Reads ORG_STUDIO_API_KEY from process.env or .env.local.
 * - Never throws on a single-task failure; counts and continues so a
 *   single bad ticket doesn't abort the whole pass.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeMatches } from '../src/lib/possibly-shipped-hook';
import type { Task, Project } from '../src/lib/store';

const BASE = process.env.ORG_STUDIO_URL || 'http://localhost:4501';
const SLEEP_MS = 250;

function loadApiKey(): string {
  if (process.env.ORG_STUDIO_API_KEY) return process.env.ORG_STUDIO_API_KEY;
  try {
    const env = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
    const m = env.match(/^ORG_STUDIO_API_KEY=(.+)$/m);
    if (m) return m[1].trim();
  } catch {}
  throw new Error('ORG_STUDIO_API_KEY not found in env or .env.local');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(argv: string[]): { dryRun: boolean; limit: number | null } {
  let dryRun = false;
  let limit: number | null = null;
  for (const a of argv) {
    if (a === '--dry-run') dryRun = true;
    else if (a.startsWith('--limit=')) {
      const n = Number(a.split('=')[1]);
      if (!Number.isNaN(n) && n > 0) limit = n;
    }
  }
  return { dryRun, limit };
}

async function main() {
  const { dryRun, limit } = parseArgs(process.argv.slice(2));
  const apiKey = loadApiKey();

  console.log(`[backfill] base=${BASE} dryRun=${dryRun} limit=${limit ?? 'none'}`);

  const store = await (await fetch(`${BASE}/api/store`)).json();
  const allTasks: Task[] = store.tasks || [];
  const projects: Project[] = store.projects || [];
  const projectById = new Map(projects.map((p) => [p.id, p]));

  // Eligibility: backlog or in-progress, not already filled.
  const eligible = allTasks.filter(
    (t) =>
      !(t as any).isArchived &&
      (t.status === 'backlog' || t.status === 'in-progress') &&
      (!t.possibly_already_shipped || t.possibly_already_shipped.length === 0),
  );

  const targets = limit ? eligible.slice(0, limit) : eligible;
  console.log(
    `[backfill] eligible tickets: ${eligible.length} (${targets.length} to be processed)`,
  );

  let filled = 0;
  let empty = 0;
  let errors = 0;

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const proj = projectById.get(t.projectId);
    try {
      const result = await computeMatches({
        task: t,
        project: proj,
        allTasks,
      });
      const matches = result.matches || [];
      const tag = `#${t.ticketNumber ?? '?'}`.padEnd(7);
      const projName = proj?.name?.slice(0, 18).padEnd(18) ?? '—'.padEnd(18);

      if (matches.length === 0) {
        empty++;
        console.log(
          `  [${i + 1}/${targets.length}] ${tag} ${projName} — no matches (repos=${result.meta.repos.length}, prs=${result.meta.prCount})`,
        );
      } else {
        filled++;
        console.log(
          `  [${i + 1}/${targets.length}] ${tag} ${projName} — ${matches.length} match${matches.length === 1 ? '' : 'es'}, top=${(matches[0].score * 100).toFixed(0)}%`,
        );

        if (!dryRun) {
          // Use the same update path the live hook uses. We only PATCH
          // possibly_already_shipped — every other field on the ticket
          // is left untouched.
          const res = await fetch(`${BASE}/api/store`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              action: 'updateTask',
              id: t.id,
              updates: { possibly_already_shipped: matches },
            }),
          });
          if (!res.ok) {
            errors++;
            console.log(
              `      ⚠️ update failed: HTTP ${res.status} — ${(await res.text()).slice(0, 80)}`,
            );
          }
        }
      }
    } catch (e: any) {
      errors++;
      console.log(
        `  [${i + 1}/${targets.length}] #${t.ticketNumber ?? '?'} — error: ${e?.message || e}`,
      );
    }
    if (i < targets.length - 1) await sleep(SLEEP_MS);
  }

  console.log('');
  console.log(`[backfill] done. filled=${filled} empty=${empty} errors=${errors}`);
  if (dryRun) console.log('[backfill] DRY RUN — no writes were made.');
}

main().catch((e) => {
  console.error('[backfill] fatal:', e);
  process.exit(1);
});
