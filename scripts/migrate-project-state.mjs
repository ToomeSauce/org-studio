#!/usr/bin/env node
/**
 * migrate-project-state.mjs
 *
 * Idempotent migration: backfills `project.state` and removes dead
 * `autonomy.enabled` from all projects in Postgres.
 *
 * Can be run standalone: `node scripts/migrate-project-state.mjs`
 * OR imported by server.mjs at startup.
 *
 * Safe to re-run — skips projects that already have `state` set.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

const DATABASE_URL = process.env.DATABASE_URL;

async function main() {
  if (!DATABASE_URL) {
    console.log('[MigrateState] No DATABASE_URL — skipping');
    return { migrated: 0 };
  }

  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  try {
    // 1. Backup
    const backupDir = join(rootDir, 'backups');
    if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = join(backupDir, `pre-state-unification-${timestamp}.json`);

    const allProjects = await pool.query(
      `SELECT id, data FROM org_studio_projects WHERE workspace_id = $1`,
      ['default-workspace'],
    );

    writeFileSync(backupPath, JSON.stringify(allProjects.rows, null, 2));
    console.log(`[MigrateState] Backed up ${allProjects.rows.length} projects to ${backupPath}`);

    // 2. Migrate each project
    let migrated = 0;
    for (const row of allProjects.rows) {
      const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data || {};
      let changed = false;

      // Backfill state
      if (!data.state) {
        data.state = (data.currentVersion === null || data.currentVersion === undefined) ? 'stopped' : 'started';
        changed = true;
      }

      // Remove dead autonomy.enabled
      if (data.autonomy && 'enabled' in data.autonomy) {
        delete data.autonomy.enabled;
        changed = true;
      }

      if (changed) {
        await pool.query(
          `UPDATE org_studio_projects SET data = $1 WHERE id = $2 AND workspace_id = $3`,
          [JSON.stringify(data), row.id, 'default-workspace'],
        );
        console.log(`[MigrateState] ${row.id}: state=${data.state}${data.autonomy && !('enabled' in data.autonomy) ? ', removed autonomy.enabled' : ''}`);
        migrated++;
      }
    }

    console.log(`[MigrateState] Done. Migrated ${migrated}/${allProjects.rows.length} projects.`);
    return { migrated };
  } finally {
    await pool.end();
  }
}

// Run if invoked directly
main().catch(err => {
  console.error('[MigrateState] Fatal:', err);
  process.exit(1);
});

export { main as migrateProjectState };
