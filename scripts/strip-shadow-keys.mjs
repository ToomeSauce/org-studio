#!/usr/bin/env node
/**
 * scripts/strip-shadow-keys.mjs
 *
 * Removes "shadow keys" from the `data` JSONB column on tasks and projects.
 *
 * Background:
 *   Tasks and projects are reconstructed by merging typed columns with the
 *   `data` JSONB overflow blob. Historically the merge order was:
 *     { ...typedCols, ...data }
 *   which meant stale keys in `data` could shadow the source-of-truth typed
 *   column (e.g. `data.version = "0.0.0"` overriding `version` column = "0.2.0").
 *
 *   The writer (updateTask) was fixed some time ago to destructure typed
 *   fields out of `data` before writing, so new writes are clean. But older
 *   rows still carry shadow keys.
 *
 *   We've also flipped the reconstructor merge order so typed columns win,
 *   but this migration cleans up the data so the two sources don't silently
 *   disagree.
 *
 * Strategy:
 *   For each task / project, drop any key from `data` that corresponds to
 *   a typed column. Writes are idempotent — running twice is a no-op.
 *
 * Usage:
 *   node scripts/strip-shadow-keys.mjs         # dry run
 *   node scripts/strip-shadow-keys.mjs --apply # execute
 */

import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DRY_RUN = !process.argv.includes('--apply');

// Typed columns on org_studio_tasks (camelCase keys that would appear in data).
// Keep in sync with reconstructTask() in src/lib/store-provider.ts.
const TASK_TYPED_KEYS = [
  'id',
  'ticketNumber',
  'title',
  'status',
  'projectId',
  'assignee',
  'priority',
  'testType',
  'testAssignee',
  'initiatedBy',
  'description',
  'doneWhen',
  'constraints',
  'testPlan',
  'reviewNotes',
  'loopCount',
  'loopPausedAt',
  'loopPauseReason',
  'lastActivityAt',
  'createdAt',
  'version',
  'statusHistory',
  'comments',
  // also strip snake_case in case legacy writes used them
  'ticket_number',
  'project_id',
  'test_type',
  'test_assignee',
  'initiated_by',
  'done_when',
  'review_notes',
  'loop_count',
  'loop_paused_at',
  'loop_pause_reason',
  'last_activity_at',
  'created_at',
  'status_history',
];

// Typed columns on org_studio_projects.
// Keep in sync with reconstructProject() in src/lib/store-provider.ts.
const PROJECT_TYPED_KEYS = [
  'id',
  'name',
  'description',
  'phase',
  'owner',
  'priority',
  'sortOrder',
  'createdAt',
  'createdBy',
  // snake_case legacy
  'sort_order',
  'created_at',
  'created_by',
];

async function main() {
  // Load env
  const envPath = path.join(__dirname, '..', '.env.local');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const m = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
      if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }

  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL not set.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    console.log(DRY_RUN ? '🔍 DRY RUN — pass --apply to execute\n' : '⚡ APPLYING CHANGES\n');

    // ── 1. Backup ────────────────────────────────────────────────────────────

    if (!DRY_RUN) {
      const backupDir = path.join(__dirname, '..', 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(backupDir, `pre-strip-shadow-keys-${stamp}.json`);
      const tasks = await client.query('SELECT id, data FROM org_studio_tasks');
      const projects = await client.query('SELECT id, data FROM org_studio_projects');
      fs.writeFileSync(backupPath, JSON.stringify({ tasks: tasks.rows, projects: projects.rows }, null, 2));
      console.log(`💾 Backup → ${backupPath}\n`);
    }

    // ── 2. Tasks ─────────────────────────────────────────────────────────────

    const tasksRes = await client.query(
      'SELECT id, project_id, data FROM org_studio_tasks WHERE data IS NOT NULL'
    );
    let taskRowsScanned = 0;
    let taskRowsDirty = 0;
    let taskKeysStripped = 0;
    const taskKeyCounts = {};

    for (const row of tasksRes.rows) {
      taskRowsScanned++;
      const data = row.data || {};
      if (typeof data !== 'object' || Array.isArray(data)) continue;

      const shadowKeys = TASK_TYPED_KEYS.filter(k => k in data);
      if (shadowKeys.length === 0) continue;

      taskRowsDirty++;
      taskKeysStripped += shadowKeys.length;
      for (const k of shadowKeys) taskKeyCounts[k] = (taskKeyCounts[k] || 0) + 1;

      if (!DRY_RUN) {
        // Build a SET expression chaining `data - 'key'` for each shadow key
        let expr = 'data';
        const params = [row.id];
        let paramIdx = 2;
        for (const k of shadowKeys) {
          expr += ` - $${paramIdx}`;
          params.push(k);
          paramIdx++;
        }
        await client.query(
          `UPDATE org_studio_tasks SET data = ${expr}, updated_at = NOW() WHERE id = $1`,
          params
        );
      }
    }

    console.log(`📋 Tasks:`);
    console.log(`   Scanned:        ${taskRowsScanned}`);
    console.log(`   With shadows:   ${taskRowsDirty}`);
    console.log(`   Keys stripped:  ${taskKeysStripped}`);
    if (taskRowsDirty > 0) {
      console.log(`   Breakdown:`);
      const sorted = Object.entries(taskKeyCounts).sort((a, b) => b[1] - a[1]);
      for (const [k, n] of sorted) console.log(`     ${k.padEnd(22)} ${n}`);
    }
    console.log();

    // ── 3. Projects ──────────────────────────────────────────────────────────

    const projectsRes = await client.query(
      'SELECT id, data FROM org_studio_projects WHERE data IS NOT NULL'
    );
    let projRowsScanned = 0;
    let projRowsDirty = 0;
    let projKeysStripped = 0;
    const projKeyCounts = {};

    for (const row of projectsRes.rows) {
      projRowsScanned++;
      const data = row.data || {};
      if (typeof data !== 'object' || Array.isArray(data)) continue;

      const shadowKeys = PROJECT_TYPED_KEYS.filter(k => k in data);
      if (shadowKeys.length === 0) continue;

      projRowsDirty++;
      projKeysStripped += shadowKeys.length;
      for (const k of shadowKeys) projKeyCounts[k] = (projKeyCounts[k] || 0) + 1;

      if (!DRY_RUN) {
        let expr = 'data';
        const params = [row.id];
        let paramIdx = 2;
        for (const k of shadowKeys) {
          expr += ` - $${paramIdx}`;
          params.push(k);
          paramIdx++;
        }
        await client.query(
          `UPDATE org_studio_projects SET data = ${expr}, updated_at = NOW() WHERE id = $1`,
          params
        );
      }
    }

    console.log(`📋 Projects:`);
    console.log(`   Scanned:        ${projRowsScanned}`);
    console.log(`   With shadows:   ${projRowsDirty}`);
    console.log(`   Keys stripped:  ${projKeysStripped}`);
    if (projRowsDirty > 0) {
      console.log(`   Breakdown:`);
      const sorted = Object.entries(projKeyCounts).sort((a, b) => b[1] - a[1]);
      for (const [k, n] of sorted) console.log(`     ${k.padEnd(22)} ${n}`);
    }

    console.log('\n─────────────────────────────────────────────');
    if (DRY_RUN) {
      console.log('✅ Dry run complete. Run with --apply to execute.');
    } else {
      console.log('✅ Migration applied. Typed columns are now the sole source of truth for these keys.');
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('❌ Migration failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
