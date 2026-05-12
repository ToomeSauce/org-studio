#!/usr/bin/env node
/**
 * Migrate semver in:
 *   1. org_studio_roadmap_versions.version (Postgres table)
 *   2. org_studio_projects.data.approvedThrough (missed by migrate-semver.mjs
 *      which only looked under project.autonomy.approvedThrough)
 *
 * Idempotent. Safe to re-run. Backs up affected rows first.
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

const DRY_RUN = process.argv.includes('--dry-run');

const SEMVER_MAP = {
  '0.1': '0.1.0', '0.2': '0.2.0', '0.3': '0.3.0', '0.4': '0.4.0',
  '0.5': '0.5.0', '0.6': '0.6.0', '0.7': '0.7.0', '0.8': '0.8.0',
  '0.9': '0.9.0', '0.10': '0.10.0', '0.11': '0.11.0', '0.12': '0.12.0',
  '0.13': '0.13.0', '0.14': '0.14.0', '0.141': '0.14.1', '0.15': '0.15.0',
  '0.16': '0.16.0', '0.51': '0.51.0',
  '0.81': '0.81.0', '0.82': '0.82.0', '0.83': '0.83.0', '0.84': '0.84.0',
  '0.85': '0.85.0', '0.86': '0.86.0', '0.87': '0.87.0', '0.88': '0.88.0',
  '0.89': '0.89.0',
  '0.90': '0.90.0', '0.91': '0.91.0', '0.92': '0.92.0',
  '0.901': '0.901.0', '0.902': '0.902.0', '0.903': '0.903.0',
  '0.904': '0.904.0', '0.905': '0.905.0', '0.906': '0.906.0',
  '0.907': '0.907.0', '0.908': '0.908.0', '0.909': '0.909.0',
  '0.910': '0.910.0', '0.911': '0.911.0',
  '0.9015': '0.9015.0',
  '1.0': '1.0.0', '1.01': '1.01.0', '1.02': '1.02.0', '1.03': '1.03.0',
  '1.04': '1.04.0', '1.05': '1.05.0', '1.06': '1.06.0', '1.07': '1.07.0',
  '1.08': '1.08.0', '1.09': '1.09.0',
  '1.1': '1.1.0', '1.10': '1.10.0', '1.11': '1.11.0',
  '1.2': '1.2.0', '1.3': '1.3.0',
  '2.0': '2.0.0', '3.0': '3.0.0',
};

function isSemver(v) {
  return /^\d+\.\d+\.\d+$/.test(v || '');
}

function migrate(v) {
  if (!v) return null;
  if (isSemver(v)) return v;
  const stripped = String(v).replace(/^v/, '');
  return SEMVER_MAP[stripped] || SEMVER_MAP[v] || null;
}

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(__dirname, '..', 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  console.log(`\n[semver migration part 2] ${DRY_RUN ? '(DRY RUN)' : ''}`);
  console.log('='.repeat(70));

  // 1. ROADMAP TABLE
  console.log('\n[1/2] org_studio_roadmap_versions');
  const roadmapRes = await pool.query(
    `SELECT id, project_id, version FROM org_studio_roadmap_versions ORDER BY project_id, version`
  );
  console.log(`  Found ${roadmapRes.rows.length} rows`);

  const roadmapBackup = path.join(backupDir, `pre-roadmap-semver-${timestamp}.json`);
  fs.writeFileSync(roadmapBackup, JSON.stringify(roadmapRes.rows, null, 2));
  console.log(`  Backup: ${roadmapBackup}`);

  const roadmapPlan = [];
  const unmapped = new Set();
  for (const r of roadmapRes.rows) {
    const newV = migrate(r.version);
    if (!newV) { unmapped.add(r.version); continue; }
    if (newV !== r.version) {
      roadmapPlan.push({ id: r.id, pid: r.project_id, old: r.version, new: newV });
    }
  }

  if (unmapped.size > 0) {
    console.error(`  ERROR: Unmapped versions: ${[...unmapped].join(', ')}`);
    process.exit(1);
  }

  console.log(`  Will update ${roadmapPlan.length} rows`);
  roadmapPlan.slice(0, 15).forEach(p =>
    console.log(`    ${p.pid.padEnd(22)} ${p.old.padEnd(8)} -> ${p.new}`)
  );
  if (roadmapPlan.length > 15) console.log(`    ...and ${roadmapPlan.length - 15} more`);

  if (!DRY_RUN && roadmapPlan.length > 0) {
    // Check for collisions
    for (const p of roadmapPlan) {
      const coll = await pool.query(
        `SELECT id FROM org_studio_roadmap_versions WHERE project_id = $1 AND version = $2 AND id != $3`,
        [p.pid, p.new, p.id]
      );
      if (coll.rows.length > 0) {
        console.error(`  COLLISION: ${p.pid} ${p.new} exists (row ${coll.rows[0].id})`);
        process.exit(1);
      }
    }

    console.log('  Applying updates...');
    for (const p of roadmapPlan) {
      await pool.query(
        `UPDATE org_studio_roadmap_versions SET version = $1 WHERE id = $2`,
        [p.new, p.id]
      );
    }
    console.log(`  OK: Updated ${roadmapPlan.length} rows`);
  }

  // 2. approvedThrough in org_studio_projects.data
  console.log('\n[2/2] org_studio_projects.data->>approvedThrough');
  const projRes = await pool.query(
    `SELECT id, name, data FROM org_studio_projects WHERE data ? 'approvedThrough'`
  );
  console.log(`  Found ${projRes.rows.length} projects with approvedThrough`);

  const approvedBackup = path.join(backupDir, `pre-approvedThrough-semver-${timestamp}.json`);
  fs.writeFileSync(approvedBackup, JSON.stringify(projRes.rows, null, 2));
  console.log(`  Backup: ${approvedBackup}`);

  const approvedPlan = [];
  for (const row of projRes.rows) {
    const cur = row.data?.approvedThrough;
    if (!cur) continue;
    const newV = migrate(cur);
    if (!newV) {
      console.warn(`    WARN: ${row.id} approvedThrough unmappable: ${cur}`);
      continue;
    }
    if (newV !== cur) {
      approvedPlan.push({ id: row.id, old: cur, new: newV, data: row.data });
    }
  }

  console.log(`  Will update ${approvedPlan.length} project(s)`);
  approvedPlan.forEach(p =>
    console.log(`    ${p.id.padEnd(22)} ${p.old.padEnd(8)} -> ${p.new}`)
  );

  if (!DRY_RUN && approvedPlan.length > 0) {
    for (const p of approvedPlan) {
      const newData = { ...p.data, approvedThrough: p.new };
      await pool.query(
        `UPDATE org_studio_projects SET data = $1 WHERE id = $2`,
        [newData, p.id]
      );
    }
    console.log(`  OK: Updated ${approvedPlan.length} project(s)`);
  }

  console.log('\nDone.');
  await pool.end();
}

// #1312 guard: only auto-run when invoked as a script. When imported by
// another module (e.g. server.mjs), do NOT trigger main() — let the
// caller decide. Prevents one Postgres hiccup from killing the dashboard.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('\nERROR:', err);
    pool.end();
    process.exit(1);
  });
}
