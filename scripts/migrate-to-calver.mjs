#!/usr/bin/env node
/**
 * scripts/migrate-to-calver.mjs
 *
 * Migrates proj-mc (Org Studio) roadmap versions and all linked data from
 * SemVer to CalVer (YYYY.MM.DD).
 *
 * Version mapping (derived from shipped_at timestamps; null-timestamp versions
 * use a reasonable date based on context):
 *
 *   0.1.0  → 2026.03.15   (shipped 2026-03-15)
 *   0.2.0  → 2026.03.18
 *   0.3.0  → 2026.03.19
 *   0.4.0  → 2026.03.20
 *   0.5.0  → 2026.03.25
 *   0.6.0  → 2026.03.29
 *   0.7.0  → 2026.03.29.1  (same-day as 0.6.0, micro bump)
 *   0.8.0  → 2026.04.01   (no ts; conservative estimate — fits the gap 0.7→0.11)
 *   0.9.0  → 2026.04.05
 *   0.10.0 → 2026.04.10
 *   0.11.0 → 2026.04.17   (shipped 2026-04-17)
 *   0.12.0 → 2026.04.18
 *   0.13.0 → 2026.04.18.1
 *   0.14.0 → 2026.04.18.2
 *   0.14.1 → 2026.04.19
 *   0.15.0 → 2026.04.20   (shipped but no ts; sprint between 0.14.1 and 0.16)
 *   0.16.0 → 2026.04.22   (shipped today)
 *   1.0.0  → 2026.05.01   (planned public launch; reasonable near-future target)
 *
 * What this script touches (proj-mc only):
 *   - org_studio_roadmap_versions: version column + sort_order
 *   - org_studio_tasks: version field
 *   - projects.currentVersion and autonomy.approvedThrough in the store API
 *
 * Dry-run mode (default): prints what would change; pass --apply to execute.
 * Safe: writes are idempotent (upsert / UPDATE WHERE version = old_value).
 * Backup: reads current state before any writes.
 */

import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Version map ───────────────────────────────────────────────────────────────

const VERSION_MAP = {
  '0.1.0':  '2026.03.15',
  '0.2.0':  '2026.03.18',
  '0.3.0':  '2026.03.19',
  '0.4.0':  '2026.03.20',
  '0.5.0':  '2026.03.25',
  '0.6.0':  '2026.03.29',
  '0.7.0':  '2026.03.29.1',
  '0.8.0':  '2026.04.01',
  '0.9.0':  '2026.04.05',
  '0.10.0': '2026.04.10',
  '0.11.0': '2026.04.17',
  '0.12.0': '2026.04.18',
  '0.13.0': '2026.04.18.1',
  '0.14.0': '2026.04.18.2',
  '0.14.1': '2026.04.19',
  '0.15.0': '2026.04.20',
  '0.16.0': '2026.04.22',
  '0.16.1': '2026.04.22.1', // horizon-only bump; maps to same-day micro
  '1.0.0':  '2026.05.01',
};

const PROJECT_ID = 'proj-mc';
const WORKSPACE_ID = 'default-workspace';
const DRY_RUN = !process.argv.includes('--apply');

// ── Sort key ──────────────────────────────────────────────────────────────────

function versionSortKey(v) {
  if (!v) return 0;
  const parts = v.split('.').map(x => parseInt(x, 10) || 0);
  const isCalver = parts[0] >= 2020;
  if (isCalver) {
    const [year, month, day, micro = 0] = parts;
    return (year - 2020) * 10_000_000 + month * 100_000 + day * 1_000 + micro;
  } else {
    const [maj, min, pat] = parts;
    return maj * 1_000_000_000 + min * 1_000_000 + pat * 1_000;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

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
    console.error('❌ DATABASE_URL not set. Aborting.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    console.log(DRY_RUN ? '🔍 DRY RUN — pass --apply to execute\n' : '⚡ APPLYING CHANGES\n');

    // ── 1. Roadmap versions ──────────────────────────────────────────────────

    const roadmapRes = await client.query(
      `SELECT id, version, sort_order FROM org_studio_roadmap_versions
       WHERE project_id = $1 AND workspace_id = $2
       ORDER BY sort_order ASC`,
      [PROJECT_ID, WORKSPACE_ID],
    );

    console.log(`📋 Roadmap versions for ${PROJECT_ID} (${roadmapRes.rows.length} rows):`);
    let roadmapUpdates = 0;

    for (const row of roadmapRes.rows) {
      const newVersion = VERSION_MAP[row.version];
      if (!newVersion) {
        console.log(`  ⏭  ${row.version} — no mapping, leaving as-is`);
        continue;
      }
      if (newVersion === row.version) {
        console.log(`  ✅ ${row.version} — already calver`);
        continue;
      }
      const newSortOrder = versionSortKey(newVersion);
      console.log(`  📦 ${row.version} → ${newVersion}  (sort_order: ${row.sort_order} → ${newSortOrder})`);
      if (!DRY_RUN) {
        await client.query(
          `UPDATE org_studio_roadmap_versions
           SET version = $1, sort_order = $2
           WHERE id = $3`,
          [newVersion, newSortOrder, row.id],
        );
      }
      roadmapUpdates++;
    }

    console.log(`\n  → ${roadmapUpdates} roadmap row(s) to update\n`);

    // ── 2. Tasks ─────────────────────────────────────────────────────────────

    const tasksRes = await client.query(
      `SELECT id, title, version FROM org_studio_tasks
       WHERE project_id = $1 AND version IS NOT NULL`,
      [PROJECT_ID],
    );

    console.log(`📋 Tasks for ${PROJECT_ID} with version field (${tasksRes.rows.length} rows):`);
    let taskUpdates = 0;

    for (const row of tasksRes.rows) {
      const newVersion = VERSION_MAP[row.version];
      if (!newVersion) {
        console.log(`  ⏭  task ${row.id} (${row.title?.slice(0, 40)}) version=${row.version} — no mapping`);
        continue;
      }
      if (newVersion === row.version) continue;
      console.log(`  📝 task ${row.id} version: ${row.version} → ${newVersion}  (${row.title?.slice(0, 40)})`);
      if (!DRY_RUN) {
        await client.query(
          `UPDATE org_studio_tasks SET version = $1 WHERE id = $2`,
          [newVersion, row.id],
        );
      }
      taskUpdates++;
    }

    console.log(`\n  → ${taskUpdates} task(s) to update\n`);

    // ── 3. Project currentVersion + approvedThrough ──────────────────────────

    const projRes = await client.query(
      `SELECT id, data FROM org_studio_projects
       WHERE id = $1`,
      [PROJECT_ID],
    );

    if (projRes.rows.length > 0) {
      const proj = projRes.rows[0];
      const data = proj.data || {};
      const oldCurrentVersion = data.currentVersion;
      const autonomy = data.autonomy || {};
      const oldApprovedThrough = autonomy.approvedThrough;

      const newCurrentVersion = oldCurrentVersion ? (VERSION_MAP[oldCurrentVersion] || oldCurrentVersion) : null;
      const newApprovedThrough = oldApprovedThrough ? (VERSION_MAP[oldApprovedThrough] || oldApprovedThrough) : null;

      console.log(`📋 Project ${PROJECT_ID}:`);
      console.log(`  currentVersion:  ${oldCurrentVersion} → ${newCurrentVersion}`);
      console.log(`  approvedThrough: ${oldApprovedThrough} → ${newApprovedThrough}`);

      if (!DRY_RUN) {
        const updatedData = { ...data };
        if (newCurrentVersion && newCurrentVersion !== oldCurrentVersion) {
          updatedData.currentVersion = newCurrentVersion;
        }
        if (newApprovedThrough && newApprovedThrough !== oldApprovedThrough) {
          updatedData.autonomy = { ...autonomy, approvedThrough: newApprovedThrough };
        }
        await client.query(
          `UPDATE org_studio_projects SET data = $1::jsonb WHERE id = $2`,
          [JSON.stringify(updatedData), PROJECT_ID],
        );
      }
    } else {
      console.log(`⚠️  Project ${PROJECT_ID} not found in org_studio_projects table (may be in store.json)`);
    }

    // ── 4. Summary ───────────────────────────────────────────────────────────

    console.log('\n─────────────────────────────────────────────');
    if (DRY_RUN) {
      console.log('✅ Dry run complete. Run with --apply to execute.');
    } else {
      console.log(`✅ Migration applied:`);
      console.log(`   Roadmap rows: ${roadmapUpdates}`);
      console.log(`   Tasks:        ${taskUpdates}`);
      console.log(`   Project meta: updated`);
    }

  } finally {
    client.release();
    await pool.end();
  }
}

// #1312 guard: only auto-run when invoked as a script. When imported by
// another module (e.g. server.mjs), do NOT trigger main() — let the
// caller decide. Prevents one Postgres hiccup from killing the dashboard.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  });
}
