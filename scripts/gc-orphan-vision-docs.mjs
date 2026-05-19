#!/usr/bin/env node
/**
 * #1392 — GC orphan org_studio_vision_docs rows
 *
 * A vision_docs row is "orphaned" when there is no matching project in
 * org_studio_projects for the same (project_id, workspace_id). This used
 * to happen when projects were hand-renamed via direct SQL (e.g. the
 * proj-mc → proj-org-studio rename that left a stale proj-mc vision_docs
 * row behind). I overwrote that stale row during #1387 B.2 smoke testing,
 * mistook it for live data, and triggered a false alarm — see the audit
 * memo for #1392 in docs/audits/.
 *
 * Usage:
 *   node scripts/gc-orphan-vision-docs.mjs --dry-run    # report only
 *   node scripts/gc-orphan-vision-docs.mjs              # report + delete
 *
 * Idempotent: zero orphans → exit 0, no work. Safe to run anytime.
 *
 * SCOPE NOTE: This script only handles vision_docs orphans. Other tables
 * keyed by project_id (tasks, roadmap_versions, kudos) also orphan on
 * hand-rename — but they're out of scope for #1392. If/when projects gain
 * a proper rename API path, that path should atomically update all FK
 * tables in one transaction; running this script is a workaround until
 * that lands.
 */

import { Pool } from 'pg';

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL not set. This script is Postgres-only.');
    process.exit(2);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  try {
    // 1. Identify orphans
    const orphans = await pool.query(`
      SELECT v.project_id,
             v.workspace_id,
             LENGTH(v.content) AS content_len,
             v.updated_at
      FROM org_studio_vision_docs v
      LEFT JOIN org_studio_projects p
        ON v.project_id = p.id
       AND v.workspace_id = p.workspace_id
      WHERE p.id IS NULL
      ORDER BY v.updated_at DESC NULLS LAST
    `);

    if (orphans.rows.length === 0) {
      console.log('✅ No orphans. Nothing to do.');
      return;
    }

    console.log(`Found ${orphans.rows.length} orphan vision_docs row(s):`);
    for (const r of orphans.rows) {
      console.log(
        `  - project_id=${r.project_id} workspace_id=${r.workspace_id} content=${r.content_len}B updated_at=${r.updated_at}`,
      );
    }

    if (DRY_RUN) {
      console.log('\n(dry-run — no rows deleted. Re-run without --dry-run to delete.)');
      return;
    }

    // 2. Snapshot-and-delete in one transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Insert snapshots into the existing org_studio_vision_docs_backup
      // table so the delete is recoverable. The backup table already exists
      // and has the same shape (we confirmed earlier).
      const snapshot = await client.query(
        `
        INSERT INTO org_studio_vision_docs_backup (project_id, content, updated_at, workspace_id)
        SELECT v.project_id, v.content, v.updated_at, v.workspace_id
        FROM org_studio_vision_docs v
        LEFT JOIN org_studio_projects p
          ON v.project_id = p.id
         AND v.workspace_id = p.workspace_id
        WHERE p.id IS NULL
        RETURNING project_id, workspace_id
        `,
      );

      const del = await client.query(
        `
        DELETE FROM org_studio_vision_docs v
        WHERE NOT EXISTS (
          SELECT 1 FROM org_studio_projects p
          WHERE p.id = v.project_id
            AND p.workspace_id = v.workspace_id
        )
        RETURNING project_id, workspace_id
        `,
      );

      await client.query('COMMIT');
      console.log(`\n📦 Snapshotted ${snapshot.rows.length} row(s) to org_studio_vision_docs_backup`);
      console.log(`🗑️  Deleted ${del.rows.length} orphan row(s) from org_studio_vision_docs`);

      // Recover hint: also write a JSON snapshot to disk for redundancy.
      const fs = await import('node:fs');
      const path = await import('node:path');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const outDir = path.join(process.cwd(), 'data', 'backups');
      try {
        fs.mkdirSync(outDir, { recursive: true });
        const outPath = path.join(outDir, `vision-docs-gc-${stamp}.json`);
        fs.writeFileSync(outPath, JSON.stringify(orphans.rows, null, 2));
        console.log(`💾 JSON snapshot: ${outPath}`);
      } catch (e) {
        console.warn(`(warn: could not write disk snapshot: ${e.message})`);
      }
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('GC failed:', e.message);
  process.exit(1);
});
