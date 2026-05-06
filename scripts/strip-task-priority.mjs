// #1249 — strip task.priority from all rows.
// Column kept for one observation cycle; values nulled to disambiguate.
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const r1 = await pool.query("SELECT COUNT(*) AS c FROM org_studio_tasks WHERE priority IS NOT NULL");
console.log(`Before: ${r1.rows[0].c} tasks with priority set`);

const r2 = await pool.query("UPDATE org_studio_tasks SET priority = NULL WHERE priority IS NOT NULL");
console.log(`Updated: ${r2.rowCount} rows`);

// Defensive: also strip any priority that bled into the data JSON bag
const r3 = await pool.query(`
  UPDATE org_studio_tasks
  SET data = data - 'priority'
  WHERE data ? 'priority'
`);
console.log(`Stripped from data JSON bag: ${r3.rowCount} rows`);

const r4 = await pool.query("SELECT COUNT(*) AS c FROM org_studio_tasks WHERE priority IS NOT NULL OR data ? 'priority'");
console.log(`After: ${r4.rows[0].c} tasks with priority set`);

await pool.end();
