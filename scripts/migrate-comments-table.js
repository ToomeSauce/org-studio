#!/usr/bin/env node
/**
 * migrate-comments-table.js
 *
 * Creates the org_studio_comments table for polymorphic comment storage,
 * then backfills existing inline task comments into it.
 *
 * Safe to re-run (IF NOT EXISTS + ON CONFLICT DO NOTHING).
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/migrate-comments-table.js
 */

const { Pool } = require('pg');

const CONNECTION_STRING = process.env.DATABASE_URL || process.env.POSTGRES_URL || 'your-database-url-here';

const pool = new Pool({
  connectionString: CONNECTION_STRING,
  max: 5,
});

async function run() {
  const client = await pool.connect();
  try {
    console.log('Creating org_studio_comments table...');

    await client.query(`
      CREATE TABLE IF NOT EXISTS org_studio_comments (
        id TEXT PRIMARY KEY,
        scope_kind TEXT NOT NULL,
        task_id TEXT,
        section_id TEXT,
        board_project_id TEXT,
        dm_thread_id TEXT,
        scope_key TEXT GENERATED ALWAYS AS (
          scope_kind || ':' || COALESCE(task_id, section_id, board_project_id, dm_thread_id, '')
        ) STORED,
        author TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        type TEXT,
        model TEXT,
        mentions JSONB,
        data JSONB
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_comments_scope_key ON org_studio_comments(scope_key)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_comments_task ON org_studio_comments(task_id) WHERE task_id IS NOT NULL
    `);

    console.log('Table and indexes created.');

    // Backfill: read existing tasks.comments JSONB and insert into new table
    console.log('Backfilling existing task comments...');

    const tasksResult = await client.query(
      `SELECT id, comments FROM org_studio_tasks WHERE comments IS NOT NULL AND comments::text != '[]'`
    );

    let inserted = 0;
    let skipped = 0;

    for (const row of tasksResult.rows) {
      const comments = typeof row.comments === 'string' ? JSON.parse(row.comments) : (row.comments || []);
      for (const c of comments) {
        if (!c.id || !c.author || !c.content) {
          skipped++;
          continue;
        }
        try {
          await client.query(
            `INSERT INTO org_studio_comments (id, scope_kind, task_id, author, content, created_at, type, model, mentions, data)
             VALUES ($1, 'task', $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (id) DO NOTHING`,
            [
              c.id,
              row.id,
              c.author,
              c.content,
              c.createdAt || 0,
              c.type || null,
              c.model || null,
              c.mentions ? JSON.stringify(c.mentions) : null,
              JSON.stringify({ scope: { kind: 'task', taskId: row.id } }),
            ]
          );
          inserted++;
        } catch (err) {
          console.warn(`  Warning: failed to insert comment ${c.id} for task ${row.id}:`, err.message);
          skipped++;
        }
      }
    }

    console.log(`Backfill complete: ${inserted} inserted, ${skipped} skipped.`);
    console.log('Migration done.');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
