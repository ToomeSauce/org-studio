/**
 * Azure text-embedding-3-large (1024-dim) migration + backfill.
 *
 * Additive + reversible:
 *   - ADD COLUMN IF NOT EXISTS embedding_lg vector(1024)  (existing 256-dim
 *     `embedding` column untouched).
 *   - hnsw cosine index on embedding_lg (better recall than ivfflat; 1024 is
 *     under every dim cap).
 *   - re-embed every corpus doc with the Azure provider → writes embedding_lg
 *     + flips provider_id to azure-te3l-d1024. Idempotent via content_hash +
 *     provider_id, so re-runs only embed changed rows.
 *
 * Rollback: DROP COLUMN embedding_lg (and the index) — the hashing 256-dim
 * search path keeps working unchanged.
 *
 * Run: node scripts/backfill-azure-embeddings.mjs
 * Env: DATABASE_URL, AZURE_EMBEDDING_ENDPOINT, AZURE_EMBEDDING_KEY,
 *      AZURE_EMBEDDING_DEPLOYMENT (+ optional AZURE_EMBEDDING_DIM).
 */
import pg from 'pg';

const { Pool } = pg;
const BASE = process.env.ORG_STUDIO_BASE || 'http://localhost:4501';
const KEY = process.env.ORG_STUDIO_API_KEY;

const { buildCorpus } = await import('../src/lib/embedding/corpus.ts');
const { indexDocs } = await import('../src/lib/embedding/pipeline.ts');
const { azureProviderFromEnv } = await import('../src/lib/embedding/azure-provider.ts');

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL not set');
  const provider = azureProviderFromEnv();
  if (!provider) throw new Error('Azure embedding env not configured (AZURE_EMBEDDING_ENDPOINT/KEY/DEPLOYMENT)');
  console.log(`[azure-backfill] provider=${provider.id} dim=${provider.dim} column=${provider.column}`);

  const pool = new Pool({ connectionString: dbUrl, max: 4 });

  // 1) schema: additive column + hnsw index (rollback = DROP COLUMN).
  await pool.query(`ALTER TABLE org_studio_embeddings ADD COLUMN IF NOT EXISTS ${provider.column} vector(${provider.dim})`);
  console.log(`[azure-backfill] ensured column ${provider.column} vector(${provider.dim})`);
  // A row may now carry ONLY the large vector (new docs embedded after the
  // switch), so the original 256-dim column must allow NULL. Reversible.
  await pool.query(`ALTER TABLE org_studio_embeddings ALTER COLUMN embedding DROP NOT NULL`)
    .catch((e) => console.warn('[azure-backfill] drop-not-null warn:', e.message));
  console.log('[azure-backfill] embedding column now nullable');
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_org_embeddings_lg
       ON org_studio_embeddings USING hnsw (${provider.column} vector_cosine_ops)`,
  ).catch((e) => console.warn('[azure-backfill] hnsw index warn:', e.message));
  console.log('[azure-backfill] ensured hnsw index');

  // 2) tasks via store API (full objects incl. comments), vision docs via PG.
  const storeRes = await fetch(`${BASE}/api/store`, { headers: KEY ? { Authorization: `Bearer ${KEY}` } : {} });
  if (!storeRes.ok) throw new Error(`store fetch failed: ${storeRes.status}`);
  const store = await storeRes.json();
  const tasks = store.tasks || [];
  let visionDocs = [];
  try {
    const vr = await pool.query(`SELECT project_id, content FROM org_studio_vision_docs`);
    visionDocs = vr.rows.map((r) => ({ projectId: r.project_id, title: 'Vision', content: r.content }));
  } catch (e) {
    console.warn('[azure-backfill] vision docs read failed (non-fatal):', e.message);
  }

  const docs = buildCorpus({ tasks, visionDocs });
  console.log(`[azure-backfill] corpus docs: ${docs.length} (tasks=${tasks.length}, visionDocs=${visionDocs.length})`);

  const BATCH = 200;
  let embedded = 0, skipped = 0;
  for (let i = 0; i < docs.length; i += BATCH) {
    const slice = docs.slice(i, i + BATCH);
    const r = await indexDocs(slice, provider, pool);
    embedded += r.embedded; skipped += r.skipped;
    console.log(`[azure-backfill] ${Math.min(i + BATCH, docs.length)}/${docs.length} (embedded=${embedded} skipped=${skipped})`);
  }

  console.log(`[azure-backfill] DONE embedded=${embedded} skipped=${skipped}`);
  await pool.end();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
