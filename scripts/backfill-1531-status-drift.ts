#!/usr/bin/env tsx
/**
 * #1531 — backfill drifted rows where typed `status` ≠ `statusHistory.tail.status`.
 *
 * Strategy:
 *   Typed `status` is the truth (scheduler dispatcher + UI column placement
 *   both read from it). statusHistory drove the discovery but was the lying
 *   surface. We append a reconciliation entry so the tail matches typed.
 *
 * Each appended entry is stamped { by: 'system-backfill-#1531', model: null,
 * timestamp: now } so it's distinguishable from agent-driven transitions
 * forever.
 *
 * Dry-run by default. Pass --apply to write.
 *
 * Usage:
 *   tsx scripts/backfill-1531-status-drift.ts          # dry-run
 *   tsx scripts/backfill-1531-status-drift.ts --apply  # write
 */

import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

function loadDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = path.join(__dirname, '..', '.env.local');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const m = line.match(/^DATABASE_URL=(.*)$/);
      if (m) return m[1].replace(/^["']|["']$/g, '');
    }
  }
  throw new Error('DATABASE_URL not set and not found in .env.local');
}

async function main() {
  const apply = process.argv.includes('--apply');
  const dbUrl = loadDatabaseUrl();
  const pool = new Pool({ connectionString: dbUrl });

  const drifted = await pool.query<{
    id: string;
    ticket_number: number | null;
    status: string;
    last_hist_status: string;
  }>(`
    SELECT id,
           ticket_number,
           status,
           status_history->-1->>'status' AS last_hist_status
    FROM org_studio_tasks
    WHERE jsonb_array_length(COALESCE(status_history, '[]'::jsonb)) > 0
      AND status IS NOT NULL
      AND status != (status_history->-1->>'status')
    ORDER BY ticket_number NULLS LAST
  `);

  console.log(`[backfill-1531] ${drifted.rows.length} drifted row(s) found`);
  for (const row of drifted.rows) {
    console.log(`  #${row.ticket_number ?? '?'} ${row.id} | typed=${row.status} | hist.tail=${row.last_hist_status}`);
  }

  if (drifted.rows.length === 0) {
    console.log('[backfill-1531] nothing to do');
    await pool.end();
    return;
  }

  if (!apply) {
    console.log('\n[backfill-1531] DRY RUN — pass --apply to write');
    await pool.end();
    return;
  }

  const now = Date.now();
  let updated = 0;
  for (const row of drifted.rows) {
    const entry = {
      status: row.status,
      timestamp: now,
      by: 'system-backfill-#1531',
      model: null,
      note: `reconciled drift: hist.tail was '${row.last_hist_status}', typed status was '${row.status}'`,
    };
    const res = await pool.query(
      `UPDATE org_studio_tasks
         SET status_history = COALESCE(status_history, '[]'::jsonb) || $1::jsonb
       WHERE id = $2`,
      [JSON.stringify(entry), row.id],
    );
    updated += res.rowCount ?? 0;
    console.log(`  ✓ #${row.ticket_number ?? '?'} ${row.id} reconciled`);
  }

  console.log(`\n[backfill-1531] updated ${updated} row(s)`);

  // Verify: no drifted rows remain
  const after = await pool.query(`
    SELECT COUNT(*) AS n
    FROM org_studio_tasks
    WHERE jsonb_array_length(COALESCE(status_history, '[]'::jsonb)) > 0
      AND status IS NOT NULL
      AND status != (status_history->-1->>'status')
  `);
  const remaining = Number(after.rows[0]?.n ?? 0);
  if (remaining === 0) {
    console.log('[backfill-1531] ✓ verified: zero drifted rows remain');
  } else {
    console.error(`[backfill-1531] ✗ ${remaining} drifted rows STILL remain — investigate`);
    process.exitCode = 1;
  }

  await pool.end();
}

main().catch((err) => {
  console.error('[backfill-1531] fatal:', err);
  process.exit(1);
});
