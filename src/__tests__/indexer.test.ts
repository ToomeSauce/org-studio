/**
 * #1591 — Incremental indexer: best-effort behavior tests.
 *
 * The indexer must NEVER break the write that triggers it. These lock the
 * two guarantees we can test without a live DB: (1) no-op when embeddings are
 * disabled (no DATABASE_URL), and (2) fire-and-forget never throws.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('#1591 indexer best-effort guarantees', () => {
  const ORIG = process.env.DATABASE_URL;
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => {
    if (ORIG === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIG;
    vi.restoreAllMocks();
  });

  it('reindexTask is a no-op (no pipeline call) when DATABASE_URL is unset', async () => {
    delete process.env.DATABASE_URL;
    const indexDocs = vi.fn();
    vi.doMock('@/lib/embedding/pipeline', () => ({ indexDocs }));
    const { reindexTask } = await import('@/lib/embedding/indexer');
    await reindexTask({ id: 't1', title: 'x', description: 'y' });
    expect(indexDocs).not.toHaveBeenCalled();
  });

  it('reindexTask no-ops on a falsy/idless task', async () => {
    process.env.DATABASE_URL = 'postgres://x';
    const indexDocs = vi.fn();
    vi.doMock('@/lib/embedding/pipeline', () => ({ indexDocs }));
    const { reindexTask } = await import('@/lib/embedding/indexer');
    await reindexTask({ id: '' } as any);
    expect(indexDocs).not.toHaveBeenCalled();
  });

  it('reindexTask swallows pipeline errors (never throws)', async () => {
    process.env.DATABASE_URL = 'postgres://x';
    vi.doMock('@/lib/embedding/pipeline', () => ({
      indexDocs: vi.fn().mockRejectedValue(new Error('db down')),
    }));
    const { reindexTask } = await import('@/lib/embedding/indexer');
    await expect(
      reindexTask({ id: 't1', title: 'x', description: 'real text' }),
    ).resolves.toBeUndefined();
  });

  it('indexes a real task when enabled', async () => {
    process.env.DATABASE_URL = 'postgres://x';
    const indexDocs = vi.fn().mockResolvedValue({ considered: 1, embedded: 1, skipped: 0 });
    vi.doMock('@/lib/embedding/pipeline', () => ({ indexDocs }));
    const { reindexTask } = await import('@/lib/embedding/indexer');
    await reindexTask({ id: 't1', title: 'pgvector', description: 'embedding pipeline' });
    expect(indexDocs).toHaveBeenCalledTimes(1);
    const docs = indexDocs.mock.calls[0][0];
    expect(docs.length).toBeGreaterThan(0);
  });

  it('fireReindexTask never throws synchronously', async () => {
    process.env.DATABASE_URL = 'postgres://x';
    vi.doMock('@/lib/embedding/pipeline', () => ({
      indexDocs: vi.fn().mockRejectedValue(new Error('boom')),
    }));
    const { fireReindexTask } = await import('@/lib/embedding/indexer');
    expect(() => fireReindexTask({ id: 't1', description: 'z' })).not.toThrow();
  });
});
