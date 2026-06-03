#!/usr/bin/env node
/**
 * migrate-embeddings.mjs (#1590)
 *
 * Enables pgvector and creates org_studio_embeddings — the vector store for
 * the org-memory corpus. Safe to re-run (IF NOT EXISTS everywhere). No data
 * is dropped or altered destructively; this is additive.
 *
 * Reversible: `DROP TABLE org_studio_embeddings;` (+ optionally
 * `DROP EXTENSION vector;`) fully undoes it. No other table is touched.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/migrate-embeddings.mjs
 *
 * EMBEDDING_DIM must match src/lib/embedding/provider.ts (256).
 */
import pg from 'pg';
const { Pool } = pg;

const DIM = 256; // keep in sync with EMBEDDING_DIM
const CONNECTION_STRING = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!CONNECTION_STRING) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const pool = new Pool({ connectionString: CONNECTION_STRING, max: 3 });

async function run() {
  const client = await pool.connect();
  try {
    console.log('[migrate-embeddings] enabling pgvector…');
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');

    console.log('[migrate-embeddings] creating org_studio_embeddings…');
    await client.query(`
      CREATE TABLE IF NOT EXISTS org_studio_embeddings (
        id            TEXT PRIMARY KEY,
        source_type   TEXT NOT NULL,
        ref_id        TEXT NOT NULL,
        project_id    TEXT,
        task_id       TEXT,
        ticket_number INTEGER,
        owner         TEXT,
        title         TEXT,
        text          TEXT NOT NULL,
        content_hash  TEXT NOT NULL,
        provider_id   TEXT NOT NULL,
        embedding     vector(${DIM}) NOT NULL,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Filter indexes for the search endpoint's optional project/owner filters.
    await client.query(`CREATE INDEX IF NOT EXISTS idx_org_embeddings_project ON org_studio_embeddings (project_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_org_embeddings_source ON org_studio_embeddings (source_type)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_org_embeddings_owner ON org_studio_embeddings (owner)`);

    // ANN index for cosine search. ivfflat needs ANALYZE + data to be useful;
    // it's created up-front and works (falls back to exact scan when small).
    // `lists` is conservative for a corpus in the low thousands.
    try {
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_org_embeddings_vec
           ON org_studio_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`,
      );
      console.log('[migrate-embeddings] ivfflat cosine index ready');
    } catch (e) {
      // Some managed PGs gate ivfflat; the table + exact search still work.
      console.warn('[migrate-embeddings] ivfflat index skipped (non-fatal):', e.message);
    }

    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM org_studio_embeddings`,
    );
    console.log(`[migrate-embeddings] done. existing rows: ${rows[0].n}`);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((e) => {
  console.error('[migrate-embeddings] FAILED:', e);
  process.exit(1);
});
