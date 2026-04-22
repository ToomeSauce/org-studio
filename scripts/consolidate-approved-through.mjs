#!/usr/bin/env node
/**
 * Consolidate approvedThrough: move top-level project.approvedThrough into
 * project.autonomy.approvedThrough (which is what the app actually reads).
 *
 * Leaves top-level field alone for backward-compat read paths; future writes
 * go to the nested location only.
 *
 * Idempotent. Safe to re-run.
 */

import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(__dirname, '..', 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  console.log(`\n[consolidate approvedThrough] ${DRY_RUN ? '(DRY RUN)' : ''}`);
  console.log('='.repeat(70));

  const res = await pool.query(
    `SELECT id, name, data FROM org_studio_projects WHERE data ? 'approvedThrough'`
  );
  console.log(`Found ${res.rows.length} projects with top-level approvedThrough`);

  const backup = path.join(backupDir, `pre-consolidate-approved-${timestamp}.json`);
  fs.writeFileSync(backup, JSON.stringify(res.rows, null, 2));
  console.log(`Backup: ${backup}`);

  const plan = [];
  for (const row of res.rows) {
    const top = row.data?.approvedThrough;
    const nested = row.data?.autonomy?.approvedThrough;
    if (top == null) continue;
    if (nested === top) continue; // already consolidated
    plan.push({ id: row.id, top, nested, data: row.data });
  }

  console.log(`Will update ${plan.length} project(s):`);
  plan.forEach(p =>
    console.log(`  ${p.id.padEnd(22)} top=${p.top}  nested=${p.nested ?? '(null)'} -> nested=${p.top}`)
  );

  if (!DRY_RUN && plan.length > 0) {
    for (const p of plan) {
      const newData = {
        ...p.data,
        autonomy: {
          ...(p.data.autonomy || {}),
          approvedThrough: p.top,
        },
      };
      await pool.query(
        `UPDATE org_studio_projects SET data = $1 WHERE id = $2`,
        [newData, p.id]
      );
    }
    console.log(`OK: Updated ${plan.length} project(s)`);
  }

  console.log('\nDone.');
  await pool.end();
}

main().catch(err => { console.error('ERROR:', err); pool.end(); process.exit(1); });
