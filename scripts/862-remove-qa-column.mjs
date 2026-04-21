#!/usr/bin/env node
/**
 * #862: Migrate any tasks currently in status='qa' back to status='in-progress'.
 *
 * Context: As of 2026-04-21, QA is a component within a project (with its own
 * owner), NOT a board column. Tickets flow through the standard path
 * (backlog → in-progress → done). The API now rejects status='qa'; this
 * migration cleans up any tasks that were written under the old model.
 *
 * For each task with status='qa':
 *   1. Set status='in-progress'
 *   2. Resolve assignee in order:
 *        existing testAssignee > store.settings.qaLead > project.qaOwner > keep current assignee
 *   3. Append a system comment explaining the migration
 *   4. Record the change in statusHistory
 *
 * Idempotent — safe to re-run.
 *
 * Usage:
 *   node scripts/862-remove-qa-column.mjs              # dry-run (default)
 *   node scripts/862-remove-qa-column.mjs --execute    # actually write
 */

import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env.local without dotenv dep
const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = val;
  }
}

const EXECUTE = process.argv.includes('--execute');
const DRY_RUN = !EXECUTE;
const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATION_COMMENT =
  '[migration #862] QA column removed — task moved from qa to in-progress. ' +
  'QA is now a component with its own owner; tickets flow through the standard ' +
  'backlog → in-progress → done path.';

function resolveAssignee(task, storeSettings, project) {
  if (task.testAssignee) return task.testAssignee;
  if (storeSettings?.qaLead) {
    const teammates = storeSettings.teammates || [];
    const qaTeammate = teammates.find((tm) => tm.agentId === storeSettings.qaLead);
    return qaTeammate?.name || storeSettings.qaLead;
  }
  if (project?.qaOwner) return project.qaOwner;
  return task.assignee;
}

function buildMigrationPlan(tasks, projects, settings) {
  const plan = [];
  for (const t of tasks) {
    const project = projects.find((p) => p.id === t.projectId);
    const newAssignee = resolveAssignee(t, settings, project);
    plan.push({
      id: t.id,
      ticketNumber: t.ticketNumber,
      title: t.title || '(untitled)',
      projectId: t.projectId,
      projectName: project?.name || 'unknown',
      oldStatus: 'qa',
      newStatus: 'in-progress',
      oldAssignee: t.assignee,
      newAssignee,
      testAssignee: t.testAssignee || null,
    });
  }
  return plan;
}

function writeBackup(scope, payload) {
  const backupsDir = path.join(__dirname, '..', 'backups');
  if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupsDir, `862-qa-migration-${scope}-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(payload, null, 2));
  return backupPath;
}

// ---------------- Postgres path ----------------
async function runPostgres() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  console.log(`[862] Connected to Postgres`);

  const { rows: taskRows } = await client.query(
    `SELECT id, ticket_number, title, status, project_id, assignee, test_assignee,
            status_history, comments, data
       FROM org_studio_tasks
      WHERE status = 'qa'`
  );
  const { rows: projectRows } = await client.query(
    `SELECT id, name, data FROM org_studio_projects`
  );
  const { rows: settingsRows } = await client.query(
    `SELECT data FROM org_studio_settings WHERE id = 'default' LIMIT 1`
  );

  const tasks = taskRows.map((r) => {
    const overflow = typeof r.data === 'string' ? JSON.parse(r.data) : (r.data || {});
    const sh = typeof r.status_history === 'string' ? JSON.parse(r.status_history) : (r.status_history || []);
    const comments = typeof r.comments === 'string' ? JSON.parse(r.comments) : (r.comments || []);
    return {
      id: r.id,
      ticketNumber: r.ticket_number,
      title: r.title,
      status: r.status,
      projectId: r.project_id,
      assignee: r.assignee,
      testAssignee: r.test_assignee,
      statusHistory: sh,
      comments,
      ...overflow,
    };
  });
  const projects = projectRows.map((r) => {
    const overflow = typeof r.data === 'string' ? JSON.parse(r.data) : (r.data || {});
    return { id: r.id, name: r.name, ...overflow };
  });
  const settingsRaw = settingsRows[0]?.data || {};
  const settings = typeof settingsRaw === 'string' ? JSON.parse(settingsRaw) : settingsRaw;

  const plan = buildMigrationPlan(tasks, projects, settings);
  console.log(`[862] Tasks currently in status='qa': ${plan.length}`);

  if (plan.length === 0) {
    console.log('[862] Nothing to migrate. Exiting cleanly.');
    await client.end();
    return;
  }

  for (const row of plan) {
    console.log(
      `  #${row.ticketNumber} ${(row.title || '').slice(0, 60)} — assignee ${row.oldAssignee || '(none)'} → ${row.newAssignee || '(none)'} (project: ${row.projectName})`
    );
  }

  if (DRY_RUN) {
    console.log('\n[862] DRY RUN — no changes written. Re-run with --execute to apply.');
    await client.end();
    return;
  }

  const backupPath = writeBackup('postgres', { plan, timestamp: Date.now() });
  console.log(`[862] Backup written: ${backupPath}`);

  await client.query('BEGIN');
  try {
    const now = Date.now();
    for (const row of plan) {
      const task = tasks.find((t) => t.id === row.id);
      const history = [...(task.statusHistory || []), {
        status: 'in-progress',
        timestamp: now,
        by: 'System (#862 migration)',
      }];
      const commentId = Math.random().toString(36).slice(2, 10) + now.toString(36);
      const comments = [...(task.comments || []), {
        id: commentId,
        createdAt: now,
        author: 'System',
        content: MIGRATION_COMMENT,
        type: 'system',
      }];

      await client.query(
        `UPDATE org_studio_tasks
            SET status = $1,
                assignee = $2,
                status_history = $3,
                comments = $4,
                last_activity_at = $5
          WHERE id = $6`,
        [
          'in-progress',
          row.newAssignee || task.assignee,
          JSON.stringify(history),
          JSON.stringify(comments),
          now,
          row.id,
        ]
      );
    }
    await client.query('COMMIT');
    console.log(`[862] Committed migration of ${plan.length} task(s).`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[862] ERROR — rolled back:', err);
    throw err;
  } finally {
    await client.end();
  }
}

// ---------------- JSON store fallback ----------------
async function runJsonStore() {
  const storePath = path.join(__dirname, '..', 'data', 'store.json');
  if (!fs.existsSync(storePath)) {
    console.log('[862] No DATABASE_URL and no data/store.json — nothing to do.');
    return;
  }
  const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const qaTasks = (store.tasks || []).filter((t) => t.status === 'qa');
  const plan = buildMigrationPlan(qaTasks, store.projects || [], store.settings || {});
  console.log(`[862] Tasks currently in status='qa' (json): ${plan.length}`);
  if (plan.length === 0) return;

  for (const row of plan) {
    console.log(`  #${row.ticketNumber} ${row.title} — ${row.oldAssignee} → ${row.newAssignee}`);
  }
  if (DRY_RUN) {
    console.log('\n[862] DRY RUN — no changes written.');
    return;
  }

  writeBackup('json', { plan, originalStore: store, timestamp: Date.now() });
  const now = Date.now();
  for (const row of plan) {
    const idx = store.tasks.findIndex((t) => t.id === row.id);
    if (idx < 0) continue;
    const t = store.tasks[idx];
    store.tasks[idx] = {
      ...t,
      status: 'in-progress',
      assignee: row.newAssignee || t.assignee,
      statusHistory: [...(t.statusHistory || []), { status: 'in-progress', timestamp: now, by: 'System (#862 migration)' }],
      comments: [...(t.comments || []), {
        id: Math.random().toString(36).slice(2, 10) + now.toString(36),
        createdAt: now,
        author: 'System',
        content: MIGRATION_COMMENT,
        type: 'system',
      }],
      lastActivityAt: now,
    };
  }
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
  console.log(`[862] Wrote migrated store.json (${plan.length} task(s)).`);
}

(async () => {
  console.log(`[862] Migration — QA column removal`);
  console.log(`[862] Mode: ${DRY_RUN ? 'DRY RUN' : 'EXECUTE'}`);
  if (DATABASE_URL) {
    await runPostgres();
  } else {
    await runJsonStore();
  }
})().catch((err) => {
  console.error('[862] Fatal:', err);
  process.exit(1);
});
