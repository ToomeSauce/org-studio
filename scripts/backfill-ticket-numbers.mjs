#!/usr/bin/env node
/**
 * #okqrk04nmou2mtsz — Backfill ticketNumber for tasks created before the
 * atomic ticket-number allocator (#863) landed.
 *
 * Identifies tasks whose `ticket_number` column is NULL and assigns each a
 * fresh number from the canonical sequence (`org_studio_ticket_number_seq`).
 * Using the sequence — instead of gap-filling — guarantees we cannot collide
 * with a concurrent `INSERT` from the live API. Numbers are monotonic, just
 * higher than newly-created tasks, which is the documented behavior for any
 * post-hoc backfill.
 *
 * Idempotent: tasks that already have a non-null ticket_number are skipped.
 * Run with DATABASE_URL set in env.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/backfill-ticket-numbers.mjs        # dry-run by default
 *   DATABASE_URL=postgres://... node scripts/backfill-ticket-numbers.mjs --apply
 */
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const dburl = process.env.DATABASE_URL;
if (!dburl) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: dburl });

async function main() {
  const client = await pool.connect();
  try {
    const { rows: missing } = await client.query(
      `SELECT id, title, project_id, status, created_at
         FROM org_studio_tasks
        WHERE ticket_number IS NULL
        ORDER BY created_at NULLS LAST, id`,
    );

    console.log(`Found ${missing.length} tasks with NULL ticket_number.`);
    if (missing.length === 0) {
      console.log('Nothing to backfill.');
      return;
    }
    for (const r of missing) {
      console.log(`  - ${r.id} [${r.status}] ${r.title} (project=${r.project_id})`);
    }

    if (!APPLY) {
      console.log('\nDry-run mode. Re-run with --apply to write.');
      return;
    }

    await client.query('BEGIN');
    let updated = 0;
    for (const r of missing) {
      const { rows } = await client.query(
        `SELECT nextval('org_studio_ticket_number_seq')::BIGINT AS n`,
      );
      const n = Number(rows[0].n);
      await client.query(
        `UPDATE org_studio_tasks
            SET ticket_number = $1,
                data = jsonb_set(data, '{ticketNumber}', to_jsonb($1::int), true)
          WHERE id = $2 AND ticket_number IS NULL`,
        [n, r.id],
      );
      console.log(`  ✓ ${r.id} → #${n}`);
      updated++;
    }
    await client.query('COMMIT');
    console.log(`\nBackfilled ${updated} task(s).`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

// #1312 guard: only auto-run when invoked as a script. When imported by
// another module (e.g. server.mjs), do NOT trigger main() — let the
// caller decide. Prevents one Postgres hiccup from killing the dashboard.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('Backfill failed:', e);
    process.exit(1);
  });
}
