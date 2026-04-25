#!/usr/bin/env node
/**
 * hydrate-component-versions.mjs
 *
 * One-shot data fix for #1112 PR 6 incomplete migration.
 *
 * Problem
 * -------
 * PR 5/6 introduced per-component roadmaps via `component.versions[]` inside
 * `org_studio_projects.data` jsonb. The migration created stub Main components
 * but never copied the rich roadmap rows already living in the dedicated
 * `org_studio_roadmap_versions` table. Result: UI reads `component.versions[]`
 * and finds 1 stub instead of the 27 real versions sitting in the rv table.
 *
 * Symptom Basil reported: "Thrivor project has no QA version displaying anymore."
 * Real scope: 9 active projects with drift; ~790 roadmap items unreachable from UI;
 * 376 tasks with `version: null` despite linked roadmap items.
 *
 * Fix
 * ---
 * 1. For every non-archived project, copy the project's `org_studio_roadmap_versions`
 *    rows into the primary component's `versions[]` (primary = no role, or role !==
 *    'qa'/'support'). Preserve item ids, taskIds, status, sort_order, version_type.
 * 2. For Thrivor specifically: the QA component (sec-lbckedr6) gets a *parallel*
 *    versions[] mirroring Main but with status='planned' (Billy validates each
 *    version after it ships).
 * 3. Backfill `task.version` from `version.items[].taskId` linkage. Only writes
 *    when current value is null — skips conflicts.
 *
 * Safety
 * ------
 * - Pre-migration backup of org_studio_projects + org_studio_tasks data jsonb to
 *   /backups/pre-hydrate-{ts}.json
 * - Idempotent: re-runs are no-ops once drift is closed.
 * - Dry-run by default. Pass --apply to actually write.
 *
 * Usage
 * -----
 *   node scripts/hydrate-component-versions.mjs           # dry-run
 *   node scripts/hydrate-component-versions.mjs --apply   # commit
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

if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

function isPrimary(comp) {
  if (!comp.role) return true;
  const r = String(comp.role).toLowerCase();
  return r !== 'qa' && r !== 'support';
}

async function main() {
  const client = await pool.connect();
  try {
    console.log(APPLY ? '🔧 APPLY mode — writes will be committed' : '🔍 DRY-RUN mode — no writes');
    console.log('');

    // ---- Backup ----
    const backupDir = path.resolve('backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `pre-hydrate-${ts}.json`);

    const projDump = await client.query(
      `SELECT id, name, data FROM org_studio_projects WHERE workspace_id = $1`,
      [WORKSPACE]
    );
    const taskDump = await client.query(
      `SELECT id, project_id, version, data FROM org_studio_tasks WHERE workspace_id = $1 AND version IS NULL`,
      [WORKSPACE]
    );
    const rvDump = await client.query(
      `SELECT * FROM org_studio_roadmap_versions WHERE workspace_id = $1`,
      [WORKSPACE]
    );
    fs.writeFileSync(backupPath, JSON.stringify({
      ts: Date.now(),
      projects: projDump.rows,
      tasksWithNullVersion: taskDump.rows,
      roadmapVersions: rvDump.rows,
    }, null, 2));
    console.log(`📦 Backup written: ${backupPath} (${projDump.rows.length} projects, ${taskDump.rows.length} null-version tasks, ${rvDump.rows.length} rv rows)`);
    console.log('');

    // ---- Build rv-table index by project ----
    const rvByProject = new Map();
    for (const row of rvDump.rows) {
      if (!rvByProject.has(row.project_id)) rvByProject.set(row.project_id, []);
      rvByProject.get(row.project_id).push(row);
    }
    // Sort each project's versions by sort_order then version
    for (const [, list] of rvByProject) {
      list.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.version.localeCompare(b.version));
    }

    // ---- Pass 1: hydrate component.versions[] ----
    console.log('=== Pass 1: hydrate component.versions[] ===');
    let projectsUpdated = 0;
    let totalVersionsHydrated = 0;
    let totalQaVersionsCloned = 0;

    for (const projRow of projDump.rows) {
      const data = typeof projRow.data === 'string' ? JSON.parse(projRow.data) : (projRow.data || {});
      if (data.isArchived) continue;

      const secs = data.components || data.sections || [];
      if (!secs.length) continue;

      const rvList = rvByProject.get(projRow.id) || [];
      if (!rvList.length) continue;

      // Convert rv rows → component.versions[] shape
      const hydratedVersions = rvList.map(rv => ({
        id: rv.id,
        version: rv.version,
        status: rv.status,
        items: Array.isArray(rv.items) ? rv.items : (rv.items ? JSON.parse(rv.items) : []),
        sort_order: rv.sort_order ?? undefined,
        version_type: rv.version_type || 'outcome',
        title: rv.title,
        shipped_at: rv.shipped_at ?? undefined,
        createdAt: rv.created_at ?? undefined,
      }));

      // Find primary component
      let mutated = false;
      const newSecs = secs.map(s => {
        if (isPrimary(s)) {
          const before = (s.versions || []).length;
          if (before < hydratedVersions.length) {
            mutated = true;
            return { ...s, versions: hydratedVersions };
          }
        }
        return s;
      });

      // Special handling: Thrivor QA component mirrors Main but planned
      if (projRow.id === 'zrrt51fgmn578ujz') {
        const qaIdx = newSecs.findIndex(s => s.id === 'sec-lbckedr6');
        if (qaIdx >= 0 && (!newSecs[qaIdx].versions || newSecs[qaIdx].versions.length === 0)) {
          // Clone Main's versions, mark all as 'planned' (Billy validates after Main ships)
          // Items are pruned (QA tickets are tracked as separate tasks linked via roadmapItemId)
          const qaVersions = hydratedVersions.map(v => ({
            id: `${v.id}-qa`,
            version: v.version,
            status: 'planned',
            items: [],
            sort_order: v.sort_order,
            version_type: v.version_type,
            title: v.title,
          }));
          newSecs[qaIdx] = { ...newSecs[qaIdx], versions: qaVersions };
          totalQaVersionsCloned += qaVersions.length;
          mutated = true;
        }
      }

      if (mutated) {
        const newData = { ...data };
        if (data.components) newData.components = newSecs;
        else newData.sections = newSecs;

        console.log(`  ${projRow.name.padEnd(36)} → hydrated ${hydratedVersions.length} versions onto primary component`);
        totalVersionsHydrated += hydratedVersions.length;
        projectsUpdated++;

        if (APPLY) {
          await client.query(
            `UPDATE org_studio_projects SET data = $1 WHERE id = $2 AND workspace_id = $3`,
            [JSON.stringify(newData), projRow.id, WORKSPACE]
          );
        }
      }
    }
    console.log(`  → ${projectsUpdated} projects updated, ${totalVersionsHydrated} versions hydrated, ${totalQaVersionsCloned} QA versions cloned`);
    console.log('');

    // ---- Pass 2: backfill task.version ----
    console.log('=== Pass 2: backfill task.version from rv items[].taskId ===');
    const linkRes = await client.query(`
      SELECT t.id AS task_id, t.version AS current_version, v.version AS rv_version, it->>'id' AS item_id
      FROM org_studio_roadmap_versions v, jsonb_array_elements(v.items) it
      JOIN org_studio_tasks t ON t.id = it->>'taskId' AND t.workspace_id = $1
      WHERE v.workspace_id = $1
        AND it->>'taskId' IS NOT NULL AND it->>'taskId' <> ''
    `, [WORKSPACE]);

    let backfilled = 0;
    let conflicts = 0;
    let already = 0;

    for (const link of linkRes.rows) {
      if (!link.current_version) {
        if (APPLY) {
          await client.query(
            `UPDATE org_studio_tasks SET version = $1 WHERE id = $2 AND workspace_id = $3`,
            [link.rv_version, link.task_id, WORKSPACE]
          );
        }
        backfilled++;
      } else if (link.current_version !== link.rv_version) {
        conflicts++;
        console.log(`  ⚠️  conflict: task ${link.task_id} has version=${link.current_version}, rv says ${link.rv_version}`);
      } else {
        already++;
      }
    }
    console.log(`  → ${backfilled} tasks backfilled, ${already} already correct, ${conflicts} conflicts skipped`);
    console.log('');

    // ---- Verification (post-state) ----
    if (APPLY) {
      const verify = await client.query(`
        SELECT t.id, t.version
        FROM org_studio_roadmap_versions v, jsonb_array_elements(v.items) it
        JOIN org_studio_tasks t ON t.id = it->>'taskId' AND t.workspace_id = $1
        WHERE v.workspace_id = $1
          AND it->>'taskId' IS NOT NULL AND it->>'taskId' <> ''
          AND t.version IS NULL
      `, [WORKSPACE]);
      console.log(`✅ Post-fix: ${verify.rows.length} tasks still have null version (should be 0)`);
    }

    if (!APPLY) {
      console.log('');
      console.log('Re-run with --apply to commit.');
    } else {
      console.log('');
      console.log('🎉 Done.');
    }

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
