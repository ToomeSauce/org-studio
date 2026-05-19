#!/usr/bin/env node
/**
 * backfill-1393-tenants.mjs (#1393)
 *
 * After migrate-1393-tenant-identity.mjs has added the org_studio_users
 * table and the workspaces.deleted_at / workspaces.plan columns, this
 * script seeds:
 *
 *   1. A real basil user row in org_studio_users.
 *   2. Reconciles existing workspace_memberships.user_id='basil' (which has
 *      no parent user row today) with the new users row.
 *   3. Sets the default-workspace plan to 'internal' if currently the
 *      'oss' default. (Other workspaces, if any, keep 'oss'.)
 *
 * Idempotent. INSERT … ON CONFLICT DO NOTHING + targeted UPDATE WHERE
 * predicates ensure re-runs are no-ops.
 *
 * The existing 9 agent membership rows (mikey, ana, henry, sam, billy, etc.)
 * are left alone. They are valid memberships but the users they point at do
 * not need real org_studio_users rows yet — they're internal agent loops,
 * not human logins. Membership-without-user is acceptable for non-human
 * principals; resolveWorkspaceContext + workspace-auth handle it gracefully
 * (see workspace-auth.ts line 257: 'stale membership row → skip').
 *
 * BASIL_EMAIL env var sets the email; falls back to a placeholder. The
 * email can be changed later via SQL — this script only seeds, never
 * updates an existing row.
 *
 * Usage:
 *   DATABASE_URL=... BASIL_EMAIL=basil@example.com node scripts/backfill-1393-tenants.mjs
 *   DATABASE_URL=... node scripts/backfill-1393-tenants.mjs --dry-run
 */

import pg from 'pg';

const DRY_RUN = process.argv.includes('--dry-run');
const BASIL_EMAIL = process.env.BASIL_EMAIL || 'basil@catpilot.ai';
const BASIL_USER_ID = 'basil';

const CONNECTION_STRING = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!CONNECTION_STRING) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}

const client = new pg.Client({ connectionString: CONNECTION_STRING });

async function run() {
  await client.connect();
  console.log(DRY_RUN ? '🧪 DRY RUN — no changes committed.' : '🚀 LIVE RUN');

  await client.query('BEGIN');
  try {
    // Pre-flight: ensure migration has run
    const usersExists = await client.query(
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='org_studio_users')`,
    );
    if (!usersExists.rows[0].exists) {
      throw new Error('org_studio_users table missing — run migrate-1393-tenant-identity.mjs first.');
    }

    // ── 1. basil user row ─────────────────────────────────────────────
    console.log('\n[1/3] INSERT basil user (id=basil, email=' + BASIL_EMAIL + ')');
    const before = await client.query(
      `SELECT id, email FROM org_studio_users WHERE id = $1`,
      [BASIL_USER_ID],
    );
    if (before.rows.length === 0) {
      await client.query(
        `INSERT INTO org_studio_users (id, email, password_hash, oauth_subject, created_at, last_login_at)
         VALUES ($1, $2, NULL, NULL, $3, NULL)
         ON CONFLICT (id) DO NOTHING`,
        [BASIL_USER_ID, BASIL_EMAIL, Date.now()],
      );
      console.log('      → inserted');
    } else {
      console.log('      → already exists (id=basil, email=' + before.rows[0].email + ') — skipping');
    }

    // ── 2. confirm basil owner membership exists ──────────────────────
    console.log('\n[2/3] verify default-workspace owner=basil membership');
    const memb = await client.query(
      `SELECT role FROM org_studio_workspace_memberships
       WHERE workspace_id = 'default-workspace' AND user_id = $1`,
      [BASIL_USER_ID],
    );
    if (memb.rows.length === 0) {
      console.log('      → membership missing, inserting');
      await client.query(
        `INSERT INTO org_studio_workspace_memberships
           (workspace_id, user_id, role, joined_at)
         VALUES ('default-workspace', $1, 'owner', $2)
         ON CONFLICT (workspace_id, user_id) DO NOTHING`,
        [BASIL_USER_ID, Date.now()],
      );
    } else if (memb.rows[0].role !== 'owner') {
      console.log(`      → membership exists with role='${memb.rows[0].role}', promoting to 'owner'`);
      await client.query(
        `UPDATE org_studio_workspace_memberships
         SET role = 'owner'
         WHERE workspace_id = 'default-workspace' AND user_id = $1`,
        [BASIL_USER_ID],
      );
    } else {
      console.log('      → already owner, OK');
    }

    // ── 3. workspace plan ─────────────────────────────────────────────
    console.log("\n[3/3] set default-workspace plan='internal' (if currently 'oss')");
    const planUpdate = await client.query(
      `UPDATE org_studio_workspaces
       SET plan = 'internal'
       WHERE id = 'default-workspace' AND plan = 'oss'
       RETURNING id, plan`,
    );
    if (planUpdate.rows.length > 0) {
      console.log('      → updated to internal');
    } else {
      const current = await client.query(
        `SELECT plan FROM org_studio_workspaces WHERE id = 'default-workspace'`,
      );
      console.log(
        '      → no update needed (current plan=' +
          (current.rows[0]?.plan ?? '(missing)') +
          ')',
      );
    }

    // ── verification ──────────────────────────────────────────────────
    const finalUsers = await client.query(`SELECT COUNT(*)::int AS c FROM org_studio_users`);
    const finalWs = await client.query(
      `SELECT id, name, owner, plan, deleted_at FROM org_studio_workspaces ORDER BY id`,
    );
    const finalMemb = await client.query(
      `SELECT workspace_id, user_id, role FROM org_studio_workspace_memberships
       WHERE workspace_id = 'default-workspace' AND user_id = 'basil'`,
    );

    console.log('\n=== post-state ===');
    console.log('   users count:', finalUsers.rows[0].c);
    console.log('   workspaces:');
    for (const r of finalWs.rows) console.log('     ', JSON.stringify(r));
    console.log('   basil membership:', JSON.stringify(finalMemb.rows[0] || null));

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      console.log('\n🧪 DRY RUN — ROLLBACK issued.');
    } else {
      await client.query('COMMIT');
      console.log('\n✅ Backfill committed.');
    }
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('\n❌ Backfill failed (rolled back):', e.message);
    throw e;
  } finally {
    await client.end();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
