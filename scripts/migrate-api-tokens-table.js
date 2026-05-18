#!/usr/bin/env node
/**
 * migrate-api-tokens-table.js  (#1383, Phase 1)
 *
 * Creates the org_studio_api_tokens table for per-agent / per-service-account
 * API tokens with optional scoping (read vs write).
 *
 * Tokens are stored as SHA-256 hashes; plaintext is surfaced only at mint time
 * and never logged. Revocation is soft (revoked_at timestamp) so audit trail
 * is preserved.
 *
 * Safe to re-run (IF NOT EXISTS).
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/migrate-api-tokens-table.js
 *
 * IMPORTANT: this migration is reversible (DROP TABLE + redeploy). The
 * feature is gated by ENABLE_PER_AGENT_TOKENS (default off), so creating the
 * table doesn't activate any new auth path. See #1383 for the cutover plan.
 */

const { Pool } = require('pg');

const CONNECTION_STRING = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!CONNECTION_STRING) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}

const pool = new Pool({ connectionString: CONNECTION_STRING, max: 2 });

async function run() {
  const client = await pool.connect();
  try {
    console.log('Creating org_studio_api_tokens table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS org_studio_api_tokens (
        id           TEXT PRIMARY KEY,
        token_hash   TEXT NOT NULL UNIQUE,
        user_id      TEXT NOT NULL,
        label        TEXT NOT NULL,
        scope        TEXT NOT NULL CHECK (scope IN ('read', 'write')),
        created_at   BIGINT NOT NULL,
        created_by   TEXT,
        last_used_at BIGINT,
        revoked_at   BIGINT,
        workspace_id TEXT NOT NULL DEFAULT 'default-workspace'
      )
    `);

    // Lookups always hit token_hash; partial index excludes revoked rows so
    // verify-path queries stay fast even after years of revocations.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_api_tokens_active_hash
        ON org_studio_api_tokens (token_hash)
        WHERE revoked_at IS NULL
    `);

    // Admin "list tokens for user X" view.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_api_tokens_user
        ON org_studio_api_tokens (workspace_id, user_id)
    `);

    console.log('✅ org_studio_api_tokens table ready.');
    console.log('   Feature is gated by ENABLE_PER_AGENT_TOKENS (default off).');
    console.log('   Run with ENABLE_PER_AGENT_TOKENS=true once #1290 sign-off is complete.');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((e) => {
  console.error('Migration failed:', e);
  process.exit(1);
});
