/**
 * Azure OpenAI embedding provider (learned model) — slots in behind the
 * #1590 `EmbeddingProvider` interface. This is the "swap to a real model the
 * moment a key is configured" path the #1590 design promised.
 *
 * Model: text-embedding-3-large, reduced to 1024 dims via the Matryoshka
 * `dimensions` param. Why 1024:
 *   - keeps ~99% of full-3072 quality at 1/3 the storage/compute,
 *   - well under pgvector's ivfflat 2000-dim cap (and fine for hnsw),
 *   - distinct from the hashing default's 256, so the `provider_id` +
 *     `column` split keeps the two embedding spaces cleanly separated.
 *
 * Network lives here only; the pure provider.ts stays dependency-free.
 *
 * Rate limits: respects the deployment TPM budget. Batches inputs, and on a
 * 429 backs off using Retry-After (no tight loops, per API-write etiquette).
 */
import type { EmbeddingProvider } from './provider';
import { l2normalize } from './provider';

export const AZURE_EMBEDDING_DIM = 1024;
export const AZURE_PROVIDER_ID = 'azure-te3l-d1024';
/** Dedicated pgvector column so 1024-dim rows never collide with 256-dim. */
export const AZURE_EMBEDDING_COLUMN = 'embedding_lg';
/**
 * text-embedding-3 hard-caps input at 8192 tokens. We embed snippets, not
 * whole essays, but a few vision docs / long tasks blow past it. Truncate to
 * a conservative char budget (~1 token ≈ 4 chars → 8192*~3.4 ≈ 28k; we use
 * 24k for headroom) so a single giant doc never fails the batch.
 */
export const MAX_INPUT_CHARS = 24000;

export interface AzureEmbeddingConfig {
  endpoint: string;     // https://<resource>.services.ai.azure.com  (no trailing slash needed)
  apiKey: string;
  deployment: string;   // e.g. text-embedding-3-large
  apiVersion?: string;  // default 2024-10-21
  dim?: number;         // default 1024
  /** Max inputs per request. text-embedding-3 allows up to 2048; keep modest. */
  batchSize?: number;
  /** Hard cap on retry waits so a bad 429 storm can't hang the sweep. */
  maxRetries?: number;
  fetchImpl?: typeof fetch; // injectable for tests
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AzureOpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dim: number;
  readonly column: string = AZURE_EMBEDDING_COLUMN;
  private cfg: Required<Omit<AzureEmbeddingConfig, 'fetchImpl'>> & { fetchImpl: typeof fetch };

  constructor(cfg: AzureEmbeddingConfig) {
    const dim = cfg.dim ?? AZURE_EMBEDDING_DIM;
    this.dim = dim;
    this.id = cfg.dim && cfg.dim !== AZURE_EMBEDDING_DIM ? `azure-te3l-d${dim}` : AZURE_PROVIDER_ID;
    this.cfg = {
      endpoint: cfg.endpoint.replace(/\/+$/, ''),
      apiKey: cfg.apiKey,
      deployment: cfg.deployment,
      apiVersion: cfg.apiVersion ?? '2024-10-21',
      dim,
      batchSize: cfg.batchSize ?? 256,
      maxRetries: cfg.maxRetries ?? 5,
      fetchImpl: cfg.fetchImpl ?? fetch,
    };
  }

  private get url(): string {
    return `${this.cfg.endpoint}/openai/deployments/${this.cfg.deployment}/embeddings?api-version=${this.cfg.apiVersion}`;
  }

  /** One API call for up to batchSize inputs, with 429/5xx backoff. */
  private async embedBatch(inputs: string[]): Promise<number[][]> {
    let attempt = 0;
    // text-embedding-3 rejects empty strings (→ space) and caps input length
    // (→ truncate). Both guard the batch from a single bad input.
    const safe = inputs.map((t) => {
      const s = t && t.trim() ? t : ' ';
      return s.length > MAX_INPUT_CHARS ? s.slice(0, MAX_INPUT_CHARS) : s;
    });
    for (;;) {
      const res = await this.cfg.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': this.cfg.apiKey },
        body: JSON.stringify({ input: safe, dimensions: this.cfg.dim }),
      });
      if (res.ok) {
        const json: any = await res.json();
        // API preserves input order; sort by index to be safe.
        const rows: any[] = (json.data || []).slice().sort((a: any, b: any) => a.index - b.index);
        return rows.map((r) => l2normalize(r.embedding as number[]));
      }
      const retriable = res.status === 429 || res.status >= 500;
      if (!retriable || attempt >= this.cfg.maxRetries) {
        const body = await res.text().catch(() => '');
        throw new Error(`Azure embeddings ${res.status}: ${body.slice(0, 200)}`);
      }
      // Respect Retry-After (seconds) when present; else exponential backoff.
      const ra = parseFloat(res.headers.get('retry-after') || '');
      const waitMs = Number.isFinite(ra) ? ra * 1000 : Math.min(2 ** attempt * 500, 15000);
      await sleep(waitMs);
      attempt++;
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.cfg.batchSize) {
      const chunk = texts.slice(i, i + this.cfg.batchSize);
      const vecs = await this.embedBatch(chunk);
      out.push(...vecs);
    }
    return out;
  }
}

/**
 * Build the Azure provider from env, or return null if not configured.
 *   AZURE_EMBEDDING_ENDPOINT, AZURE_EMBEDDING_KEY, AZURE_EMBEDDING_DEPLOYMENT
 *   (optional) AZURE_EMBEDDING_API_VERSION, AZURE_EMBEDDING_DIM
 */
export function azureProviderFromEnv(): AzureOpenAIEmbeddingProvider | null {
  const endpoint = process.env.AZURE_EMBEDDING_ENDPOINT;
  const apiKey = process.env.AZURE_EMBEDDING_KEY;
  const deployment = process.env.AZURE_EMBEDDING_DEPLOYMENT;
  if (!endpoint || !apiKey || !deployment) return null;
  return new AzureOpenAIEmbeddingProvider({
    endpoint,
    apiKey,
    deployment,
    apiVersion: process.env.AZURE_EMBEDDING_API_VERSION,
    dim: process.env.AZURE_EMBEDDING_DIM ? parseInt(process.env.AZURE_EMBEDDING_DIM, 10) : undefined,
  });
}
