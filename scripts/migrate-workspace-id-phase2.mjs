#!/usr/bin/env node
/**
 * Migration Phase 2: Extend workspace_id to remaining org_studio_* tables.
 *
 * Phase 1 (scripts/migrate-workspace-id.mjs) covered projects + tasks + created
 * workspaces / workspace_memberships tables. This phase covers everything else:
 *   - org_studio_roadmap_versions
 *   - org_studio_vision_docs
 *   - org_studio_agent_metrics
 *   - org_studio_kudos
 *   - org_studio_outbox
 *   - org_studio_heartbeats
 *   - org_studio_incidents
 *   - org_studio_settings
 *   - org_studio_sessions
 *
 * For each: ADD COLUMN workspace_id TEXT DEFAULT 'default-workspace' → backfill
 * NULLs → CREATE INDEX. Idempotent. Safe to run repeatedly.
 *
 * Usage: node scripts/migrate-workspace-id-phase2.mjs
 */

import { readFileSync } from 'fs';

const env = readFileSync('.env.local', 'utf-8');
const match = env.match(/DATABASE_URL=(.+)/);
const dbUrl = match ? match[1].trim() : null;

if (!dbUrl) {
  console.error('❌ No DATABASE_URL found in .env.local');
  process.exit(1);
}

const TABLES = [
  'org_studio_roadmap_versions',
  'org_studio_vision_docs',
  'org_studio_agent_metrics',
  'org_studio_kudos',
  'org_studio_outbox',
  'org_studio_heartbeats',
  'org_studio_incidents',
  'org_studio_settings',
  'org_studio_sessions',
];

const { default: pg } = await import('pg');
const pool = new pg.Pool({ connectionString: dbUrl });

async function tableExists(client, name) {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    [name]
  );
  return r.rowCount > 0;
}

async function run() {
  const client = await pool.connect();
  try {
    console.log('🔄 Multi-tenant schema — Phase 2 migration starting...\n');

    const preCounts = {};
    const postCounts = {};

    for (const table of TABLES) {
      const exists = await tableExists(client, table);
      if (!exists) {
        console.log(`  ⏭  ${table} — does not exist, skipping`);
        continue;
      }

      // Pre-count
      const pre = await client.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
      preCounts[table] = pre.rows[0].n;

      // 1. Add column
      await client.query(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS workspace_id TEXT DEFAULT 'default-workspace'`
      );

      // 2. Backfill NULLs
      const back = await client.query(
        `UPDATE ${table} SET workspace_id='default-workspace' WHERE workspace_id IS NULL`
      );

      // 3. Index
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_${table.replace('org_studio_', '')}_workspace_id
         ON ${table} (workspace_id)`
      );

      // Post-count + NULL check
      const post = await client.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
      postCounts[table] = post.rows[0].n;

      const nullCheck = await client.query(
        `SELECT COUNT(*)::int AS n FROM ${table} WHERE workspace_id IS NULL`
      );
      const nulls = nullCheck.rows[0].n;

      const backfilledNote = back.rowCount > 0 ? ` (backfilled ${back.rowCount})` : '';
      const integrityNote = nulls === 0 ? '✅' : `⚠️  ${nulls} NULLs remaining`;
      const countNote = preCounts[table] === postCounts[table] ? '✅' : `⚠️  ${preCounts[table]}→${postCounts[table]}`;
      console.log(`  ✓ ${table.padEnd(35)} rows=${post.rows[0].n}${backfilledNote} ${integrityNote} ${countNote}`);
    }

    console.log('\n✅ Phase 2 migration complete.\n');

    // Summary
    console.log('Final workspace_id coverage (all org_studio tables):');
    const all = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name LIKE 'org_studio_%'
      ORDER BY table_name
    `);
    for (const row of all.rows) {
      const col = await client.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_name=$1 AND column_name='workspace_id'`,
        [row.table_name]
      );
      const has = col.rowCount > 0 ? '✅' : '❌';
      console.log(`  ${has} ${row.table_name}`);
    }
  } catch (e) {
    console.error('❌ Migration failed:', e.message);
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(() => process.exit(1));
