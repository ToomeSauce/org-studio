#!/usr/bin/env node
/**
 * Idempotent migration: add section_id to org_studio_agent_metrics
 *
 * Adds:
 *   - section_id TEXT NULL column
 *   - Unique index on (agent_id, date, COALESCE(section_id, ''))
 *   - Drops old unique constraint on (agent_id, date) if present
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/add-metrics-section-id.mjs           # dry-run (prints SQL)
 *   DATABASE_URL=postgres://... node scripts/add-metrics-section-id.mjs --apply   # execute
 */

import pg from 'pg';
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const dryRun = !process.argv.includes('--apply');

async function run() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();

  try {
    // 1. Check if section_id column already exists
    const colCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'org_studio_agent_metrics' AND column_name = 'section_id'
    `);

    // 2. Check if new unique index already exists
    const idxCheck = await client.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'org_studio_agent_metrics' AND indexname = 'ux_agent_metrics_agent_date_section'
    `);

    if (colCheck.rows.length > 0 && idxCheck.rows.length > 0) {
      console.log('Already migrated — section_id column and index both present. Nothing to do.');
      return;
    }

    const statements = [];

    // 3. Add column if missing
    if (colCheck.rows.length === 0) {
      statements.push(`ALTER TABLE org_studio_agent_metrics ADD COLUMN IF NOT EXISTS section_id TEXT NULL;`);
    }

    // 4. Drop old unique constraint on (agent_id, date) if present
    // Look for any unique constraint/index that covers exactly (agent_id, date) without section_id
    const oldConstraints = await client.query(`
      SELECT con.conname
      FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
      WHERE rel.relname = 'org_studio_agent_metrics'
        AND con.contype = 'u'
        AND array_length(con.conkey, 1) = 2
    `);

    for (const row of oldConstraints.rows) {
      // Check if this is the old (agent_id, date) constraint by inspecting columns
      const colsRes = await client.query(`
        SELECT a.attname
        FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid
          JOIN pg_attribute a ON a.attrelid = rel.oid AND a.attnum = ANY(con.conkey)
        WHERE con.conname = $1 AND rel.relname = 'org_studio_agent_metrics'
        ORDER BY a.attnum
      `, [row.conname]);

      const cols = colsRes.rows.map(r => r.attname).sort();
      if (cols.includes('agent_id') && cols.includes('date') && !cols.includes('section_id')) {
        statements.push(`ALTER TABLE org_studio_agent_metrics DROP CONSTRAINT "${row.conname}";`);
      }
    }

    // Also drop any old unique indexes that cover just (agent_id, date)
    const oldIndexes = await client.query(`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'org_studio_agent_metrics'
        AND indexname != 'ux_agent_metrics_agent_date_section'
    `);

    for (const row of oldIndexes.rows) {
      // If the index definition mentions agent_id and date but NOT section_id, and it's UNIQUE
      const def = (row.indexdef || '').toLowerCase();
      if (def.includes('unique') && def.includes('agent_id') && def.includes('date') && !def.includes('section_id')) {
        statements.push(`DROP INDEX IF EXISTS "${row.indexname}";`);
      }
    }

    // 5. Create new unique index
    if (idxCheck.rows.length === 0) {
      statements.push(
        `CREATE UNIQUE INDEX ux_agent_metrics_agent_date_section ON org_studio_agent_metrics (agent_id, date, COALESCE(section_id, ''));`
      );
    }

    if (statements.length === 0) {
      console.log('Nothing to do — already migrated.');
      return;
    }

    console.log(`Migration: ${statements.length} statement(s)`);
    for (const sql of statements) {
      console.log(`  ${sql}`);
    }

    if (dryRun) {
      console.log('\nDry run — pass --apply to execute.');
    } else {
      await client.query('BEGIN');
      for (const sql of statements) {
        console.log(`Executing: ${sql}`);
        await client.query(sql);
      }
      await client.query('COMMIT');
      console.log('Migration applied successfully.');
    }
  } catch (err) {
    console.error('Migration failed:', err.message);
    try { await client.query('ROLLBACK'); } catch {}
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
