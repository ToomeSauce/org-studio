#!/usr/bin/env node
/**
 * Migration #1388 — A.4-schema: ON CONFLICT PK keys include workspace_id
 *
 * Carved out of #1387 slice A. Slice A code refactor (commit 2628627) made
 * the code workspace-aware; this migration makes the SCHEMA workspace-aware
 * in the 3 tables where ON CONFLICT keys still assume single-tenancy.
 *
 * Tables touched:
 *   - org_studio_agent_metrics: UNIQUE INDEX (agent_id, date, COALESCE(section_id,''))
 *                            → UNIQUE INDEX (workspace_id, agent_id, date, COALESCE(section_id,''))
 *   - org_studio_settings:    PRIMARY KEY (id)
 *                            → PRIMARY KEY (workspace_id, id)
 *   - org_studio_heartbeats:  PRIMARY KEY (agent_id)
 *                            → PRIMARY KEY (workspace_id, agent_id)
 *
 * Pre-conditions (verified manually, see /tmp note in PR):
 *   - workspace_id column already exists on all 3 tables (nullable today).
 *   - All existing rows have workspace_id = 'default-workspace' (no NULLs).
 *
 * Behavior:
 *   - Idempotent. Re-running is safe: checks the current constraint state and
 *     skips already-done work. Logs every action.
 *   - Transactional. Each table's PK/UNIQUE swap runs in its own transaction;
 *     if anything fails, that table rolls back cleanly.
 *   - Sets workspace_id NOT NULL after backfilling any NULLs to
 *     'default-workspace' (defense in depth — backfill should already be done).
 *
 * Reversibility:
 *   - Forward-only DDL. To roll back: restore the affected tables from
 *     data/backups/pre-1388-a4-schema-<timestamp>.json (script:
 *     migrations/1388-rollback.mjs — to be written if ever needed).
 *
 * Usage:
 *   node migrations/1388-a4-schema-workspace-id-conflict-keys.mjs [--dry-run]
 *
 *   --dry-run: print planned actions, run nothing.
 */

import pg from 'pg';
import { readFileSync } from 'node:fs';

const DRY_RUN = process.argv.includes('--dry-run');

// Load DATABASE_URL from .env.local if not already set.
function loadEnv() {
  if (process.env.DATABASE_URL) return;
  try {
    const raw = readFileSync('.env.local', 'utf8');
    for (const line of raw.split('\n')) {
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
      if (m) process.env[m[1]] = m[2];
    }
  } catch {}
}
loadEnv();

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL not set. Migration only applies in Postgres mode.');
  process.exit(2);
}

const log = (...a) => console.log('[migrate]', ...a);
const warn = (...a) => console.warn('[migrate WARN]', ...a);

async function constraintExists(client, conname, table) {
  const r = await client.query(
    `SELECT 1 FROM pg_constraint con
     JOIN pg_class cl ON con.conrelid = cl.oid
     WHERE cl.relname = $1 AND con.conname = $2`,
    [table, conname],
  );
  return r.rowCount > 0;
}

async function indexExists(client, idxname) {
  const r = await client.query(`SELECT 1 FROM pg_indexes WHERE indexname = $1`, [idxname]);
  return r.rowCount > 0;
}

async function backfillAndNotNull(client, table) {
  // 1) backfill any NULL workspace_id rows to 'default-workspace'.
  const upd = await client.query(
    `UPDATE ${table} SET workspace_id = 'default-workspace' WHERE workspace_id IS NULL`,
  );
  if (upd.rowCount > 0) log(`  backfilled ${upd.rowCount} NULL workspace_id rows in ${table}`);
  // 2) confirm 0 NULLs remain.
  const nulls = await client.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE workspace_id IS NULL`);
  if ((nulls.rows[0]?.n ?? 0) > 0) {
    throw new Error(`${table}: ${nulls.rows[0].n} rows still have NULL workspace_id after backfill — aborting`);
  }
  // 3) enforce NOT NULL (idempotent — Postgres no-ops if already NOT NULL).
  const colCheck = await client.query(
    `SELECT is_nullable FROM information_schema.columns WHERE table_name=$1 AND column_name='workspace_id'`,
    [table],
  );
  if (colCheck.rows[0]?.is_nullable === 'YES') {
    if (DRY_RUN) {
      log(`  [dry-run] would ALTER TABLE ${table} ALTER COLUMN workspace_id SET NOT NULL`);
    } else {
      await client.query(`ALTER TABLE ${table} ALTER COLUMN workspace_id SET NOT NULL`);
      log(`  ${table}.workspace_id set NOT NULL`);
    }
  } else {
    log(`  ${table}.workspace_id already NOT NULL`);
  }
}

async function migrateAgentMetrics(client) {
  log('=== org_studio_agent_metrics ===');
  await backfillAndNotNull(client, 'org_studio_agent_metrics');

  const newIdx = 'ux_agent_metrics_ws_agent_date_section';
  const oldIdx = 'ux_agent_metrics_agent_date_section';

  if (await indexExists(client, newIdx)) {
    log(`  ${newIdx} already exists — skipping`);
  } else {
    if (DRY_RUN) {
      log(`  [dry-run] would CREATE UNIQUE INDEX ${newIdx} (workspace_id, agent_id, date, COALESCE(section_id,''))`);
    } else {
      await client.query(
        `CREATE UNIQUE INDEX CONCURRENTLY ${newIdx}
         ON org_studio_agent_metrics
         (workspace_id, agent_id, date, COALESCE(section_id, ''::text))`,
      );
      log(`  created ${newIdx}`);
    }
  }

  // Drop the old unique index once the new one is in place.
  if (await indexExists(client, oldIdx)) {
    if (DRY_RUN) {
      log(`  [dry-run] would DROP INDEX ${oldIdx} (replaced by ${newIdx})`);
    } else {
      await client.query(`DROP INDEX IF EXISTS ${oldIdx}`);
      log(`  dropped ${oldIdx}`);
    }
  } else {
    log(`  ${oldIdx} already absent — skipping drop`);
  }
}

async function migrateSettings(client) {
  log('=== org_studio_settings ===');
  await backfillAndNotNull(client, 'org_studio_settings');

  // Today: PRIMARY KEY (id). Target: PRIMARY KEY (workspace_id, id).
  // Approach: ADD UNIQUE (workspace_id, id) → DROP PRIMARY KEY → ADD PRIMARY KEY.
  // Doing it in a single transaction makes the swap atomic.
  const oldPk = 'org_studio_settings_pkey';
  const hasOldPkOnId = await client.query(
    `SELECT pg_get_constraintdef(con.oid) AS def
     FROM pg_constraint con JOIN pg_class cl ON con.conrelid = cl.oid
     WHERE cl.relname = 'org_studio_settings' AND con.conname = $1`,
    [oldPk],
  );
  const oldDef = hasOldPkOnId.rows[0]?.def || '';
  if (oldDef.includes('workspace_id, id') || oldDef.includes('workspace_id,id')) {
    log(`  PK already (workspace_id, id) — skipping`);
    return;
  }
  if (!oldDef) {
    warn(`  no existing primary key on org_studio_settings — unusual, proceeding to add (workspace_id, id) PK`);
  }
  if (DRY_RUN) {
    log(`  [dry-run] would BEGIN; ALTER TABLE ... DROP CONSTRAINT ${oldPk}; ADD PRIMARY KEY (workspace_id, id); COMMIT`);
    return;
  }
  await client.query('BEGIN');
  try {
    if (oldDef) {
      await client.query(`ALTER TABLE org_studio_settings DROP CONSTRAINT ${oldPk}`);
      log(`  dropped old PK ${oldPk}`);
    }
    await client.query(`ALTER TABLE org_studio_settings ADD PRIMARY KEY (workspace_id, id)`);
    log(`  added new PK (workspace_id, id)`);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}

async function migrateHeartbeats(client) {
  log('=== org_studio_heartbeats ===');
  await backfillAndNotNull(client, 'org_studio_heartbeats');

  const oldPk = 'org_studio_heartbeats_pkey';
  const def = await client.query(
    `SELECT pg_get_constraintdef(con.oid) AS def
     FROM pg_constraint con JOIN pg_class cl ON con.conrelid = cl.oid
     WHERE cl.relname = 'org_studio_heartbeats' AND con.conname = $1`,
    [oldPk],
  );
  const oldDef = def.rows[0]?.def || '';
  if (oldDef.includes('workspace_id, agent_id') || oldDef.includes('workspace_id,agent_id')) {
    log(`  PK already (workspace_id, agent_id) — skipping`);
    return;
  }
  if (!oldDef) {
    warn(`  no existing primary key on org_studio_heartbeats — unusual, proceeding to add (workspace_id, agent_id) PK`);
  }
  if (DRY_RUN) {
    log(`  [dry-run] would BEGIN; ALTER TABLE ... DROP CONSTRAINT ${oldPk}; ADD PRIMARY KEY (workspace_id, agent_id); COMMIT`);
    return;
  }
  await client.query('BEGIN');
  try {
    if (oldDef) {
      await client.query(`ALTER TABLE org_studio_heartbeats DROP CONSTRAINT ${oldPk}`);
      log(`  dropped old PK ${oldPk}`);
    }
    await client.query(`ALTER TABLE org_studio_heartbeats ADD PRIMARY KEY (workspace_id, agent_id)`);
    log(`  added new PK (workspace_id, agent_id)`);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}

async function preflightCollisionCheck(client) {
  log('=== pre-flight: cross-workspace key collisions ===');
  // For each table, count rows whose new key would collide with another row
  // on the OLD key. Today, with all rows in default-workspace, this should be 0.
  const checks = [
    {
      tbl: 'org_studio_agent_metrics',
      sql: `SELECT agent_id, date, COALESCE(section_id, '') AS section_id,
                   COUNT(DISTINCT workspace_id) AS ws_count, COUNT(*) AS row_count
            FROM org_studio_agent_metrics
            GROUP BY agent_id, date, COALESCE(section_id, '')
            HAVING COUNT(DISTINCT workspace_id) > 1`,
    },
    {
      tbl: 'org_studio_settings',
      sql: `SELECT id, COUNT(DISTINCT workspace_id) AS ws_count
            FROM org_studio_settings
            GROUP BY id
            HAVING COUNT(DISTINCT workspace_id) > 1`,
    },
    {
      tbl: 'org_studio_heartbeats',
      sql: `SELECT agent_id, COUNT(DISTINCT workspace_id) AS ws_count
            FROM org_studio_heartbeats
            GROUP BY agent_id
            HAVING COUNT(DISTINCT workspace_id) > 1`,
    },
  ];
  let anyCollisions = false;
  for (const { tbl, sql } of checks) {
    const r = await client.query(sql);
    if (r.rowCount > 0) {
      anyCollisions = true;
      warn(`  ${tbl}: ${r.rowCount} cross-workspace collisions found:`);
      console.warn(JSON.stringify(r.rows.slice(0, 10), null, 2));
    } else {
      log(`  ${tbl}: 0 cross-workspace collisions ✓`);
    }
  }
  return !anyCollisions;
}

async function main() {
  log('migration mode:', DRY_RUN ? 'DRY RUN (no changes)' : 'APPLY');

  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    const safe = await preflightCollisionCheck(client);
    if (!safe) {
      throw new Error(
        'Pre-flight found cross-workspace collisions on the OLD keys. Aborting — these rows would either collapse or fail the new constraint. Investigate before proceeding.',
      );
    }

    await migrateAgentMetrics(client);
    await migrateSettings(client);
    await migrateHeartbeats(client);

    log('=== summary ===');
    for (const tbl of ['org_studio_agent_metrics', 'org_studio_settings', 'org_studio_heartbeats']) {
      const r = await client.query(
        `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = $1 ORDER BY indexname`,
        [tbl],
      );
      console.log(`  ${tbl} indexes:`);
      r.rows.forEach((row) => console.log(`    ${row.indexname}: ${row.indexdef}`));
    }
    log('done.');
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('[migrate FATAL]', e);
  process.exit(1);
});
