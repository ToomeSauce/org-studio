#!/usr/bin/env node
/**
 * Migration #1387 B.3 — org_studio_admin_audit
 *
 * Append-only audit log for break-glass (global ORG_STUDIO_API_KEY) admin
 * actions. When a B.2-gated endpoint accepts a request via the break-glass
 * path (instead of a real user session or per-agent token), a row is
 * written here.
 *
 * Why: the global API key has no user identity. Without this table, any
 * agent loop or cron path using the global key is invisible — we can't
 * tell who/what mutated a workspace. With this table, every break-glass
 * mutation is traceable.
 *
 * Schema:
 *   id          BIGSERIAL PRIMARY KEY
 *   workspace_id TEXT NOT NULL         — workspace the action targeted
 *   user_id     TEXT                   — NULL when via='break-glass' and no
 *                                        session, populated otherwise
 *   action      TEXT NOT NULL          — e.g. 'backups.restore', 'vision.doc.put'
 *   endpoint    TEXT NOT NULL          — request URL pathname
 *   method      TEXT NOT NULL          — HTTP method
 *   via         TEXT NOT NULL          — 'session' | 'agent-token' | 'break-glass'
 *   request_meta JSONB                  — { ip?, userAgent?, targetId? }
 *   created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
 *
 * Indexes:
 *   (workspace_id, created_at DESC)  — list recent activity per workspace
 *   (action, created_at DESC)        — filter by action type
 *
 * Idempotency: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
 * Reversibility: DROP TABLE org_studio_admin_audit; (pure additive table).
 *
 * Usage:
 *   node migrations/1387-b3-admin-audit-table.mjs --dry-run
 *   node migrations/1387-b3-admin-audit-table.mjs
 */

import pg from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DRY_RUN = process.argv.includes('--dry-run');

function loadEnv() {
  try {
    const raw = readFileSync(join(process.cwd(), '.env.local'), 'utf-8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch {}
}
loadEnv();

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set. Set it or place it in .env.local.');
  process.exit(1);
}

const SQL_CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS org_studio_admin_audit (
  id            BIGSERIAL PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  user_id       TEXT,
  action        TEXT NOT NULL,
  endpoint      TEXT NOT NULL,
  method        TEXT NOT NULL,
  via           TEXT NOT NULL CHECK (via IN ('session','agent-token','break-glass')),
  request_meta  JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

const SQL_INDEX_WS = `
CREATE INDEX IF NOT EXISTS idx_admin_audit_workspace_created
  ON org_studio_admin_audit (workspace_id, created_at DESC);
`;

const SQL_INDEX_ACTION = `
CREATE INDEX IF NOT EXISTS idx_admin_audit_action_created
  ON org_studio_admin_audit (action, created_at DESC);
`;

async function main() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    // Pre-flight: does the table already exist?
    const exists = await client.query(
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'org_studio_admin_audit') AS present`,
    );
    const present = exists.rows[0].present;
    console.log(`[pre-flight] org_studio_admin_audit exists: ${present}`);

    if (DRY_RUN) {
      console.log('--- DRY RUN ---');
      console.log('Would execute:');
      console.log(SQL_CREATE_TABLE.trim());
      console.log(SQL_INDEX_WS.trim());
      console.log(SQL_INDEX_ACTION.trim());
      return;
    }

    await client.query('BEGIN');
    try {
      await client.query(SQL_CREATE_TABLE);
      await client.query(SQL_INDEX_WS);
      await client.query(SQL_INDEX_ACTION);
      await client.query('COMMIT');
      console.log('[done] org_studio_admin_audit created (or already present)');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }

    // Verify
    const verify = await client.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_name = 'org_studio_admin_audit' ORDER BY ordinal_position`,
    );
    console.log('[verify] columns:');
    for (const r of verify.rows) {
      console.log(`  ${r.column_name.padEnd(15)} ${r.data_type.padEnd(20)} ${r.is_nullable === 'NO' ? 'NOT NULL' : ''}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('migration failed:', e.message);
  process.exit(1);
});
