#!/usr/bin/env node
/**
 * migrate-1393-tenant-identity.mjs (#1393)
 *
 * Adds the missing pieces of the tenant identity tier on top of the
 * workspace_id plumbing that #1387 Slice A/B installed.
 *
 * What's already in place (do NOT recreate):
 *   - org_studio_workspaces           — id, name, owner, created_at, data jsonb
 *   - org_studio_workspace_memberships — workspace_id, user_id, role, joined_at
 *   - default-workspace row + basil/owner + agent/member rows
 *   - Slice A/B store-provider + cachedStore are workspace-aware
 *
 * What this migration adds:
 *   1. org_studio_users table — id, email, password_hash, oauth_subject,
 *      created_at, last_login_at. password_hash and oauth_subject are both
 *      nullable so 'basil' can exist as a record without a login flow yet.
 *   2. org_studio_workspaces.deleted_at (BIGINT, nullable) for soft-delete.
 *   3. org_studio_workspaces.plan (TEXT, default 'oss') — billing/tier marker.
 *   4. CHECK constraint on org_studio_workspace_memberships.role to allow
 *      ('owner' | 'admin' | 'member' | 'viewer'). 'admin' is forward-compat
 *      per Slice B B.1 decision; today only 'owner' is privileged but the
 *      enum value is reserved so zero callsites need to change later.
 *   5. Index on org_studio_users.email (unique, case-insensitive via LOWER).
 *
 * Idempotent: safe to re-run. All DDL is `IF NOT EXISTS` or guarded by a
 * pre-check before constraint adds.
 *
 * Reversible: runbook lives in docs/audits/1393-tenant-identity.md. Rollback
 * is `DROP TABLE org_studio_users; ALTER TABLE org_studio_workspaces DROP
 * COLUMN deleted_at, DROP COLUMN plan; ALTER TABLE org_studio_workspace_
 * memberships DROP CONSTRAINT role_check;`. No data loss for existing rows.
 *
 * Wrapped in a single transaction so partial application can't happen.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/migrate-1393-tenant-identity.mjs
 *   DATABASE_URL=... node scripts/migrate-1393-tenant-identity.mjs --dry-run
 */

import pg from 'pg';

const DRY_RUN = process.argv.includes('--dry-run');

const CONNECTION_STRING = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!CONNECTION_STRING) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}

const client = new pg.Client({ connectionString: CONNECTION_STRING });

async function run() {
  await client.connect();
  console.log(DRY_RUN ? '🧪 DRY RUN — no changes will be committed.' : '🚀 LIVE RUN — changes will be committed.');
  console.log('   DB:', CONNECTION_STRING.replace(/:[^:@]*@/, ':***@'));

  await client.query('BEGIN');
  try {
    // ── Step 1: org_studio_users table ─────────────────────────────────
    console.log('\n[1/5] CREATE TABLE org_studio_users IF NOT EXISTS');
    await client.query(`
      CREATE TABLE IF NOT EXISTS org_studio_users (
        id              TEXT PRIMARY KEY,
        email           TEXT NOT NULL,
        password_hash   TEXT,
        oauth_subject   TEXT,
        created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
        last_login_at   BIGINT
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_ci
        ON org_studio_users (LOWER(email))
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_oauth_subject
        ON org_studio_users (oauth_subject)
        WHERE oauth_subject IS NOT NULL
    `);

    // ── Step 2: workspaces.deleted_at ──────────────────────────────────
    console.log('[2/5] ALTER org_studio_workspaces ADD COLUMN deleted_at');
    await client.query(`
      ALTER TABLE org_studio_workspaces
        ADD COLUMN IF NOT EXISTS deleted_at BIGINT
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_workspaces_deleted_at
        ON org_studio_workspaces (deleted_at)
        WHERE deleted_at IS NULL
    `);

    // ── Step 3: workspaces.plan ────────────────────────────────────────
    console.log("[3/5] ALTER org_studio_workspaces ADD COLUMN plan DEFAULT 'oss'");
    await client.query(`
      ALTER TABLE org_studio_workspaces
        ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'oss'
    `);

    // ── Step 4: membership role CHECK ──────────────────────────────────
    // We can't ADD CONSTRAINT IF NOT EXISTS directly; check first.
    console.log('[4/5] ADD CONSTRAINT memberships_role_check (if not present)');
    const existing = await client.query(
      `SELECT 1 FROM pg_constraint
       WHERE conname = 'memberships_role_check'
         AND conrelid = 'org_studio_workspace_memberships'::regclass`,
    );
    if (existing.rows.length === 0) {
      // Sanity-check current data fits the new enum before we constrain.
      const bad = await client.query(`
        SELECT DISTINCT role FROM org_studio_workspace_memberships
        WHERE role IS NULL OR role NOT IN ('owner', 'admin', 'member', 'viewer')
      `);
      if (bad.rows.length > 0) {
        throw new Error(
          `Pre-check failed — found role values outside the new enum: ${bad.rows.map((r) => r.role).join(', ')}. ` +
            'Migrate those rows first (or extend the enum).',
        );
      }
      await client.query(`
        ALTER TABLE org_studio_workspace_memberships
          ADD CONSTRAINT memberships_role_check
          CHECK (role IN ('owner', 'admin', 'member', 'viewer'))
      `);
      console.log('      → constraint added');
    } else {
      console.log('      → already present, skipping');
    }

    // ── Step 5: verification ───────────────────────────────────────────
    console.log('[5/5] verifying schema …');
    const userCols = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='org_studio_users' ORDER BY ordinal_position
    `);
    const wsCols = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='org_studio_workspaces' ORDER BY ordinal_position
    `);
    console.log('      org_studio_users:', userCols.rows.map((r) => r.column_name).join(', '));
    console.log('      org_studio_workspaces:', wsCols.rows.map((r) => r.column_name).join(', '));

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      console.log('\n🧪 DRY RUN complete — ROLLBACK issued, no changes persisted.');
    } else {
      await client.query('COMMIT');
      console.log('\n✅ Migration committed.');
      console.log('   Next: node scripts/backfill-1393-tenants.mjs');
    }
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('\n❌ Migration failed (rolled back):', e.message);
    throw e;
  } finally {
    await client.end();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
