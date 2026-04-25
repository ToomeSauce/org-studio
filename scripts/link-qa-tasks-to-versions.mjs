#!/usr/bin/env node
/**
 * link-qa-tasks-to-versions.mjs
 *
 * Follow-up to hydrate-component-versions.mjs.
 *
 * The previous script cloned Main's version structure onto Thrivor's QA
 * component but left every QA version's items[] empty. Result: UI shows
 * the QA roadmap pills but they all render as empty.
 *
 * This script populates QA component versions[].items[] from the actual
 * QA tasks already linked by version. One item per task. `done` flag
 * derived from task.status === 'done'. taskId set so the version progress
 * bars (X/Y) render correctly.
 *
 * Idempotent. Dry-run by default; pass --apply to commit.
 */

import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

const APPLY = process.argv.includes('--apply');
const DATABASE_URL = process.env.DATABASE_URL || (() => {
  const env = fs.readFileSync(path.resolve('.env.local'), 'utf8');
  return env.split('\n').find(l => l.startsWith('DATABASE_URL='))?.split('=').slice(1).join('=');
})();
const WORKSPACE = 'default-workspace';
const THRIVOR_PROJECT_ID = 'zrrt51fgmn578ujz';
const THRIVOR_QA_COMPONENT_ID = 'sec-lbckedr6';

if (!DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
const pool = new Pool({ connectionString: DATABASE_URL });

function makeItemId(taskId) {
  return `item-qa-${taskId}`;
}

async function main() {
  const client = await pool.connect();
  try {
    console.log(APPLY ? '🔧 APPLY' : '🔍 DRY-RUN');
    console.log('');

    // Fetch project
    const projRes = await client.query(
      `SELECT id, name, data FROM org_studio_projects WHERE id=$1 AND workspace_id=$2`,
      [THRIVOR_PROJECT_ID, WORKSPACE]
    );
    if (!projRes.rows.length) throw new Error('Thrivor not found');
    const data = typeof projRes.rows[0].data === 'string' ? JSON.parse(projRes.rows[0].data) : projRes.rows[0].data;

    // Backup
    const backupDir = path.resolve('backups');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `pre-link-qa-${ts}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(projRes.rows[0], null, 2));
    console.log(`📦 Backup: ${backupPath}`);
    console.log('');

    // Fetch QA tasks for Thrivor (not archived, has version)
    const tasksRes = await client.query(`
      SELECT id, ticket_number, title, version, status
      FROM org_studio_tasks
      WHERE project_id=$1 AND workspace_id=$2
        AND data->>'sectionId'=$3
        AND COALESCE((data->>'isArchived')::boolean, false)=false
        AND version IS NOT NULL
      ORDER BY version, ticket_number
    `, [THRIVOR_PROJECT_ID, WORKSPACE, THRIVOR_QA_COMPONENT_ID]);

    // Group by version
    const tasksByVersion = new Map();
    for (const t of tasksRes.rows) {
      if (!tasksByVersion.has(t.version)) tasksByVersion.set(t.version, []);
      tasksByVersion.get(t.version).push(t);
    }
    console.log(`Found ${tasksRes.rows.length} QA tasks across ${tasksByVersion.size} versions`);
    console.log('');

    // Update each QA component version with linked items
    const secs = data.components || data.sections;
    const qaIdx = secs.findIndex(s => s.id === THRIVOR_QA_COMPONENT_ID);
    if (qaIdx < 0) throw new Error('QA component not found');

    const newVersions = secs[qaIdx].versions.map(v => {
      const tasks = tasksByVersion.get(v.version) || [];
      if (!tasks.length) return v;

      const items = tasks.map(t => ({
        id: makeItemId(t.id),
        title: t.title,
        done: t.status === 'done',
        taskId: t.id,
      }));

      // If any task is not-done, the QA version status moves from 'planned' → 'current'
      // If all are done, it moves to 'shipped'
      const allDone = tasks.every(t => t.status === 'done');
      const anyStarted = tasks.some(t => ['done', 'in-progress', 'review', 'qa'].includes(t.status));
      let status = v.status;
      if (allDone) status = 'shipped';
      else if (anyStarted) status = 'current';
      // else stay planned

      console.log(`  v${v.version}: ${items.length} items, ${tasks.filter(t=>t.status==='done').length} done → status=${status}`);
      return { ...v, items, status };
    });

    secs[qaIdx] = { ...secs[qaIdx], versions: newVersions };
    if (data.components) data.components = secs; else data.sections = secs;

    if (APPLY) {
      // Also mirror into org_studio_roadmap_versions table for QA so reads stay consistent
      // (skipping for now — QA versions are NOT in rv-table by design, only Main is.
      //  The component.versions[] jsonb is the source of truth for QA.)
      await client.query(
        `UPDATE org_studio_projects SET data=$1 WHERE id=$2 AND workspace_id=$3`,
        [JSON.stringify(data), THRIVOR_PROJECT_ID, WORKSPACE]
      );
      console.log('\n✅ Committed to Thrivor.data');
    } else {
      console.log('\nRe-run with --apply to commit.');
    }

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
