#!/usr/bin/env node
/**
 * collapse-qa-to-rolling-version.mjs
 *
 * Reshape Thrivor's QA component to the "one rolling QA version" model:
 *
 *   shipped 0.1.0 ✓ (history, 6/6 done)
 *   shipped 0.2.0-history ... up through 0.9.0 (history of past QA cycles)
 *   current 0.908.1 ← single live QA version containing every currently-
 *                    testable task, waitsFor=Main@0.908.1
 *
 * NO pre-created future QA versions. Next QA version (0.909.0) is born
 * when dev ships 0.909.0.
 *
 * Inputs to think about:
 *   - 9 historical mirror versions (0.1.0 ... 0.9.0): keep as 'shipped' for
 *     the record (preserves Billy's past QA audit trail).
 *   - 18 empty mirror versions (0.901.0 ... 1.0.0): DELETE.
 *   - 47 testable QA tasks currently tagged 0.2.0..0.9.0 (the not-done
 *     ones) + 3 ad-hoc (no version): retag all to '0.908.1' and bundle
 *     into the new live QA version's items[].
 *
 * Why retag tasks: dispatch gate looks at task.version vs component.approvedThrough.
 * Keeping them on 0.3.0..0.9.0 leaves them gated unless QA banner is
 * 0.9.0+, which conflicts with the rolling-version model. They belong to
 * the 0.908.1 cycle now.
 *
 * The 9 historical-version tasks (the 13 done ones across 0.1.0/0.2.0 +
 * the 1 done in 0.9.0) keep their original version tags so history is
 * accurate.
 *
 * Idempotent. Dry-run by default.
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
const PROJECT = 'zrrt51fgmn578ujz';
const QA_COMP = 'sec-lbckedr6';
const MAIN_COMP = 'sec-main-zrrt51fgmn578ujz';
const LIVE_QA_VERSION = '0.908.1';

if (!DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
const pool = new Pool({ connectionString: DATABASE_URL });

async function main() {
  const c = await pool.connect();
  try {
    console.log(APPLY ? '🔧 APPLY' : '🔍 DRY-RUN');

    // Backup
    const backupDir = path.resolve('backups');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const projRow = (await c.query(`SELECT id,name,data FROM org_studio_projects WHERE id=$1 AND workspace_id=$2`, [PROJECT, WORKSPACE])).rows[0];
    const taskRows = (await c.query(`SELECT id, ticket_number, title, version, status FROM org_studio_tasks WHERE project_id=$1 AND workspace_id=$2 AND data->>'sectionId'=$3`, [PROJECT, WORKSPACE, QA_COMP])).rows;
    const backupPath = path.join(backupDir, `pre-qa-collapse-${ts}.json`);
    fs.writeFileSync(backupPath, JSON.stringify({ project: projRow, qaTasks: taskRows }, null, 2));
    console.log(`📦 ${backupPath}`);
    console.log('');

    // ── Decide which versions are "history" vs "to-delete" ──
    // History = all 0.1.0..0.9.0 mirror versions (these match real shipped Main versions
    // that Billy actually QA'd). Keep them as-is.
    // To delete = 0.901.0+ (empty mirrors that were never QA'd separately — they're
    // back-end / infra versions; QA happens via the rolling version going forward).
    const data = typeof projRow.data === 'string' ? JSON.parse(projRow.data) : projRow.data;
    const secs = data.components || data.sections;
    const qaIdx = secs.findIndex(s => s.id === QA_COMP);
    const oldQaVersions = secs[qaIdx].versions || [];

    const HISTORICAL_VERSIONS = ['0.1.0','0.2.0','0.3.0','0.4.0','0.5.0','0.6.0','0.7.0','0.8.0','0.9.0'];
    const historical = oldQaVersions.filter(v => HISTORICAL_VERSIONS.includes(v.version));

    console.log(`Historical QA versions kept: ${historical.map(v => v.version).join(', ')}`);
    console.log(`QA versions deleted: ${oldQaVersions.filter(v => !HISTORICAL_VERSIONS.includes(v.version)).map(v=>v.version).join(', ')}`);
    console.log('');

    // ── Determine which tasks roll into the live QA version ──
    // Rule: any QA task that is NOT done AND is currently tagged to a historical
    // version (0.2.0..0.9.0) OR has no version → moves to the rolling 0.908.1.
    // Tasks that ARE done stay where they are (history).
    const tasksByVersion = new Map();
    const tasksToRetag = []; // {id, oldVersion, title, status}
    for (const t of taskRows) {
      if (!tasksByVersion.has(t.version || '(null)')) tasksByVersion.set(t.version || '(null)', []);
      tasksByVersion.get(t.version || '(null)').push(t);
    }

    // Live QA items
    const liveItems = [];
    for (const t of taskRows) {
      if (t.status === 'done') continue; // done tasks stay in their historical version
      // anything not done → rolling
      tasksToRetag.push(t);
      liveItems.push({
        id: `item-qa-${t.id}`,
        title: t.title,
        done: false,
        taskId: t.id,
      });
    }

    // ── Rebuild historical version items[] from the DONE tasks for that version ──
    // Drop historical versions with zero done tasks — they're empty mirrors that
    // never had real QA work; cluttering the QA roadmap with them is noise.
    const rebuiltHistorical = historical
      .map(v => {
        const doneTasksThisVersion = (tasksByVersion.get(v.version) || []).filter(t => t.status === 'done');
        const items = doneTasksThisVersion.map(t => ({
          id: `item-qa-${t.id}`,
          title: t.title,
          done: true,
          taskId: t.id,
        }));
        return { ...v, items, status: 'shipped' };
      })
      .filter(v => (v.items || []).length > 0);

    // ── Build the new live QA version ──
    const liveVersion = {
      id: `rv-${PROJECT}-qa-${LIVE_QA_VERSION.replace(/\./g, '-')}`,
      version: LIVE_QA_VERSION,
      title: `QA cycle for Main ${LIVE_QA_VERSION}`,
      status: 'current',
      items: liveItems,
      sort_order: 999, // tail of historical list — sorts after 0.9.0
      version_type: 'outcome',
      waitsFor: {
        componentId: MAIN_COMP,
        version: LIVE_QA_VERSION,
      },
    };

    const newQaVersions = [...rebuiltHistorical, liveVersion];

    console.log('Final QA versions:');
    for (const v of newQaVersions) {
      const done = (v.items||[]).filter(i=>i.done).length;
      const total = (v.items||[]).length;
      const wf = v.waitsFor ? ` waitsFor=${v.waitsFor.componentId}@${v.waitsFor.version}` : '';
      console.log(`  ${v.version.padEnd(10)} ${v.status.padEnd(10)} ${done}/${total} items${wf}`);
    }
    console.log('');

    // ── Tasks to retag ──
    const retagSummary = {};
    for (const t of tasksToRetag) {
      const k = t.version || '(null)';
      retagSummary[k] = (retagSummary[k] || 0) + 1;
    }
    console.log(`Tasks to retag → version=${LIVE_QA_VERSION}:`);
    for (const [v, n] of Object.entries(retagSummary)) console.log(`  ${v.padEnd(10)} ${n}`);
    console.log(`  TOTAL: ${tasksToRetag.length}`);
    console.log('');

    if (!APPLY) {
      console.log('Re-run with --apply.');
      return;
    }

    // ── Apply ──
    secs[qaIdx] = { ...secs[qaIdx], versions: newQaVersions };
    if (data.components) data.components = secs; else data.sections = secs;

    await c.query('BEGIN');
    try {
      await c.query(`UPDATE org_studio_projects SET data=$1 WHERE id=$2 AND workspace_id=$3`,
        [JSON.stringify(data), PROJECT, WORKSPACE]);

      for (const t of tasksToRetag) {
        await c.query(`UPDATE org_studio_tasks SET version=$1 WHERE id=$2 AND workspace_id=$3`,
          [LIVE_QA_VERSION, t.id, WORKSPACE]);
      }
      await c.query('COMMIT');
      console.log(`✅ Committed. ${tasksToRetag.length} tasks retagged to ${LIVE_QA_VERSION}.`);
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
