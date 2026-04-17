#!/usr/bin/env node
/**
 * reconcile-roadmap-items.mjs
 *
 * One-shot script that scans ALL roadmap versions across ALL projects,
 * checks each linked task's current status, and corrects the `done` flag.
 * After reconciling, it calls checkAndAutoAdvance for any project whose
 * current version just became fully done.
 *
 * Usage:  node scripts/reconcile-roadmap-items.mjs
 * Requires DATABASE_URL in .env.local (or environment).
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

// Load .env.local
try {
  const envPath = resolve(projectRoot, '.env.local');
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx);
    const val = trimmed.slice(eqIdx + 1);
    if (!process.env[key]) process.env[key] = val;
  }
} catch {}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set — nothing to reconcile.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function main() {
  const client = await pool.connect();
  try {
    // 1. Load all roadmap versions
    const versionRes = await client.query(
      `SELECT id, project_id, version, status, items, sort_order
       FROM org_studio_roadmap_versions
       ORDER BY project_id, sort_order`,
    );

    // 2. Collect all referenced taskIds
    const allTaskIds = new Set();
    for (const row of versionRes.rows) {
      for (const item of row.items || []) {
        if (item.taskId) allTaskIds.add(item.taskId);
      }
    }

    if (allTaskIds.size === 0) {
      console.log('No roadmap items reference tasks — nothing to reconcile.');
      return;
    }

    // 3. Bulk-load task statuses
    const taskIds = [...allTaskIds];
    const taskRes = await client.query(
      `SELECT id, status FROM org_studio_tasks WHERE id = ANY($1)`,
      [taskIds],
    );
    const taskStatusMap = new Map(taskRes.rows.map(t => [t.id, t.status]));
    console.log(`Loaded ${taskStatusMap.size} task statuses (${taskIds.length} referenced).`);

    // 4. Reconcile
    let totalFixed = 0;
    const projectsWithCurrentDone = new Set();

    for (const row of versionRes.rows) {
      const items = row.items || [];
      let rowChanged = false;

      for (const item of items) {
        if (!item.taskId) continue;
        const taskStatus = taskStatusMap.get(item.taskId);
        if (taskStatus === undefined) continue; // task not found — skip

        const shouldBeDone = taskStatus === 'done';
        if (item.done !== shouldBeDone) {
          const wasDone = item.done;
          item.done = shouldBeDone;
          rowChanged = true;
          totalFixed++;
          console.log(
            `  FIX: ${row.project_id} v${row.version} — "${item.title}" done: ${wasDone} → ${shouldBeDone} (task ${item.taskId} is ${taskStatus})`,
          );
        }
      }

      if (rowChanged) {
        await client.query(
          `UPDATE org_studio_roadmap_versions SET items = $1 WHERE id = $2`,
          [JSON.stringify(items), row.id],
        );
      }

      // Track if a current version is now fully done
      if (row.status === 'current' && items.length > 0 && items.every(i => i.done === true)) {
        projectsWithCurrentDone.add(row.project_id);
      }
    }

    console.log(`\nReconciliation complete: ${totalFixed} item(s) fixed.`);

    // 5. Auto-advance for any projects whose current version is now fully done
    for (const projectId of projectsWithCurrentDone) {
      console.log(`\nChecking auto-advance for ${projectId}...`);
      await autoAdvance(client, projectId);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

/**
 * Inline auto-advance logic (mirrors checkAndAutoAdvance from roadmap-sync.ts
 * but works standalone without importing TypeScript modules).
 */
async function autoAdvance(client, projectId) {
  try {
    // Find current version
    const vr = await client.query(
      `SELECT id, version, status, items, sort_order
       FROM org_studio_roadmap_versions
       WHERE project_id = $1 AND status = 'current'
       ORDER BY sort_order ASC LIMIT 1`,
      [projectId],
    );
    if (vr.rows.length === 0) return;
    const current = vr.rows[0];
    const items = current.items || [];
    if (items.length === 0 || !items.every(i => i.done === true)) return;

    // Ship it
    const shippedAt = Date.now();
    await client.query(
      `UPDATE org_studio_roadmap_versions SET status = 'shipped', shipped_at = $1 WHERE id = $2`,
      [String(shippedAt), current.id],
    );
    console.log(`[AutoAdvance] ${projectId}: v${current.version} shipped`);

    // Read project autonomy
    const pr = await client.query(
      `SELECT data FROM org_studio_projects WHERE id = $1`,
      [projectId],
    );
    if (pr.rows.length === 0) return;
    const projData = typeof pr.rows[0].data === 'string'
      ? JSON.parse(pr.rows[0].data)
      : pr.rows[0].data || {};
    const autonomy = projData.autonomy || {};
    const autoAdv = autonomy.autoAdvance === true;
    const approvedThrough = autonomy.approvedThrough;

    if (!autoAdv) {
      console.log(`[AutoAdvance] auto-advance disabled for ${projectId} — v${current.version} shipped, manual launch required`);
      return;
    }

    // Find next planned
    const nr = await client.query(
      `SELECT id, version, status, items, sort_order
       FROM org_studio_roadmap_versions
       WHERE project_id = $1 AND status = 'planned' AND sort_order > $2
       ORDER BY sort_order ASC LIMIT 1`,
      [projectId, current.sort_order],
    );
    if (nr.rows.length === 0) {
      console.log(`[AutoAdvance] ${projectId}: v${current.version} shipped → no next planned version`);
      return;
    }
    const next = nr.rows[0];

    // Approval gating
    if (approvedThrough) {
      if (parseFloat(next.version) > parseFloat(approvedThrough)) {
        console.log(`[AutoAdvance] ${projectId}: approval required for v${next.version} (approvedThrough=${approvedThrough}) — manual launch needed`);
        return;
      }
    } else {
      console.log(`[AutoAdvance] ${projectId}: no approvedThrough set — manual launch needed for v${next.version}`);
      return;
    }

    // Check all items have taskIds
    const nextItems = next.items || [];
    const draftItems = nextItems.filter(i => !i.taskId);
    if (draftItems.length > 0) {
      console.log(`[AutoAdvance] ${projectId}: v${next.version} has ${draftItems.length} item(s) without taskId — manual launch needed`);
      return;
    }

    // Launch
    await client.query(
      `UPDATE org_studio_roadmap_versions SET status = 'current' WHERE id = $1`,
      [next.id],
    );

    // Move tasks planning → backlog
    let movedCount = 0;
    const devOwner = projData.devOwner || '';
    for (const item of nextItems) {
      if (!item.taskId) continue;
      const tr = await client.query(
        `SELECT id, status FROM org_studio_tasks WHERE id = $1`,
        [item.taskId],
      );
      if (tr.rows.length > 0 && tr.rows[0].status === 'planning') {
        await client.query(
          `UPDATE org_studio_tasks
           SET status = 'backlog', version = $1, assignee = COALESCE(NULLIF(assignee, ''), $2)
           WHERE id = $3`,
          [next.version, devOwner, item.taskId],
        );
        movedCount++;
      }
    }

    // Update project currentVersion
    projData.currentVersion = next.version;
    await client.query(
      `UPDATE org_studio_projects SET data = $1 WHERE id = $2`,
      [JSON.stringify(projData), projectId],
    );

    console.log(`[AutoAdvance] ${projectId}: v${current.version} shipped → v${next.version} launched (${movedCount} tasks moved planning→backlog)`);
  } catch (err) {
    console.error(`[AutoAdvance] error for ${projectId}:`, err?.message || err);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
