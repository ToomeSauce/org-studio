#!/usr/bin/env node
/**
 * add-version-meta-column.mjs (#1263)
 *
 * Adds a nullable `meta` jsonb column to `org_studio_roadmap_versions`.
 * Idempotent (`ADD COLUMN IF NOT EXISTS`) \u2014 safe to run multiple times.
 *
 * The column holds outcome-bound version fields:
 *   - successCriteria, metricCurrent, metricTarget, metricComparator,
 *     loopPaused, metricNotMetCommentedAt, systemComments[]
 *
 * Reads DATABASE_URL from env. Run from repo root:
 *   node scripts/add-version-meta-column.mjs
 *   # or
 *   DATABASE_URL=$(grep -E '^DATABASE_URL=' .env.local | cut -d= -f2-) node scripts/add-version-meta-column.mjs
 */

import pg from 'pg';
import fs from 'fs';
import path from 'path';

const { Pool } = pg;

function loadEnvLocal() {
  // Tiny .env.local loader so this script Just Works without external deps.
  if (process.env.DATABASE_URL) return;
  try {
    const envPath = path.resolve(process.cwd(), '.env.local');
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[m[1]]) process.env[m[1]] = val;
    }
  } catch {
    /* ignore */
  }
}

async function main() {
  loadEnvLocal();
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set. Aborting.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    console.log('[add-version-meta-column] connecting...');
    // Idempotent add. Postgres 9.6+ supports IF NOT EXISTS on ADD COLUMN.
    await client.query(
      `ALTER TABLE org_studio_roadmap_versions ADD COLUMN IF NOT EXISTS meta jsonb`
    );

    const check = await client.query(
      `SELECT column_name, data_type
         FROM information_schema.columns
        WHERE table_name = 'org_studio_roadmap_versions' AND column_name = 'meta'`
    );
    if (check.rows.length === 0) {
      throw new Error('meta column not found after ADD COLUMN');
    }
    console.log(
      `[add-version-meta-column] OK \u2014 ${check.rows[0].column_name} (${check.rows[0].data_type})`
    );
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[add-version-meta-column] FAILED:', err?.message || err);
  process.exit(1);
});
