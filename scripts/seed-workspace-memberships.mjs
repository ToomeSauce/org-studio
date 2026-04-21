#!/usr/bin/env node
/**
 * Phase 3 — Seed org_studio_workspace_memberships
 *
 * Reads teammates from org_studio_settings, inserts:
 *   - basil → owner of default-workspace
 *   - every other teammate → member of default-workspace
 *
 * Idempotent: ON CONFLICT DO NOTHING.
 * Backs up current state first.
 */

import pg from 'pg';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error('❌ DATABASE_URL not set');
  process.exit(1);
}

const WORKSPACE_ID = 'default-workspace';
const OWNER_USER_ID = 'basil';

async function main() {
  const client = new pg.Client(DB_URL);
  await client.connect();

  try {
    // ── 1. Backup current memberships ────────────────────────────────
    const existing = await client.query(
      'SELECT * FROM org_studio_workspace_memberships ORDER BY workspace_id, user_id',
    );
    const backupDir = join(PROJECT_ROOT, 'backups');
    mkdirSync(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = join(backupDir, `pre-phase3-memberships-${ts}.json`);
    writeFileSync(backupPath, JSON.stringify(existing.rows, null, 2));
    console.log(`📦 Backed up ${existing.rows.length} existing memberships → ${backupPath}`);

    // ── 2. Read teammates from settings ──────────────────────────────
    const settingsResult = await client.query(
      `SELECT data->'teammates' AS teammates FROM org_studio_settings WHERE id = 'default' AND workspace_id = $1`,
      [WORKSPACE_ID],
    );

    if (!settingsResult.rows.length || !settingsResult.rows[0].teammates) {
      console.error('❌ No teammates found in settings for', WORKSPACE_ID);
      process.exit(1);
    }

    const teammates = settingsResult.rows[0].teammates;
    console.log(`👥 Found ${teammates.length} teammates in settings`);

    // ── 3. Build membership rows ─────────────────────────────────────
    const now = Date.now();
    const rows = teammates.map((t) => ({
      workspace_id: WORKSPACE_ID,
      user_id: t.id,
      role: t.id === OWNER_USER_ID ? 'owner' : 'member',
      joined_at: now,
    }));

    // Make sure Basil is explicitly included even if not in teammates
    if (!rows.find((r) => r.user_id === OWNER_USER_ID)) {
      rows.unshift({
        workspace_id: WORKSPACE_ID,
        user_id: OWNER_USER_ID,
        role: 'owner',
        joined_at: now,
      });
    }

    // ── 4. Insert (idempotent) ───────────────────────────────────────
    let inserted = 0;
    for (const row of rows) {
      const result = await client.query(
        `INSERT INTO org_studio_workspace_memberships (workspace_id, user_id, role, joined_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (workspace_id, user_id) DO NOTHING`,
        [row.workspace_id, row.user_id, row.role, row.joined_at],
      );
      if (result.rowCount > 0) {
        inserted++;
        console.log(`  ✅ ${row.user_id} → ${row.role}`);
      } else {
        console.log(`  ⏭️  ${row.user_id} → already exists`);
      }
    }

    console.log(`\n🎉 Inserted ${inserted} new memberships (${rows.length - inserted} already existed)`);

    // ── 5. Verify ────────────────────────────────────────────────────
    const verify = await client.query(
      'SELECT workspace_id, user_id, role FROM org_studio_workspace_memberships WHERE workspace_id = $1 ORDER BY role DESC, user_id',
      [WORKSPACE_ID],
    );
    console.log(`\n📊 Memberships for ${WORKSPACE_ID}:`);
    verify.rows.forEach((r) => console.log(`  ${r.role.padEnd(8)} ${r.user_id}`));
    console.log(`  Total: ${verify.rows.length}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
