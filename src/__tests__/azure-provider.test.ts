/**
 * Azure embedding provider — mocked-fetch unit tests (no network).
 */
import { describe, it, expect, vi } from 'vitest';
import { AzureOpenAIEmbeddingProvider, azureProviderFromEnv } from '@/lib/embedding/azure-provider';

function okResponse(vectors: number[][]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: vectors.map((v, i) => ({ index: i, embedding: v })) }),
    headers: new Map(),
    text: async () => '',
  } as any;
}

describe('AzureOpenAIEmbeddingProvider', () => {
  const base = { endpoint: 'https://x.services.ai.azure.com', apiKey: 'k', deployment: 'text-embedding-3-large' };

  it('reports 1024 dim + stable id + dedicated column', () => {
    const p = new AzureOpenAIEmbeddingProvider(base);
    expect(p.dim).toBe(1024);
    expect(p.id).toBe('azure-te3l-d1024');
    expect(p.column).toBe('embedding_lg');
  });

  it('posts dimensions + api-key and L2-normalizes results', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse([[3, 4]])); // norm 5 → [0.6,0.8]
    const p = new AzureOpenAIEmbeddingProvider({ ...base, fetchImpl });
    const [v] = await p.embed(['hello']);
    expect(v[0]).toBeCloseTo(0.6, 5);
    expect(v[1]).toBeCloseTo(0.8, 5);
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toContain('/openai/deployments/text-embedding-3-large/embeddings');
    expect(opts.headers['api-key']).toBe('k');
    expect(JSON.parse(opts.body).dimensions).toBe(1024);
  });

  it('batches inputs over batchSize', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(okResponse([[1, 0]]))
      .mockResolvedValueOnce(okResponse([[0, 1]]));
    const p = new AzureOpenAIEmbeddingProvider({ ...base, batchSize: 1, fetchImpl });
    const out = await p.embed(['a', 'b']);
    expect(out.length).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries on 429 honoring Retry-After, then succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, headers: new Map([['retry-after', '0']]), text: async () => 'rate' } as any)
      .mockResolvedValueOnce(okResponse([[1, 0]]));
    const p = new AzureOpenAIEmbeddingProvider({ ...base, fetchImpl, maxRetries: 3 });
    const out = await p.embed(['x']);
    expect(out.length).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws after maxRetries on persistent 429', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 429, headers: new Map([['retry-after', '0']]), text: async () => 'rate' } as any);
    const p = new AzureOpenAIEmbeddingProvider({ ...base, fetchImpl, maxRetries: 1 });
    await expect(p.embed(['x'])).rejects.toThrow(/429/);
  });

  it('throws on non-retriable 4xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 400, headers: new Map(), text: async () => 'bad input' } as any);
    const p = new AzureOpenAIEmbeddingProvider({ ...base, fetchImpl });
    await expect(p.embed(['x'])).rejects.toThrow(/400/);
  });

  it('substitutes empty strings with a space (API rejects empties)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse([[1, 0]]));
    const p = new AzureOpenAIEmbeddingProvider({ ...base, fetchImpl });
    await p.embed(['']);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).input).toEqual([' ']);
  });

  it('truncates over-long inputs to the char cap', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse([[1, 0]]));
    const p = new AzureOpenAIEmbeddingProvider({ ...base, fetchImpl });
    await p.embed(['x'.repeat(100000)]);
    const sent = JSON.parse(fetchImpl.mock.calls[0][1].body).input[0];
    expect(sent.length).toBe(24000);
  });
});

describe('azureProviderFromEnv', () => {
  it('returns null when env not configured', () => {
    const save = { ...process.env };
    delete process.env.AZURE_EMBEDDING_ENDPOINT;
    delete process.env.AZURE_EMBEDDING_KEY;
    delete process.env.AZURE_EMBEDDING_DEPLOYMENT;
    expect(azureProviderFromEnv()).toBeNull();
    Object.assign(process.env, save);
  });
  it('builds a provider when env present', () => {
    const save = { ...process.env };
    process.env.AZURE_EMBEDDING_ENDPOINT = 'https://x.services.ai.azure.com';
    process.env.AZURE_EMBEDDING_KEY = 'k';
    process.env.AZURE_EMBEDDING_DEPLOYMENT = 'text-embedding-3-large';
    const p = azureProviderFromEnv();
    expect(p?.dim).toBe(1024);
    Object.assign(process.env, save);
  });
});
