#!/usr/bin/env node
/**
 * test-workspace-isolation.mjs
 *
 * Regression test for Phase 2 multi-workspace isolation.
 * Validates that workspace_id scoping is enforced on org_studio_projects and org_studio_tasks.
 *
 * Steps:
 *   1. Create a test workspace row
 *   2. Insert a project + task stamped with 'test-workspace-2'
 *   3. SELECT for 'default-workspace' — assert test rows are absent
 *   4. SELECT for 'test-workspace-2' — assert test rows are present
 *   5. Clean up
 *   6. Exit 0 on pass, non-zero on fail
 *
 * Usage: node scripts/test-workspace-isolation.mjs
 * Requires: DATABASE_URL in .env.local or environment
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

// Load .env.local
try {
  const envContent = readFileSync(join(rootDir, '.env.local'), 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx);
    const value = trimmed.slice(eqIdx + 1);
    if (!process.env[key]) process.env[key] = value;
  }
} catch {
  // .env.local may not exist
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL not set. Cannot run workspace isolation test.');
  process.exit(1);
}

const { default: pg } = await import('pg');
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });

const TEST_WORKSPACE_ID = 'test-workspace-2';
const TEST_PROJECT_ID = `proj-test-isolation-${Date.now()}`;
const TEST_TASK_ID = `task-test-isolation-${Date.now()}`;

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

async function cleanup() {
  console.log('\n🧹 Cleaning up...');
  try {
    await pool.query('DELETE FROM org_studio_tasks WHERE id = $1', [TEST_TASK_ID]);
    await pool.query('DELETE FROM org_studio_projects WHERE id = $1', [TEST_PROJECT_ID]);
    await pool.query('DELETE FROM org_studio_workspaces WHERE id = $1', [TEST_WORKSPACE_ID]);
    console.log('  Cleanup complete.');
  } catch (e) {
    console.error('  Cleanup error (non-fatal):', e.message);
  }
}

try {
  console.log('🔬 Workspace Isolation Regression Test\n');

  // 0. Learn workspace table schema
  const { rows: wsCols } = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'org_studio_workspaces' ORDER BY ordinal_position`
  );
  const colNames = wsCols.map(r => r.column_name);
  console.log(`  Workspace table columns: ${colNames.join(', ')}`);

  // 1. Create test workspace
  console.log('\n📦 Step 1: Create test workspace');
  await pool.query(
    `INSERT INTO org_studio_workspaces (id, name, owner, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [TEST_WORKSPACE_ID, 'Test Workspace 2', 'test-system', Date.now()]
  );
  const { rows: wsCheck } = await pool.query('SELECT id FROM org_studio_workspaces WHERE id = $1', [TEST_WORKSPACE_ID]);
  assert(wsCheck.length === 1, `Workspace '${TEST_WORKSPACE_ID}' created`);

  // 2. Insert project + task stamped with test workspace
  console.log('\n📦 Step 2: Insert project + task with workspace_id = test-workspace-2');
  await pool.query(
    `INSERT INTO org_studio_projects (id, name, phase, created_at, workspace_id, data)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [TEST_PROJECT_ID, 'Isolation Test Project', 'active', Date.now(), TEST_WORKSPACE_ID, '{}']
  );
  await pool.query(
    `INSERT INTO org_studio_tasks (id, title, status, project_id, created_at, workspace_id, status_history, comments, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [TEST_TASK_ID, 'Isolation Test Task', 'backlog', TEST_PROJECT_ID, Date.now(), TEST_WORKSPACE_ID, '[]', '[]', '{}']
  );
  console.log(`  Inserted project ${TEST_PROJECT_ID} and task ${TEST_TASK_ID}`);

  // 3. Query for default-workspace — test rows must NOT appear
  console.log('\n🔍 Step 3: Query default-workspace — test rows must be absent');
  const { rows: defProjects } = await pool.query(
    `SELECT id FROM org_studio_projects WHERE workspace_id = $1 AND id = $2`,
    ['default-workspace', TEST_PROJECT_ID]
  );
  assert(defProjects.length === 0, 'Test project NOT in default-workspace');

  const { rows: defTasks } = await pool.query(
    `SELECT id FROM org_studio_tasks WHERE workspace_id = $1 AND id = $2`,
    ['default-workspace', TEST_TASK_ID]
  );
  assert(defTasks.length === 0, 'Test task NOT in default-workspace');

  // 4. Query for test-workspace-2 — test rows must appear
  console.log('\n🔍 Step 4: Query test-workspace-2 — test rows must be present');
  const { rows: testProjects } = await pool.query(
    `SELECT id, name FROM org_studio_projects WHERE workspace_id = $1 AND id = $2`,
    [TEST_WORKSPACE_ID, TEST_PROJECT_ID]
  );
  assert(testProjects.length === 1, 'Test project IS in test-workspace-2');
  if (testProjects.length === 1) {
    assert(testProjects[0].name === 'Isolation Test Project', 'Project name matches');
  }

  const { rows: testTasks } = await pool.query(
    `SELECT id, title FROM org_studio_tasks WHERE workspace_id = $1 AND id = $2`,
    [TEST_WORKSPACE_ID, TEST_TASK_ID]
  );
  assert(testTasks.length === 1, 'Test task IS in test-workspace-2');
  if (testTasks.length === 1) {
    assert(testTasks[0].title === 'Isolation Test Task', 'Task title matches');
  }

  // 5. Verify cross-workspace isolation at query level (no workspace_id = test rows invisible)
  console.log('\n🔍 Step 5: Verify scoped queries exclude cross-workspace data');
  const { rows: allDefaultProjects } = await pool.query(
    `SELECT id FROM org_studio_projects WHERE workspace_id = $1`,
    ['default-workspace']
  );
  const testProjInDefault = allDefaultProjects.some(r => r.id === TEST_PROJECT_ID);
  assert(!testProjInDefault, 'Test project does not leak into default-workspace project list');

  const { rows: allDefaultTasks } = await pool.query(
    `SELECT id FROM org_studio_tasks WHERE workspace_id = $1`,
    ['default-workspace']
  );
  const testTaskInDefault = allDefaultTasks.some(r => r.id === TEST_TASK_ID);
  assert(!testTaskInDefault, 'Test task does not leak into default-workspace task list');

  // 6. Cleanup
  await cleanup();

  // Summary
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(50)}`);

  if (failed > 0) {
    console.error('\n❌ WORKSPACE ISOLATION TEST FAILED');
    process.exit(1);
  } else {
    console.log('\n✅ All workspace isolation tests passed!');
    process.exit(0);
  }
} catch (e) {
  console.error('\n💥 Unexpected error:', e.message);
  console.error(e.stack);
  await cleanup().catch(() => {});
  process.exit(2);
} finally {
  await pool.end();
}
