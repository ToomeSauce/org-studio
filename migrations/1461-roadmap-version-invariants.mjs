#!/usr/bin/env node
/**
 * Migration #1461 — Roadmap version invariants
 *
 * Adds (add-only, reversible) schema guardrails to org_studio_roadmap_versions:
 *
 *   1. CHECK constraint on `version_type` allowing the extended set:
 *      {outcome, foundation, chore, qa, gtm}. Existing rows are NOT touched
 *      — they're all already in the legacy 3-value set.
 *
 *   2. Partial UNIQUE INDEX enforcing "at most one row per
 *      (workspace_id, project_id) WHERE status='current'". This is the
 *      single-current invariant. Per the ticket, we explicitly DO NOT
 *      auto-repair historical multi-current violations. If any exist,
 *      the migration:
 *        - Logs them (so the human can see what needs fixing).
 *        - SKIPS the unique-index creation.
 *        - Exits 0 (non-fatal — the API-layer enforcement is added in the
 *          same PR and catches all new writes regardless).
 *      Re-running the migration after the human cleans up the violations
 *      will then add the partial unique index.
 *
 * Why per-(workspace_id, project_id) not per-(workspace_id, project_id,
 * section_id)? The current schema doesn't store sectionId on the version
 * row — versions are per-project. The ticket discussion notes
 * "per-component" as the ideal future shape but the table doesn't support
 * it yet. Per-project single-current is the closest invariant we can
 * enforce without a deeper refactor (which the ticket scopes out: "No UI
 * work in this ticket — surface the new capabilities via the API and
 * skill. UI updates ... get their own follow-up.").
 *
 * Reversibility:
 *   - Schema changes are add-only (new CHECK, new partial unique index).
 *     Drop with `ALTER TABLE ... DROP CONSTRAINT` + `DROP INDEX` if needed.
 *   - No data mutation (no auto-repair).
 *
 * Idempotent: safe to re-run. Each step checks current schema state.
 *
 * Usage:
 *   node migrations/1461-roadmap-version-invariants.mjs [--dry-run]
 */

import pg from 'pg';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env.local
try {
  const envPath = join(__dirname, '..', '.env.local');
  const env = readFileSync(envPath, 'utf-8');
  for (const line of env.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq);
    const v = trimmed.slice(eq + 1);
    if (!process.env[k]) process.env[k] = v;
  }
} catch {}

const DRY_RUN = process.argv.includes('--dry-run');
const CHECK_NAME = 'org_studio_roadmap_versions_version_type_check';
const PARTIAL_INDEX = 'idx_roadmap_one_current_per_project';
const ALLOWED_VERSION_TYPES = ['outcome', 'foundation', 'chore', 'qa', 'gtm'];

function log(msg) {
  console.log(`[1461] ${msg}`);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    log('No DATABASE_URL — nothing to do (OSS file-mode).');
    return;
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const c = await pool.connect();
  try {
    log(`Mode: ${DRY_RUN ? 'DRY RUN (no DDL will execute)' : 'APPLY'}`);

    // -------------------------------------------------------------------
    // Step 1 — CHECK constraint on version_type
    // -------------------------------------------------------------------
    const existingCheck = await c.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = $1`,
      [CHECK_NAME]
    );
    const wantedDefFragment = ALLOWED_VERSION_TYPES.map(t => `'${t}'::text`).join(', ');
    const existingDef = existingCheck.rows[0]?.def || '';
    // Acceptance: every wanted value must appear in the existing definition.
    // (Postgres canonicalizes the array order, so substring-match each value.)
    const upToDate = existingCheck.rows.length > 0 &&
      ALLOWED_VERSION_TYPES.every(t => existingDef.includes(`'${t}'`));

    if (upToDate) {
      log(`✓ CHECK constraint ${CHECK_NAME} already covers all ${ALLOWED_VERSION_TYPES.length} types — skipping.`);
    } else {
      // Verify all existing rows already comply (they should — old set
      // {outcome, foundation, chore} is a strict subset of the new set).
      const bad = await c.query(
        `SELECT id, version_type FROM org_studio_roadmap_versions
          WHERE version_type IS NOT NULL
            AND version_type <> ALL($1::text[])`,
        [ALLOWED_VERSION_TYPES]
      );
      if (bad.rows.length > 0) {
        log(`⚠️  ${bad.rows.length} row(s) have an out-of-set version_type. Aborting CHECK creation.`);
        log(`    Examples: ${bad.rows.slice(0, 5).map(r => `${r.id}=${r.version_type}`).join(', ')}`);
      } else {
        const dropSql = `ALTER TABLE org_studio_roadmap_versions DROP CONSTRAINT IF EXISTS ${CHECK_NAME}`;
        const addSql = `ALTER TABLE org_studio_roadmap_versions
          ADD CONSTRAINT ${CHECK_NAME}
          CHECK (version_type IS NULL OR version_type IN (${ALLOWED_VERSION_TYPES.map(t => `'${t}'`).join(',')}))`;
        if (DRY_RUN) {
          log(`DRY: existing def = ${existingDef || '(none)'}`);
          log(`DRY: would execute:\n  ${dropSql};\n  ${addSql}`);
        } else {
          if (existingCheck.rows.length > 0) {
            log(`  Existing def is stale (${existingDef}). Dropping + recreating.`);
            await c.query(dropSql);
          }
          await c.query(addSql);
          log(`✓ CHECK constraint ${CHECK_NAME} now allows: ${ALLOWED_VERSION_TYPES.join(', ')}.`);
        }
      }
    }

    // -------------------------------------------------------------------
    // Step 2 — Partial unique index for single-current
    // -------------------------------------------------------------------
    const existingIdx = await c.query(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'org_studio_roadmap_versions'
          AND indexname = $1`,
      [PARTIAL_INDEX]
    );
    if (existingIdx.rows.length > 0) {
      log(`✓ Partial unique index ${PARTIAL_INDEX} already exists — skipping.`);
    } else {
      // Detect violations first (single-current invariant).
      const viol = await c.query(
        `SELECT workspace_id, project_id, COUNT(*) AS n,
                array_agg(version ORDER BY sort_order) AS versions
           FROM org_studio_roadmap_versions
          WHERE status = 'current'
          GROUP BY workspace_id, project_id
          HAVING COUNT(*) > 1`
      );
      if (viol.rows.length > 0) {
        log(`⚠️  Found ${viol.rows.length} multi-current violation(s). SKIPPING index creation.`);
        log(`    Per ticket #1461 constraints: don't auto-repair historical bad data.`);
        log(`    Use the /api/admin/roadmap-audit endpoint to surface these.`);
        log(`    After human cleanup, re-run this migration to add the index.`);
        for (const r of viol.rows) {
          log(`    - workspace=${r.workspace_id} project=${r.project_id} versions=${r.versions.join(',')}`);
        }
      } else {
        const sql = `CREATE UNIQUE INDEX ${PARTIAL_INDEX}
          ON org_studio_roadmap_versions (workspace_id, project_id)
          WHERE status = 'current'`;
        if (DRY_RUN) {
          log(`DRY: would execute:\n  ${sql}`);
        } else {
          await c.query(sql);
          log(`✓ Added partial unique index ${PARTIAL_INDEX} (one 'current' per (workspace, project)).`);
        }
      }
    }

    log('Done.');
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('[1461] FAILED:', e.message);
  process.exit(1);
});
