/**
 * #1592 — Semantic retrieval over the org-memory vector store.
 *
 * Runtime-neutral: any agent (OpenClaw or Hermes) hits POST/GET
 * /api/memory/search and gets ranked snippets with source citations. This
 * module owns the query → embedding → pgvector cosine search → cited results
 * pipeline. The route is a thin HTTP shell over `searchMemory`.
 *
 * Citations are first-class (#1592 constraint): every result carries the
 * source type, project, task/ticket, owner, title, and a deep link so the
 * agent can VERIFY rather than trust a bare snippet.
 */
import { Pool } from 'pg';
import { defaultProvider, toPgVectorLiteral, providerColumn, type EmbeddingProvider } from './provider';
import type { CorpusSourceType } from './corpus';

let _pool: Pool | null = null;
function getPool(): Pool {
  if (_pool) return _pool;
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL not set — memory search requires Postgres');
  _pool = new Pool({ connectionString: dbUrl, max: 4 });
  return _pool;
}

export interface MemorySearchFilters {
  projectId?: string;
  owner?: string;
  sourceTypes?: CorpusSourceType[];
}

export interface MemorySearchHit {
  id: string;
  sourceType: string;
  score: number; // cosine similarity in [−1, 1]; higher = closer
  text: string;
  citation: {
    projectId?: string;
    taskId?: string;
    ticketNumber?: number;
    owner?: string;
    title?: string;
    /** Deep link into Org Studio for verification. */
    link?: string;
  };
}

export interface MemorySearchResult {
  query: string;
  provider: string;
  count: number;
  results: MemorySearchHit[];
}

/** Clamp + default the result limit. */
export function normalizeLimit(raw: unknown, def = 8, max = 50): number {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

/** Build a deep link for a hit so agents can verify the source. */
export function buildLink(row: { project_id?: string; task_id?: string; source_type?: string }): string | undefined {
  if (row.task_id) {
    // Task detail panel deep-link (project board + task focus).
    const proj = row.project_id ? `projectId=${encodeURIComponent(row.project_id)}&` : '';
    return `/board?${proj}task=${encodeURIComponent(row.task_id)}`;
  }
  if (row.source_type === 'vision-doc' && row.project_id) {
    return `/vision/${encodeURIComponent(row.project_id)}`;
  }
  if (row.project_id) return `/board?projectId=${encodeURIComponent(row.project_id)}`;
  return undefined;
}

/**
 * Run a semantic search. Embeds the query with the SAME provider used at
 * index time, then orders by pgvector cosine distance (`<=>`). Optional
 * project/owner/source-type filters are applied in SQL.
 */
export async function searchMemory(
  query: string,
  filters: MemorySearchFilters = {},
  limit = 8,
  provider: EmbeddingProvider = defaultProvider(),
  poolOverride?: Pool,
): Promise<MemorySearchResult> {
  const q = (query || '').trim();
  if (q === '') return { query: '', provider: provider.id, count: 0, results: [] };

  const pool = poolOverride || getPool();
  const [qv] = await provider.embed([q]);
  const vecLit = toPgVectorLiteral(qv);

  // Build WHERE incrementally. $1 is always the query vector.
  const where: string[] = ['provider_id = $2'];
  const params: any[] = [vecLit, provider.id];
  let p = 3;
  if (filters.projectId) { where.push(`project_id = $${p++}`); params.push(filters.projectId); }
  if (filters.owner) { where.push(`owner = $${p++}`); params.push(filters.owner); }
  if (filters.sourceTypes && filters.sourceTypes.length > 0) {
    where.push(`source_type = ANY($${p++}::text[])`);
    params.push(filters.sourceTypes);
  }
  const lim = normalizeLimit(limit);
  params.push(lim);
  const limIdx = p;

  // Provider-specific pgvector column (embedding=256, embedding_lg=1024),
  // allowlist-validated so it can never be injected.
  const col = providerColumn(provider);
  if (!/^embedding(_[a-z0-9]+)?$/.test(col)) {
    throw new Error(`unsafe embedding column: ${col}`);
  }

  const sql =
    `SELECT id, source_type, project_id, task_id, ticket_number, owner, title, text,
            1 - (${col} <=> $1::vector) AS score
       FROM org_studio_embeddings
      WHERE ${where.join(' AND ')} AND ${col} IS NOT NULL
      ORDER BY ${col} <=> $1::vector
      LIMIT $${limIdx}`;

  const res = await pool.query(sql, params);
  const results: MemorySearchHit[] = res.rows.map((r: any) => ({
    id: r.id,
    sourceType: r.source_type,
    score: typeof r.score === 'number' ? r.score : Number(r.score),
    text: r.text,
    citation: {
      projectId: r.project_id ?? undefined,
      taskId: r.task_id ?? undefined,
      ticketNumber: r.ticket_number ?? undefined,
      owner: r.owner ?? undefined,
      title: r.title ?? undefined,
      link: buildLink(r),
    },
  }));
  return { query: q, provider: provider.id, count: results.length, results };
}
