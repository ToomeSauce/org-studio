#!/usr/bin/env node
/**
 * backfill-embeddings.mjs (#1590)
 *
 * One-shot (and safely re-runnable) backfill that embeds the existing
 * decision corpus into org_studio_embeddings. Idempotent: only re-embeds
 * docs whose content changed (content_hash) — re-runs are cheap.
 *
 * Sources (v1): task descriptions/comments/reviewNotes/statusHistory-notes/
 * blocked-reasons (read via the store API) + vision docs (read from
 * org_studio_vision_docs, which also contain change-history sections).
 *
 * Usage:
 *   DATABASE_URL=... ORG_STUDIO_API_KEY=... node scripts/backfill-embeddings.mjs
 *   (optional) ORG_STUDIO_URL=http://localhost:4501
 *
 * Run scripts/migrate-embeddings.mjs FIRST.
 */
import pg from 'pg';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const { Pool } = pg;
const BASE = process.env.ORG_STUDIO_URL || 'http://localhost:4501';
const KEY = process.env.ORG_STUDIO_API_KEY || '';
const DB = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!DB) { console.error('DATABASE_URL not set'); process.exit(1); }

// Load the compiled TS helpers via tsx if available; otherwise inline a tiny
// re-implementation is avoided — we import the source through the project's
// module resolution. Run with: npx tsx scripts/backfill-embeddings.mjs
const { buildCorpus } = await import('../src/lib/embedding/corpus.ts');
const { indexDocs } = await import('../src/lib/embedding/pipeline.ts');
const { defaultProvider } = await import('../src/lib/embedding/provider.ts');

async function main() {
  // 1. Tasks via store API.
  const storeRes = await fetch(`${BASE}/api/store`, {
    headers: KEY ? { Authorization: `Bearer ${KEY}` } : {},
  });
  if (!storeRes.ok) throw new Error(`store fetch failed: ${storeRes.status}`);
  const store = await storeRes.json();
  const tasks = store.tasks || [];

  // 2. Vision docs from Postgres.
  const pool = new Pool({ connectionString: DB, max: 3 });
  let visionDocs = [];
  try {
    const vr = await pool.query(
      `SELECT project_id, content FROM org_studio_vision_docs`,
    );
    visionDocs = vr.rows.map((r) => ({ projectId: r.project_id, title: 'Vision', content: r.content }));
  } catch (e) {
    console.warn('vision docs read failed (non-fatal):', e.message);
  }

  const corpus = buildCorpus({ tasks, visionDocs });
  console.log(`[backfill] corpus docs: ${corpus.length} (tasks=${tasks.length}, visionDocs=${visionDocs.length})`);

  const provider = defaultProvider();
  console.log(`[backfill] provider: ${provider.id}`);

  // Index in batches to keep memory + embed calls bounded.
  const BATCH = 200;
  let embedded = 0, skipped = 0;
  for (let i = 0; i < corpus.length; i += BATCH) {
    const slice = corpus.slice(i, i + BATCH);
    const r = await indexDocs(slice, provider, pool);
    embedded += r.embedded; skipped += r.skipped;
    console.log(`[backfill] ${Math.min(i + BATCH, corpus.length)}/${corpus.length} — embedded=${r.embedded} skipped=${r.skipped}`);
  }
  console.log(`[backfill] DONE. embedded=${embedded} skipped=${skipped}`);
  await pool.end();
}

main().catch((e) => { console.error('[backfill] FAILED:', e); process.exit(1); });
