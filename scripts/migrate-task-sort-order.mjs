// #1250 — promote task sortOrder to a typed Postgres column.
//
// Steps (idempotent):
//   1. ALTER TABLE org_studio_tasks ADD COLUMN sort_order INTEGER NULL.
//   2. CREATE INDEX (project_id, status, sort_order, created_at) for the
//      dispatcher's per-column ordering query.
//   3. Backfill: for each (project_id, status) group, rank rows by their
//      current effective order — (data->>'sortOrder')::int when present,
//      else created_at ASC — and assign sort_order = (rank + 1) * 1000.
//      Spaces of 1000 leave headroom for drag-insert without renumbering.
//   4. Drop the JSON-bag copy of sortOrder so the typed column is the only
//      source of truth.
//
// Re-running is safe: step 1 uses IF NOT EXISTS, step 2 uses IF NOT EXISTS,
// step 3 only writes rows where sort_order IS NULL, step 4 idempotently
// strips the JSON key.

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();

try {
  await client.query('BEGIN');

  console.log('1) ALTER TABLE …');
  await client.query(`
    ALTER TABLE org_studio_tasks
    ADD COLUMN IF NOT EXISTS sort_order INTEGER NULL
  `);

  console.log('2) CREATE INDEX …');
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_org_studio_tasks_column_order
    ON org_studio_tasks (project_id, status, sort_order, created_at)
  `);

  console.log('3) Backfill where sort_order IS NULL …');
  // Per (project, status) group: rank by (data->>'sortOrder')::numeric NULLS
  // LAST, then created_at ASC. Assign (rank + 1) * 1000.
  const backfill = await client.query(`
    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY project_id, status
          ORDER BY
            CASE
              WHEN data ? 'sortOrder' AND (data->>'sortOrder') ~ '^[0-9.]+$'
                THEN (data->>'sortOrder')::numeric
              ELSE NULL
            END NULLS LAST,
            created_at ASC,
            id ASC
        ) AS rn
      FROM org_studio_tasks
      WHERE sort_order IS NULL
    )
    UPDATE org_studio_tasks t
    SET sort_order = ranked.rn * 1000
    FROM ranked
    WHERE t.id = ranked.id
    RETURNING t.id
  `);
  console.log(`   backfilled ${backfill.rowCount} rows`);

  console.log('4) Drop sortOrder from data JSON bag …');
  const stripped = await client.query(`
    UPDATE org_studio_tasks
    SET data = data - 'sortOrder'
    WHERE data ? 'sortOrder'
    RETURNING id
  `);
  console.log(`   stripped ${stripped.rowCount} rows`);

  await client.query('COMMIT');

  // Verification
  const v = await client.query(`
    SELECT
      COUNT(*) AS total,
      COUNT(sort_order) AS with_sort_order,
      COUNT(*) FILTER (WHERE data ? 'sortOrder') AS still_in_data_bag
    FROM org_studio_tasks
  `);
  console.log('Post-migration counts:', v.rows[0]);
} catch (err) {
  await client.query('ROLLBACK');
  console.error('Migration failed; rolled back.', err);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
