#!/usr/bin/env node
/**
 * admin-create-workspace.mjs (#1393)
 *
 * Atomically create a workspace + owner user + ownership membership in a
 * single transaction. Used to provision the second test workspace for the
 * >=1 week staging soak prereq, and (eventually) by ops to provision new
 * workspaces in lieu of a public signup flow (#1394).
 *
 * Usage:
 *   node scripts/admin-create-workspace.mjs \
 *     --name "Acme Corp" \
 *     --owner-email alice@acme.test \
 *     [--workspace-id custom-id] \
 *     [--plan oss|internal|paid] \
 *     [--dry-run]
 *
 * Behavior:
 *   - workspace-id defaults to a slug of --name with random suffix
 *   - user is created if --owner-email is new; existing user is reused
 *   - membership row created with role='owner'
 *   - all three writes in one BEGIN/COMMIT
 *
 * Outputs JSON to stdout (so it composes with jq / shell pipelines):
 *   { "workspace": {...}, "user": {...}, "membership": {...} }
 */

import pg from 'pg';
import crypto from 'node:crypto';

// ── arg parsing (no dep, keep it small) ───────────────────────────────
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf('--' + name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return fallback;
}
const NAME = arg('name');
const OWNER_EMAIL = arg('owner-email');
const WS_ID = arg('workspace-id');
const PLAN = arg('plan', 'oss');
const DRY_RUN = args.includes('--dry-run');

if (!NAME || !OWNER_EMAIL) {
  console.error('Usage: admin-create-workspace.mjs --name <name> --owner-email <email> [--workspace-id id] [--plan oss|internal|paid] [--dry-run]');
  process.exit(2);
}
if (!['oss', 'internal', 'paid'].includes(PLAN)) {
  console.error('Invalid --plan; must be oss|internal|paid');
  process.exit(2);
}

const CONNECTION_STRING = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!CONNECTION_STRING) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

const workspaceId = WS_ID || `ws-${slugify(NAME)}-${crypto.randomBytes(3).toString('hex')}`;

const client = new pg.Client({ connectionString: CONNECTION_STRING });

async function run() {
  await client.connect();
  console.error(DRY_RUN ? '🧪 DRY RUN' : '🚀 LIVE');
  console.error(`   workspace id=${workspaceId}, name="${NAME}", owner_email=${OWNER_EMAIL}, plan=${PLAN}`);

  await client.query('BEGIN');
  try {
    // 1. user — find or create
    const existingUser = await client.query(
      `SELECT id, email FROM org_studio_users WHERE LOWER(email) = LOWER($1)`,
      [OWNER_EMAIL],
    );
    let userId;
    let userRow;
    if (existingUser.rows.length > 0) {
      userId = existingUser.rows[0].id;
      userRow = existingUser.rows[0];
      console.error(`   → user exists (id=${userId})`);
    } else {
      userId = `u-${crypto.randomBytes(8).toString('hex')}`;
      const inserted = await client.query(
        `INSERT INTO org_studio_users (id, email, password_hash, oauth_subject, created_at, last_login_at)
         VALUES ($1, $2, NULL, NULL, $3, NULL)
         RETURNING id, email, created_at`,
        [userId, OWNER_EMAIL, Date.now()],
      );
      userRow = inserted.rows[0];
      console.error(`   → user created (id=${userId})`);
    }

    // 2. workspace
    // Guard: workspace id must be unique
    const wsCheck = await client.query(
      `SELECT id FROM org_studio_workspaces WHERE id = $1`,
      [workspaceId],
    );
    if (wsCheck.rows.length > 0) {
      throw new Error(`workspace id '${workspaceId}' already exists. Pick a different --workspace-id.`);
    }
    const wsInserted = await client.query(
      `INSERT INTO org_studio_workspaces (id, name, owner, plan, created_at, deleted_at)
       VALUES ($1, $2, $3, $4, $5, NULL)
       RETURNING id, name, owner, plan, created_at, deleted_at`,
      [workspaceId, NAME, userId, PLAN, Date.now()],
    );
    console.error(`   → workspace created (id=${workspaceId})`);

    // 3. owner membership
    const memInserted = await client.query(
      `INSERT INTO org_studio_workspace_memberships (workspace_id, user_id, role, joined_at)
       VALUES ($1, $2, 'owner', $3)
       RETURNING workspace_id, user_id, role, joined_at`,
      [workspaceId, userId, Date.now()],
    );
    console.error(`   → owner membership created`);

    const out = {
      workspace: wsInserted.rows[0],
      user: userRow,
      membership: memInserted.rows[0],
    };

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      console.error('\n🧪 DRY RUN — ROLLBACK.');
    } else {
      await client.query('COMMIT');
      console.error('\n✅ Committed.');
    }
    console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('\n❌ Failed (rolled back):', e.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
