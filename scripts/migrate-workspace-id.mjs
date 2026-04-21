#!/usr/bin/env node
/**
 * Migration: Add workspace_id column to org_studio_projects and org_studio_tasks.
 * Backfills existing data with 'default-workspace'.
 * Adds index for query performance.
 *
 * Usage: node scripts/migrate-workspace-id.mjs
 *
 * Safe to run multiple times — uses IF NOT EXISTS / WHERE NOT EXISTS guards.
 */

import { readFileSync } from 'fs';

const env = readFileSync('.env.local', 'utf-8');
const match = env.match(/DATABASE_URL=(.+)/);
const dbUrl = match ? match[1].trim() : null;

if (!dbUrl) {
  console.error('❌ No DATABASE_URL found in .env.local');
  process.exit(1);
}

const { default: pg } = await import('pg');
const pool = new pg.Pool({ connectionString: dbUrl });

async function run() {
  const client = await pool.connect();
  try {
    console.log('🔄 Starting workspace_id migration...\n');

    // 1. Add workspace_id column to projects
    console.log('  → Adding workspace_id to org_studio_projects...');
    await client.query(`
      ALTER TABLE org_studio_projects
      ADD COLUMN IF NOT EXISTS workspace_id TEXT DEFAULT 'default-workspace'
    `);

    // 2. Add workspace_id column to tasks
    console.log('  → Adding workspace_id to org_studio_tasks...');
    await client.query(`
      ALTER TABLE org_studio_tasks
      ADD COLUMN IF NOT EXISTS workspace_id TEXT DEFAULT 'default-workspace'
    `);

    // 3. Backfill existing records
    console.log('  → Backfilling existing projects...');
    const projResult = await client.query(`
      UPDATE org_studio_projects
      SET workspace_id = 'default-workspace'
      WHERE workspace_id IS NULL
    `);
    console.log(`    Updated ${projResult.rowCount} project(s)`);

    console.log('  → Backfilling existing tasks...');
    const taskResult = await client.query(`
      UPDATE org_studio_tasks
      SET workspace_id = 'default-workspace'
      WHERE workspace_id IS NULL
    `);
    console.log(`    Updated ${taskResult.rowCount} task(s)`);

    // 4. Create indexes
    console.log('  → Creating indexes...');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_projects_workspace_id ON org_studio_projects (workspace_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tasks_workspace_id ON org_studio_tasks (workspace_id)
    `);

    // 5. Create workspaces table (for future use — v1.0+)
    console.log('  → Creating org_studio_workspaces table (if needed)...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS org_studio_workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner TEXT NOT NULL,
        created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
        data JSONB DEFAULT '{}'
      )
    `);

    // 6. Create workspace_memberships table
    console.log('  → Creating org_studio_workspace_memberships table (if needed)...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS org_studio_workspace_memberships (
        workspace_id TEXT NOT NULL REFERENCES org_studio_workspaces(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        role TEXT DEFAULT 'member',
        joined_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
        PRIMARY KEY (workspace_id, user_id)
      )
    `);

    // 7. Insert default workspace if not exists
    console.log('  → Ensuring default workspace exists...');
    await client.query(`
      INSERT INTO org_studio_workspaces (id, name, owner, created_at)
      VALUES ('default-workspace', 'Default Workspace', 'system', 0)
      ON CONFLICT (id) DO NOTHING
    `);

    // 8. Verify
    const projCount = await client.query('SELECT COUNT(*) FROM org_studio_projects WHERE workspace_id IS NOT NULL');
    const taskCount = await client.query('SELECT COUNT(*) FROM org_studio_tasks WHERE workspace_id IS NOT NULL');
    const wsCount = await client.query('SELECT COUNT(*) FROM org_studio_workspaces');

    console.log('\n✅ Migration complete!');
    console.log(`   Projects with workspace_id: ${projCount.rows[0].count}`);
    console.log(`   Tasks with workspace_id: ${taskCount.rows[0].count}`);
    console.log(`   Workspaces: ${wsCount.rows[0].count}`);
  } catch (e) {
    console.error('❌ Migration failed:', e.message);
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(() => process.exit(1));
