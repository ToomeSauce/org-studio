/**
 * #1590 — Embedding pipeline: embed corpus docs → upsert into pgvector.
 *
 * Idempotent (constraint): each doc has a stable id + contentHash. We only
 * re-embed rows whose content (or provider) changed. INSERT/UPSERT-only —
 * never destructive. The backfill script and the #1591 indexer both call
 * `indexDocs`.
 *
 * Thin IO layer over the pure provider/corpus modules. Network/DB live here;
 * the embedding math + extraction stay pure + unit-tested elsewhere.
 */
import { Pool } from 'pg';
import { defaultProvider, toPgVectorLiteral, providerColumn, type EmbeddingProvider } from './provider';
import type { CorpusDoc } from './corpus';

let _pool: Pool | null = null;
function getPool(): Pool {
  if (_pool) return _pool;
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL not set — embeddings require Postgres');
  _pool = new Pool({ connectionString: dbUrl, max: 4 });
  return _pool;
}

export interface IndexResult {
  considered: number;
  embedded: number; // rows actually (re)embedded + written
  skipped: number;  // unchanged (hash + provider match)
}

/**
 * Upsert a batch of corpus docs. For each doc:
 *   - if a row exists with the same id AND same content_hash AND same
 *     provider_id → skip (idempotent, no re-embed).
 *   - else → embed + UPSERT.
 *
 * Embedding is batched per provider call for the docs that actually need it.
 */
export async function indexDocs(
  docs: CorpusDoc[],
  provider: EmbeddingProvider = defaultProvider(),
  poolOverride?: Pool,
): Promise<IndexResult> {
  const pool = poolOverride || getPool();
  const result: IndexResult = { considered: docs.length, embedded: 0, skipped: 0 };
  if (docs.length === 0) return result;

  // Which docs already exist unchanged? One query for the batch.
  const ids = docs.map((d) => d.id);
  const existing = await pool.query<{ id: string; content_hash: string; provider_id: string }>(
    `SELECT id, content_hash, provider_id FROM org_studio_embeddings WHERE id = ANY($1::text[])`,
    [ids],
  );
  const existingMap = new Map(existing.rows.map((r) => [r.id, r]));

  const toEmbed = docs.filter((d) => {
    const ex = existingMap.get(d.id);
    return !(ex && ex.content_hash === d.contentHash && ex.provider_id === provider.id);
  });
  result.skipped = docs.length - toEmbed.length;
  if (toEmbed.length === 0) return result;

  const vectors = await provider.embed(toEmbed.map((d) => d.text));

  // The pgvector column depends on the provider's dim (embedding=256,
  // embedding_lg=1024). Validated against an allowlist so it can never be
  // attacker-controlled SQL.
  const col = providerColumn(provider);
  if (!/^embedding(_[a-z0-9]+)?$/.test(col)) {
    throw new Error(`unsafe embedding column: ${col}`);
  }

  // UPSERT each. Kept simple + safe; batch sizes here are small per cycle.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < toEmbed.length; i++) {
      const d = toEmbed[i];
      const vec = toPgVectorLiteral(vectors[i]);
      await client.query(
        `INSERT INTO org_studio_embeddings
           (id, source_type, ref_id, project_id, task_id, ticket_number, owner, title, text, content_hash, provider_id, ${col}, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::vector, now())
         ON CONFLICT (id) DO UPDATE SET
           source_type = EXCLUDED.source_type,
           ref_id = EXCLUDED.ref_id,
           project_id = EXCLUDED.project_id,
           task_id = EXCLUDED.task_id,
           ticket_number = EXCLUDED.ticket_number,
           owner = EXCLUDED.owner,
           title = EXCLUDED.title,
           text = EXCLUDED.text,
           content_hash = EXCLUDED.content_hash,
           provider_id = EXCLUDED.provider_id,
           ${col} = EXCLUDED.${col},
           updated_at = now()`,
        [
          d.id, d.sourceType, d.refId, d.projectId ?? null, d.taskId ?? null,
          d.ticketNumber ?? null, d.owner ?? null, d.title ?? null, d.text,
          d.contentHash, provider.id, vec,
        ],
      );
    }
    await client.query('COMMIT');
    result.embedded = toEmbed.length;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return result;
}

/**
 * Delete embeddings whose ref no longer exists (optional GC for the indexer).
 * Scoped by id list — only removes rows for the given source family that are
 * NOT in `keepIds`. Caller passes the full current id set for a source type.
 */
export async function pruneMissing(
  sourceType: string,
  keepIds: string[],
  poolOverride?: Pool,
): Promise<number> {
  const pool = poolOverride || getPool();
  const res = await pool.query(
    `DELETE FROM org_studio_embeddings WHERE source_type = $1 AND NOT (id = ANY($2::text[]))`,
    [sourceType, keepIds],
  );
  return res.rowCount || 0;
}
