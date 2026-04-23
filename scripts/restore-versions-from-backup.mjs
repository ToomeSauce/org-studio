#!/usr/bin/env node
/**
 * scripts/restore-versions-from-backup.mjs
 *
 * Incident recovery: the strip-shadow-keys migration (run 2026-04-23 ~11:04 UTC)
 * removed `data.version` from 949 tasks, but it turns out `data.version` was the
 * actual source of truth — the typed `version` column had been NULL for most
 * rows because the original reconstructor merge order (`{...typed, ...overflow}`)
 * made `data.version` the effective winner for years.
 *
 * This script:
 *   1. Reads the pre-migration backup
 *   2. For each task, if the `version` column is currently NULL and the backup
 *      has `data.version`, writes that value into the typed `version` column.
 *
 * Net effect: tasks get their version back, stored in the correct column.
 * The reconstructor code fix (typed columns override overflow) stays —
 * future writes will use the column as source of truth.
 *
 * Usage:
 *   node scripts/restore-versions-from-backup.mjs        # dry run
 *   node scripts/restore-versions-from-backup.mjs --apply
 */

import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DRY_RUN = !process.argv.includes('--apply');
const BACKUP_PATH = path.join(
  __dirname, '..', 'backups',
  'pre-strip-shadow-keys-2026-04-23T11-04-11-056Z.json'
);

async function main() {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const m = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
      if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  if (!process.env.DATABASE_URL) { console.error('❌ DATABASE_URL not set'); process.exit(1); }
  if (!fs.existsSync(BACKUP_PATH)) { console.error('❌ Backup not found:', BACKUP_PATH); process.exit(1); }

  console.log(DRY_RUN ? '🔍 DRY RUN — pass --apply to execute\n' : '⚡ APPLYING\n');

  const backup = JSON.parse(fs.readFileSync(BACKUP_PATH, 'utf8'));
  const backupMap = new Map();
  for (const t of backup.tasks || []) {
    if (t.data && t.data.version) backupMap.set(t.id, t.data.version);
  }
  console.log(`📦 Backup has ${backupMap.size} tasks with data.version\n`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    const current = await client.query(
      'SELECT id, version FROM org_studio_tasks'
    );

    let toRestore = 0;
    let alreadySet = 0;
    let notInBackup = 0;
    let skipConflict = 0;
    const verDist = {};

    for (const row of current.rows) {
      const backupV = backupMap.get(row.id);
      if (!backupV) { notInBackup++; continue; }
      if (row.version && row.version === backupV) { alreadySet++; continue; }
      if (row.version && row.version !== backupV) {
        // Column already has a different (fresh) value — don't overwrite
        skipConflict++;
        continue;
      }
      // row.version is null, backup has a value → restore
      toRestore++;
      verDist[backupV] = (verDist[backupV] || 0) + 1;
      if (!DRY_RUN) {
        await client.query(
          'UPDATE org_studio_tasks SET version = $1, updated_at = NOW() WHERE id = $2',
          [backupV, row.id]
        );
      }
    }

    console.log(`📋 Summary:`);
    console.log(`   To restore:     ${toRestore}`);
    console.log(`   Already set:    ${alreadySet}`);
    console.log(`   Not in backup:  ${notInBackup}  (tasks created after the backup, or never had a version)`);
    console.log(`   Skipped (col has different value): ${skipConflict}`);

    if (toRestore > 0) {
      console.log(`\n   Version distribution (top 15):`);
      const sorted = Object.entries(verDist).sort((a, b) => b[1] - a[1]).slice(0, 15);
      for (const [v, n] of sorted) console.log(`     ${v.padEnd(12)} ${n}`);
    }

    console.log('\n─────────────────────────────────────────────');
    console.log(DRY_RUN ? '✅ Dry run complete. Run with --apply.' : '✅ Restored.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error('❌', e.message); console.error(e.stack); process.exit(1); });
