#!/usr/bin/env node
/**
 * migrate-approved-versions.mjs (#1186)
 *
 * Idempotent migration: backfills `component.approvedVersions[]` (explicit
 * list) from the legacy `component.approvedThrough` (contiguous prefix
 * string) field, by reading each project's roadmap versions table.
 *
 * For each component on each project:
 *   1. If `approvedVersions` is already a non-empty array → skip (idempotent).
 *   2. If `approvedThrough` is not set → leave both fields as-is.
 *   3. Else: read all roadmap versions for the project, sorted by sort_order;
 *      add every version `v` where `v <= approvedThrough` to
 *      `approvedVersions`. Preserves the legacy `approvedThrough` field
 *      until ticket E drops the shim.
 *
 * Sources of roadmap versions checked (in order):
 *   - `org_studio_roadmap_versions` rows with project_id = <id>
 *   - `component.versions[]` array (post-#1112 PR 3 shape)
 *   - Falls back to project.versions[] if neither has rows
 *
 * Usage: `node scripts/migrate-approved-versions.mjs`
 * Safe to re-run.
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

const DATABASE_URL = process.env.DATABASE_URL;

/**
 * Numeric-aware version compare. Returns a <= b.
 */
function isVersionLessOrEqual(a, b) {
  if (a === b) return true;
  const ap = a.split('.').map((s) => parseInt(s, 10));
  const bp = b.split('.').map((s) => parseInt(s, 10));
  const len = Math.max(ap.length, bp.length);
  for (let i = 0; i < len; i++) {
    const av = Number.isFinite(ap[i]) ? ap[i] : 0;
    const bv = Number.isFinite(bp[i]) ? bp[i] : 0;
    if (av < bv) return true;
    if (av > bv) return false;
  }
  return true;
}

async function main() {
  if (!DATABASE_URL) {
    console.log('[MigrateApproved] No DATABASE_URL — skipping');
    return { migrated: 0 };
  }

  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  try {
    // 1. Backup
    const backupDir = join(rootDir, 'backups');
    if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = join(backupDir, `pre-approved-versions-${timestamp}.json`);

    const allProjects = await pool.query(
      `SELECT id, data FROM org_studio_projects WHERE workspace_id = $1`,
      ['default-workspace'],
    );

    writeFileSync(backupPath, JSON.stringify(allProjects.rows, null, 2));
    console.log(`[MigrateApproved] Backed up ${allProjects.rows.length} projects to ${backupPath}`);

    // 2. For each project, walk components and backfill
    let projectsTouched = 0;
    let componentsBackfilled = 0;

    for (const row of allProjects.rows) {
      const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data || {};
      let projChanged = false;

      // Pull roadmap versions for this project from the dedicated table
      const vRes = await pool.query(
        `SELECT version FROM org_studio_roadmap_versions
         WHERE project_id = $1 AND workspace_id = $2
         ORDER BY sort_order ASC, version ASC`,
        [row.id, 'default-workspace'],
      );
      const roadmapVersions = vRes.rows.map((r) => r.version);

      // Walk both `components` and `sections` (whichever is on disk)
      for (const fieldName of ['components', 'sections']) {
        const list = data[fieldName];
        if (!Array.isArray(list)) continue;

        for (const comp of list) {
          // Skip already-migrated
          if (Array.isArray(comp.approvedVersions) && comp.approvedVersions.length > 0) continue;

          const horizon = comp.approvedThrough;
          if (!horizon) continue; // nothing to migrate

          // Source of versions for THIS component:
          //   1. Roadmap table rows (project-wide) — preferred
          //   2. comp.versions[] (per-component)
          //   3. project.versions[] (legacy)
          let candidateVersions = roadmapVersions;
          if (candidateVersions.length === 0 && Array.isArray(comp.versions)) {
            candidateVersions = comp.versions
              .map((v) => v.version || v.id)
              .filter(Boolean);
          }
          if (candidateVersions.length === 0 && Array.isArray(data.versions)) {
            candidateVersions = data.versions
              .map((v) => v.version || v.id)
              .filter(Boolean);
          }

          // Compute the prefix
          const approvedList = candidateVersions.filter((v) =>
            isVersionLessOrEqual(v, horizon),
          );

          // Ensure the horizon itself is always in the list, even if the
          // roadmap table lacks that exact row (e.g. version was approved
          // but never landed as a versions[] entry). Preserves the invariant:
          //   max(approvedVersions) === approvedThrough
          if (!approvedList.includes(horizon)) approvedList.push(horizon);

          comp.approvedVersions = approvedList;
          projChanged = true;
          componentsBackfilled++;
          console.log(
            `[MigrateApproved] ${row.id} / ${comp.id || comp.name}: approvedThrough=${horizon} → approvedVersions=[${comp.approvedVersions.join(', ')}]`,
          );
        }
      }

      if (projChanged) {
        await pool.query(
          `UPDATE org_studio_projects SET data = $1 WHERE id = $2 AND workspace_id = $3`,
          [JSON.stringify(data), row.id, 'default-workspace'],
        );
        projectsTouched++;
      }
    }

    console.log(
      `[MigrateApproved] Done. Projects touched: ${projectsTouched}/${allProjects.rows.length}. Components backfilled: ${componentsBackfilled}.`,
    );
    return { migrated: componentsBackfilled };
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[MigrateApproved] Fatal:', err);
  process.exit(1);
});

export { main as migrateApprovedVersions };
