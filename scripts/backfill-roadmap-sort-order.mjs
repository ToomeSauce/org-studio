#!/usr/bin/env node
/**
 * Backfill roadmap version sort_order to semver-aware keys.
 *
 * Problem: sort_order was populated inconsistently across migration eras.
 * - Pre-semver: values like 1.1, 2, 3 (effectively parseFloat(version))
 * - Post-semver: big integer keys via versionSortKey() e.g. 1012000000
 * - Result: 2.0.0 (sort=2) sorted BEFORE 1.12.0 (sort=1012000000)
 *
 * Fix: Recompute sort_order for ALL rows using versionSortKey().
 *   sort_order = major*1_000_000_000 + minor*1_000_000 + patch*1_000
 *
 * Idempotent. Creates a backup first. Writes a per-row report.
 */

import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';

// Load .env.local manually (same pattern other scripts use)
try {
  const envPath = path.join(process.cwd(), '.env.local');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
      if (m && !process.env[m[1]]) {
        let val = m[2];
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        process.env[m[1]] = val;
      }
    }
  }
} catch {}

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

function normalizeVersion(v) {
  if (!v) return null;
  const s = String(v).trim().replace(/^v/i, '');
  // Already a valid semver
  if (semver.valid(s)) return s;
  // Two-part "0.14" -> "0.14.0"
  const m2 = s.match(/^(\d+)\.(\d+)$/);
  if (m2) return `${m2[1]}.${m2[2]}.0`;
  // Single part "2" -> "2.0.0"
  const m1 = s.match(/^(\d+)$/);
  if (m1) return `${m1[1]}.0.0`;
  // Legacy floats like "0.141" -> "0.14.1"
  const m = s.match(/^(\d+)\.(\d+)$/);
  if (m && m[2].length >= 2) {
    const minor = m[2].slice(0, -1);
    const patch = m[2].slice(-1);
    return `${m[1]}.${minor}.${patch}`;
  }
  return s;
}

function versionSortKey(version) {
  const n = normalizeVersion(version);
  if (!n) return 0;
  try {
    const [maj, min, pat] = n.split('.').map(x => parseInt(x, 10) || 0);
    return maj * 1_000_000_000 + min * 1_000_000 + pat * 1_000;
  } catch {
    return 0;
  }
}

const pool = new Pool({ connectionString: DATABASE_URL });

async function main() {
  console.log('[backfill-sort-order] Starting…');
  const client = await pool.connect();

  try {
    // 1. Backup current state
    const backupDir = path.join(process.cwd(), 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `pre-backfill-sort-order-${ts}.json`);

    const { rows: current } = await client.query(
      `SELECT id, project_id, version, sort_order FROM org_studio_roadmap_versions ORDER BY project_id, version`
    );
    fs.writeFileSync(backupPath, JSON.stringify(current, null, 2));
    console.log(`[backfill-sort-order] Backup: ${backupPath} (${current.length} rows)`);

    // 2. Compute new sort_order values
    const updates = [];
    const changes = [];
    for (const row of current) {
      const newSort = versionSortKey(row.version);
      // Only update if different (tolerate float drift)
      const old = row.sort_order == null ? null : Number(row.sort_order);
      if (old !== newSort) {
        updates.push({ id: row.id, version: row.version, project_id: row.project_id, old, new: newSort });
      }
    }

    console.log(`[backfill-sort-order] Rows needing update: ${updates.length} / ${current.length}`);

    if (updates.length === 0) {
      console.log('[backfill-sort-order] Already consistent. Nothing to do.');
      return;
    }

    // 3. Apply in a transaction
    await client.query('BEGIN');
    let applied = 0;
    for (const u of updates) {
      await client.query(
        `UPDATE org_studio_roadmap_versions SET sort_order = $1 WHERE id = $2`,
        [u.new, u.id]
      );
      applied++;
    }
    await client.query('COMMIT');

    console.log(`[backfill-sort-order] ✅ Applied ${applied} updates`);

    // 4. Per-project summary
    const byProject = new Map();
    for (const u of updates) {
      if (!byProject.has(u.project_id)) byProject.set(u.project_id, []);
      byProject.get(u.project_id).push(u);
    }
    console.log('\n[backfill-sort-order] Per-project changes:');
    for (const [pid, rows] of byProject) {
      console.log(`  ${pid}: ${rows.length} version(s)`);
      for (const r of rows.slice(0, 3)) {
        console.log(`    ${r.version}: ${r.old} → ${r.new}`);
      }
      if (rows.length > 3) console.log(`    …and ${rows.length - 3} more`);
    }

    // 5. Verify: re-query and confirm ordering for a spot-check project
    console.log('\n[backfill-sort-order] Verification (proj-garage, first 30 by sort_order):');
    const { rows: verify } = await client.query(
      `SELECT version, sort_order FROM org_studio_roadmap_versions
       WHERE project_id = 'proj-garage'
       ORDER BY sort_order ASC, version ASC
       LIMIT 30`
    );
    verify.forEach(r => console.log(`  ${r.version.padEnd(10)} sort=${r.sort_order}`));

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[backfill-sort-order] ❌ Failed:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
