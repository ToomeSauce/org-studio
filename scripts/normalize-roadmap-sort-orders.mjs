#!/usr/bin/env node
/**
 * scripts/normalize-roadmap-sort-orders.mjs (#1314.1)
 *
 * Re-canonicalize sort_order on every row of org_studio_roadmap_versions
 * AND every shadow entry inside org_studio_projects.data.{sections,components}.versions[].
 *
 * Why: Two competing sort_order schemes have coexisted on the canonical
 * table. Old rows used a compact `minor*1000 + patch` scheme (so 0.17.0 =
 * 17000, 0.17.1 = 17001). Newer rows use versionSortKey() = `maj*1B +
 * min*1M + pat*1k` (so 0.18.1 = 18,001,000 and 1.0.0 = 1,000,000,000).
 * Mixed in one ORDER BY clause, 1.0.0 sorts between 0.25.0 and 0.18.1.
 * Visible symptom (Basil 2026-05-12): on Thrivor, 0.18.2 rendered AFTER
 * 1.0.0.
 *
 * This script normalizes everything to versionSortKey, then re-sorts the
 * shadow arrays in project jsonb so the UI (which renders the array
 * verbatim) shows the right order.
 *
 * Idempotent. --dry-run prints intended changes without writing.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

if (!process.env.DATABASE_URL) {
  try {
    const envFile = readFileSync(path.join(process.cwd(), '.env.local'), 'utf8');
    const m = envFile.match(/^DATABASE_URL=(.+)$/m);
    if (m) process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, '');
  } catch {}
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const DRY_RUN = process.argv.includes('--dry-run');
const projectIdx = process.argv.indexOf('--project');
const SCOPED_PROJECT = projectIdx >= 0 ? process.argv[projectIdx + 1] : null;
if (SCOPED_PROJECT) console.log(`Scoped to project: ${SCOPED_PROJECT}`);

// Inline copies of the canonical sort key from src/lib/version-utils.ts.
// Keep these in sync.
const CALVER_RE = /^\d{4}\.\d{1,2}\.\d{1,2}(?:\.\d+)?$/;
function versionSortKey(version) {
  if (!version || typeof version !== 'string') return 0;
  const n = version.trim();
  try {
    const parts = n.split('.').map((x) => parseInt(x, 10) || 0);
    if (CALVER_RE.test(n)) {
      const [year, month, day, micro = 0] = parts;
      return (year - 2020) * 10_000_000 + month * 100_000 + day * 1_000 + micro;
    }
    const [maj, min, pat] = parts;
    return maj * 1_000_000_000 + min * 1_000_000 + pat * 1_000;
  } catch {
    return 0;
  }
}

const { Pool } = await import('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();

let canonicalUpdates = 0;
let projectsTouched = 0;

try {
  // 1) Canonical table.
  const canRes = await client.query(
    SCOPED_PROJECT
      ? `SELECT id, project_id, version, sort_order
           FROM org_studio_roadmap_versions
          WHERE workspace_id = $1 AND project_id = $2`
      : `SELECT id, project_id, version, sort_order
           FROM org_studio_roadmap_versions
          WHERE workspace_id = $1`,
    SCOPED_PROJECT ? ['default-workspace', SCOPED_PROJECT] : ['default-workspace'],
  );
  console.log(`\n=== Canonical: scanning ${canRes.rows.length} rows ===`);
  for (const row of canRes.rows) {
    const target = versionSortKey(row.version);
    // Skip rows where we couldn't compute a meaningful key (e.g. non-canonical
    // version strings like '2026-Q2-sprint'). Don't overwrite an existing real
    // sort_order with garbage.
    if (!Number.isFinite(target) || target === 0) {
      console.log(`  SKIP ${row.project_id} ${row.version.padEnd(10)} (couldn't normalize, leaving sort_order=${row.sort_order})`);
      continue;
    }
    if (row.sort_order !== target) {
      canonicalUpdates++;
      console.log(`  ${row.project_id} ${row.version.padEnd(10)} ${row.sort_order} -> ${target}`);
      if (!DRY_RUN) {
        await client.query(
          `UPDATE org_studio_roadmap_versions SET sort_order = $1 WHERE id = $2`,
          [target, row.id],
        );
      }
    }
  }
  console.log(`Canonical: ${canonicalUpdates} row(s) ${DRY_RUN ? 'would be' : ''} updated`);

  // 2) Shadow arrays inside project jsonb.
  console.log(`\n=== Project shadows ===`);
  const projRes = await client.query(
    SCOPED_PROJECT
      ? `SELECT id, name, data FROM org_studio_projects WHERE workspace_id = $1 AND id = $2`
      : `SELECT id, name, data FROM org_studio_projects WHERE workspace_id = $1`,
    SCOPED_PROJECT ? ['default-workspace', SCOPED_PROJECT] : ['default-workspace'],
  );
  for (const row of projRes.rows) {
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    if (!data) continue;

    let changed = false;
    for (const key of ['sections', 'components']) {
      const arr = Array.isArray(data[key]) ? data[key] : [];
      for (const container of arr) {
        const versions = Array.isArray(container.versions) ? container.versions : [];
        if (versions.length === 0) continue;

        // Re-stamp each entry's sort_order, then sort the array.
        for (const v of versions) {
          const target = versionSortKey(v?.version);
          if (!Number.isFinite(target) || target === 0) continue;
          if (v && typeof v === 'object' && v.sort_order !== target) {
            v.sort_order = target;
            changed = true;
          }
        }

        const before = versions.map((v) => v?.version);
        versions.sort((a, b) => {
          const ao = typeof a?.sort_order === 'number' ? a.sort_order : versionSortKey(a?.version);
          const bo = typeof b?.sort_order === 'number' ? b.sort_order : versionSortKey(b?.version);
          if (ao !== bo) return ao - bo;
          return String(a?.version || '').localeCompare(String(b?.version || ''));
        });
        const after = versions.map((v) => v?.version);
        const reordered = before.some((v, i) => v !== after[i]);
        if (reordered) {
          changed = true;
          container.versions = versions;
          console.log(`  [${row.id}] ${key}/${container.id} (${container.name || ''}) reordered`);
          const firstDiff = before.findIndex((v, i) => v !== after[i]);
          console.log(`    before: ...${before.slice(Math.max(0, firstDiff - 1)).join(', ')}`);
          console.log(`    after:  ...${after.slice(Math.max(0, firstDiff - 1)).join(', ')}`);
        }
      }
    }

    if (changed) {
      projectsTouched++;
      if (!DRY_RUN) {
        await client.query(
          `UPDATE org_studio_projects SET data = $1 WHERE id = $2 AND workspace_id = $3`,
          [JSON.stringify(data), row.id, 'default-workspace'],
        );
        const payload = JSON.stringify({
          type: 'project_update',
          projectId: row.id,
          timestamp: Date.now(),
          source: 'normalize-sort-orders',
          workspace_id: 'default-workspace',
        });
        await client.query(`NOTIFY org_studio_change, '${payload.replace(/'/g, "''")}'`);
      }
    }
  }
  console.log(`Projects: ${projectsTouched} ${DRY_RUN ? 'would be' : ''} touched`);
  console.log(`\nDone${DRY_RUN ? ' (dry-run \u2014 no writes)' : ''}.`);
} finally {
  client.release();
  await pool.end();
}
