/**
 * #1590 — Embedding provider interface + deterministic local default.
 *
 * pgvector stores vectors but does NOT generate them. Org Studio has no
 * embedding API key and "no new infra" is a hard constraint, so we ship a
 * PLUGGABLE provider with a deterministic, dependency-free default. A real
 * provider (OpenAI/Azure text-embedding-*) slots in behind the same
 * interface the moment a key is configured — without touching the pipeline,
 * the indexer, or the search endpoint.
 *
 * The default `HashingEmbeddingProvider` is a hashing vectorizer (a.k.a. the
 * "hashing trick"): deterministic, language-agnostic, no network, no model
 * download. It is NOT as semantically sharp as a learned model, but it gives
 * real lexical-overlap similarity good enough to stand up the whole stack and
 * to regression-test it. Swapping to a learned provider is a one-line config
 * change because everything downstream only depends on this interface.
 *
 * Pure module: no IO. (A network-backed provider implements the same
 * interface in its own file; this file stays dependency-free + unit-testable.)
 */

/** Fixed embedding dimensionality. Stored in pgvector as vector(EMBEDDING_DIM). */
export const EMBEDDING_DIM = 256;

export interface EmbeddingProvider {
  /** Stable id persisted alongside each row so re-index can detect provider drift. */
  readonly id: string;
  /** Vector length this provider emits. Must equal the DB column's dim. */
  readonly dim: number;
  /** Embed a batch of texts → one unit-normalized vector each. */
  embed(texts: string[]): Promise<number[][]>;
}

/** Lowercase, split on non-alphanumerics, drop empties. Pure + deterministic. */
export function tokenize(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * FNV-1a 32-bit hash → stable bucket index in [0, dim). Deterministic across
 * processes/architectures (no Math.random, no Date).
 */
export function hashToken(token: string, dim: number): { bucket: number; sign: number } {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Unsigned.
  const u = h >>> 0;
  const bucket = u % dim;
  // A second bit decides sign so collisions don't only ever add (reduces bias).
  const sign = (u & 0x100) ? 1 : -1;
  return { bucket, sign };
}

/** L2-normalize in place-safe (returns a new array). Zero vector → unchanged. */
export function l2normalize(vec: number[]): number[] {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec.slice();
  return vec.map((v) => v / norm);
}

/** Cosine similarity of two equal-length vectors. Used by search ranking + tests. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error(`dim mismatch: ${a.length} vs ${b.length}`);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Deterministic hashing embedder. Pure: same text → same vector, forever.
 * Uses term-frequency into hashed buckets, then L2-normalizes so cosine
 * behaves. No external dependency.
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dim: number;
  constructor(dim: number = EMBEDDING_DIM) {
    this.dim = dim;
    this.id = `hashing-v1-d${dim}`;
  }
  embedOne(text: string): number[] {
    const vec = new Array(this.dim).fill(0);
    for (const tok of tokenize(text)) {
      const { bucket, sign } = hashToken(tok, this.dim);
      vec[bucket] += sign;
    }
    return l2normalize(vec);
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }
}

/** Format a JS number[] as a pgvector literal: "[0.1,0.2,...]". */
export function toPgVectorLiteral(vec: number[]): string {
  return '[' + vec.join(',') + ']';
}

/** Parse a pgvector literal back to number[]. Tolerates whitespace. */
export function fromPgVectorLiteral(lit: string): number[] {
  const inner = (lit || '').trim().replace(/^\[/, '').replace(/\]$/, '').trim();
  if (inner === '') return [];
  return inner.split(',').map((s) => Number(s.trim()));
}

/**
 * Resolve the active provider from env. Default = deterministic hashing.
 * When EMBEDDING_PROVIDER=openai (and a key exists), a future
 * OpenAiEmbeddingProvider is returned by the network-backed module; here we
 * only ever return the dependency-free default so the pure module stays pure.
 */
export function defaultProvider(): EmbeddingProvider {
  return new HashingEmbeddingProvider(EMBEDDING_DIM);
}
