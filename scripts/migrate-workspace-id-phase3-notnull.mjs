#!/usr/bin/env node
/**
 * Migration Phase 3 (#1622, from the #1610 audit F-13):
 *   backfill workspace_id on any remaining legacy rows, VERIFY zero NULLs,
 *   then (gated) add a NOT NULL constraint so future rows must be stamped.
 *
 * WHY (F-13): filterByWorkspace()/belongsToWorkspace() coalesce a NULL
 * workspace_id to DEFAULT_WORKSPACE_ID ('default-workspace'):
 *     const rws = record.workspace_id || DEFAULT_WORKSPACE_ID;
 * So ANY unstamped legacy row silently becomes visible to the default
 * workspace. Phase 1 (migrate-workspace-id.mjs) + Phase 2
 * (migrate-workspace-id-phase2.mjs) added the column + backfilled NULLs,
 * but left the column NULLABLE — nothing stops a future code path from
 * inserting a NULL and re-opening the leak. This phase closes that:
 * a DB-level NOT NULL constraint makes "every tenant row is stamped" an
 * invariant the database enforces, not a convention code must remember.
 *
 * ── TWO MODES ───────────────────────────────────────────────────────────
 *   (default)            VERIFY + BACKFILL. Reversible. Safe to run anytime.
 *                        - ensures the column exists (idempotent)
 *                        - UPDATEs any NULL workspace_id -> 'default-workspace'
 *                        - asserts 0 NULLs per table; exits 1 if any remain
 *                        Ships to `done`: pure data backfill, fully reversible.
 *
 *   --apply-not-null     IRREVERSIBLE DDL. Requires human sign-off.
 *                        Adds `ALTER COLUMN workspace_id SET NOT NULL` to each
 *                        target table, inside a single transaction, AFTER
 *                        re-verifying 0 NULLs. Guarded by CONFIRM_NOT_NULL=yes
 *                        so it cannot fire by accident. DO NOT run against the
 *                        cloud DB until #1622 is signed off (per ticket
 *                        constraints + the org-studio Review rules).
 *
 * ── SCOPE (which tables) ────────────────────────────────────────────────
 * Only the tenant-scoped tables that already carry workspace_id and
 * participate in workspace isolation (via filterByWorkspace/belongsToWorkspace
 * or a direct `WHERE workspace_id = $1` query in auth.ts / api-tokens.ts /
 * launch-prep.ts). Explicitly EXCLUDED:
 *   - org_studio_workspaces, org_studio_users  → not tenant-scoped (they DEFINE
 *     tenants / are cross-workspace); a NOT NULL workspace_id is nonsensical.
 *   - *_backup tables (roadmap_versions_backup, vision_docs_backup) → archival,
 *     0 rows, never read through the workspace filter.
 *   - tables WITHOUT a workspace_id column today (comments, embeddings,
 *     dispatch_attempts, notification_*, bootstrap_pings, skill_installs,
 *     watchdog_pauses) → out of scope: they are NOT filtered by workspace
 *     (comments inherit isolation via their parent task's workspace; the rest
 *     are operational/agent-scoped). Adding the column there is a NEW feature,
 *     not a backfill — file a follow-up if tenant-scoping is ever desired.
 * Tables already NOT NULL are detected and skipped (no-op, reported as ✅).
 *
 * ── ROLLBACK PLAN ───────────────────────────────────────────────────────
 *   Backfill (default mode): reversible by design — it only sets a column that
 *     was already defaulting to 'default-workspace'. To "undo" a specific
 *     backfilled row, set its workspace_id back to NULL (not generally useful;
 *     a NULL row is exactly the F-13 hazard).
 *   NOT NULL (--apply-not-null): the literal SQL reversal is
 *       ALTER TABLE <t> ALTER COLUMN workspace_id DROP NOT NULL;
 *     per target table (see printed list). The constraint is "irreversible" in
 *     the OPERATIONAL sense the ticket means: once enforced in prod, any
 *     insert path that forgets to stamp workspace_id starts erroring. Before
 *     sign-off+apply, confirm every INSERT into these tables supplies
 *     workspace_id (auth.ts/api-tokens.ts/outbox.ts/heartbeats.ts/launch-prep.ts
 *     all default to 'default-workspace' — verified 2026-06-04). Roll back with
 *     the DROP NOT NULL statements above + redeploy if an unstamped insert path
 *     surfaces.
 *
 * Usage:
 *   node scripts/migrate-workspace-id-phase3-notnull.mjs                 # verify+backfill
 *   CONFIRM_NOT_NULL=yes node scripts/migrate-workspace-id-phase3-notnull.mjs --apply-not-null
 */

import { readFileSync } from 'fs';

const env = readFileSync('.env.local', 'utf-8');
const match = env.match(/DATABASE_URL=(.+)/);
const dbUrl = match ? match[1].trim().replace(/^["']|["']$/g, '') : null;

if (!dbUrl) {
  console.error('❌ No DATABASE_URL found in .env.local');
  process.exit(1);
}

// Tenant-scoped tables that already carry workspace_id (see SCOPE above).
const TARGET_TABLES = [
  'org_studio_projects',
  'org_studio_tasks',
  'org_studio_sessions',
  'org_studio_vision_docs',
  'org_studio_api_tokens',
  'org_studio_roadmap_versions',
  'org_studio_agent_metrics',
  'org_studio_kudos',
  'org_studio_outbox',
  'org_studio_heartbeats',
  'org_studio_incidents',
  'org_studio_settings',
  'org_studio_workspace_memberships',
  'org_studio_admin_audit',
];

const DEFAULT_WS = 'default-workspace';
const APPLY_NOT_NULL = process.argv.includes('--apply-not-null');

const { default: pg } = await import('pg');
const pool = new pg.Pool({ connectionString: dbUrl });

async function tableExists(client, name) {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    [name],
  );
  return r.rowCount > 0;
}

async function columnInfo(client, table) {
  const r = await client.query(
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_name=$1 AND column_name='workspace_id'`,
    [table],
  );
  return r.rows[0] || null;
}

async function nullCount(client, table) {
  const r = await client.query(
    `SELECT COUNT(*)::int AS n FROM ${table} WHERE workspace_id IS NULL`,
  );
  return r.rows[0].n;
}

async function verifyAndBackfill() {
  const client = await pool.connect();
  const state = []; // { table, exists, hasCol, nullable, rows, backfilled, nullsAfter }
  let anyNullsRemain = false;
  try {
    console.log('🔄 Phase 3 (#1622) — verify + backfill workspace_id\n');
    for (const table of TARGET_TABLES) {
      const exists = await tableExists(client, table);
      if (!exists) {
        console.log(`  ⏭  ${table.padEnd(36)} — does not exist, skipping`);
        state.push({ table, exists: false });
        continue;
      }
      let col = await columnInfo(client, table);
      if (!col) {
        // Defensive: phases 1/2 should have added it, but be idempotent.
        await client.query(
          `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS workspace_id TEXT DEFAULT '${DEFAULT_WS}'`,
        );
        col = await columnInfo(client, table);
      }
      const rows = (await client.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n;
      const back = await client.query(
        `UPDATE ${table} SET workspace_id='${DEFAULT_WS}' WHERE workspace_id IS NULL`,
      );
      const nullsAfter = await nullCount(client, table);
      if (nullsAfter > 0) anyNullsRemain = true;
      const flag = nullsAfter === 0 ? '✅' : `⚠️  ${nullsAfter} NULLs REMAIN`;
      const bf = back.rowCount > 0 ? ` (backfilled ${back.rowCount})` : '';
      const nn = col.is_nullable === 'NO' ? ' [already NOT NULL]' : '';
      console.log(`  ✓ ${table.padEnd(36)} rows=${String(rows).padEnd(7)}${flag}${bf}${nn}`);
      state.push({
        table, exists: true, nullable: col.is_nullable === 'YES',
        rows, backfilled: back.rowCount, nullsAfter,
      });
    }
    console.log('');
    if (anyNullsRemain) {
      console.error('❌ Some tables still have NULL workspace_id after backfill. Aborting.');
      process.exitCode = 1;
    } else {
      console.log('✅ DONE-WHEN met: 0 NULL workspace_id across all target tables.');
    }
  } finally {
    client.release();
  }
  return state;
}

async function applyNotNull(state) {
  if (process.env.CONFIRM_NOT_NULL !== 'yes') {
    console.error(
      '\n🚫 --apply-not-null requires CONFIRM_NOT_NULL=yes (human sign-off gate, #1622).\n' +
      '   This is the IRREVERSIBLE DDL step. Do NOT run against cloud until signed off.\n' +
      '   Re-run: CONFIRM_NOT_NULL=yes node scripts/migrate-workspace-id-phase3-notnull.mjs --apply-not-null',
    );
    process.exitCode = 1;
    return;
  }
  const client = await pool.connect();
  try {
    // Re-verify 0 NULLs inside the same connection right before the DDL.
    for (const s of state) {
      if (!s.exists) continue;
      const n = await nullCount(client, s.table);
      if (n > 0) {
        console.error(`❌ ${s.table} has ${n} NULLs — refusing to SET NOT NULL. Run backfill first.`);
        process.exitCode = 1;
        return;
      }
    }
    console.log('\n🔐 Applying NOT NULL (transactional)…');
    await client.query('BEGIN');
    const applied = [];
    for (const s of state) {
      if (!s.exists) continue;
      if (s.nullable === false) {
        console.log(`  ⏭  ${s.table.padEnd(36)} already NOT NULL`);
        continue;
      }
      await client.query(`ALTER TABLE ${s.table} ALTER COLUMN workspace_id SET NOT NULL`);
      applied.push(s.table);
      console.log(`  🔒 ${s.table.padEnd(36)} SET NOT NULL`);
    }
    await client.query('COMMIT');
    console.log(`\n✅ NOT NULL applied to ${applied.length} table(s).`);
    if (applied.length) {
      console.log('\nRollback (if an unstamped insert path surfaces):');
      for (const t of applied) {
        console.log(`  ALTER TABLE ${t} ALTER COLUMN workspace_id DROP NOT NULL;`);
      }
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ NOT NULL apply failed, rolled back:', e.message);
    throw e;
  } finally {
    client.release();
  }
}

async function main() {
  try {
    const state = await verifyAndBackfill();
    if (APPLY_NOT_NULL) {
      if (process.exitCode === 1) {
        console.error('Skipping --apply-not-null because backfill verification failed.');
      } else {
        await applyNotNull(state);
      }
    } else {
      console.log(
        '\nℹ️  NOT NULL constraint NOT applied (reversible backfill only).\n' +
        '   The irreversible DDL step requires human sign-off (#1622). When approved:\n' +
        '     CONFIRM_NOT_NULL=yes node scripts/migrate-workspace-id-phase3-notnull.mjs --apply-not-null',
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch(() => process.exit(1));
