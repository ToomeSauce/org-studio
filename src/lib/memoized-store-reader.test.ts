/**
 * Tests for #1526 — MemoizedStoreReader.
 *
 * Verifies the freshness contract documented in memoized-store-reader.ts:
 *   - First read = miss + fresh fetch
 *   - Subsequent reads without refresh = hits (no fetch)
 *   - After refresh(), next read = miss + fresh fetch
 *   - invalidate() behaves identically to refresh()
 *   - Each reader instance is independent (no shared state across instances)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the store provider before importing the reader, so the reader's
// import-time binding picks up the mock.
const readMock = vi.fn();
vi.mock('./store-provider', () => ({
  getStoreProviderAllWorkspaces: () => ({ read: readMock }),
}));

import { createMemoizedStoreReader } from './memoized-store-reader';

describe('createMemoizedStoreReader (#1526)', () => {
  beforeEach(() => {
    readMock.mockReset();
    readMock.mockResolvedValue({
      projects: [],
      tasks: [{ id: 't1', status: 'backlog' }],
      settings: {},
    } as any);
  });

  it('first read is a miss and calls the provider once', async () => {
    const reader = createMemoizedStoreReader();
    const r1 = await reader.read('test-first');
    expect(r1.tasks).toHaveLength(1);
    expect(readMock).toHaveBeenCalledTimes(1);
    expect(reader.stats()).toMatchObject({ hits: 0, misses: 1 });
  });

  it('subsequent reads without refresh are cache hits', async () => {
    const reader = createMemoizedStoreReader();
    await reader.read('a');
    await reader.read('b');
    await reader.read('c');
    expect(readMock).toHaveBeenCalledTimes(1);
    expect(reader.stats()).toMatchObject({ hits: 2, misses: 1 });
  });

  it('refresh() forces the next read to be fresh', async () => {
    const reader = createMemoizedStoreReader();
    await reader.read('first');
    reader.refresh();
    await reader.read('after-refresh');
    expect(readMock).toHaveBeenCalledTimes(2);
    expect(reader.stats()).toMatchObject({ hits: 0, misses: 2 });
  });

  it('invalidate() behaves identically to refresh()', async () => {
    const reader = createMemoizedStoreReader();
    await reader.read('first');
    reader.invalidate();
    await reader.read('after-invalidate');
    expect(readMock).toHaveBeenCalledTimes(2);
  });

  it('cache returns the same object identity (no defensive copy)', async () => {
    // We document that the cache shares the returned object across hits.
    // Call sites must NOT mutate the returned StoreData (and don't today —
    // mutations route through provider write methods, not in-memory).
    const reader = createMemoizedStoreReader();
    const r1 = await reader.read();
    const r2 = await reader.read();
    expect(r1).toBe(r2);
  });

  it('different reader instances do not share cache', async () => {
    const a = createMemoizedStoreReader();
    const b = createMemoizedStoreReader();
    await a.read('a-first');
    await b.read('b-first');
    expect(readMock).toHaveBeenCalledTimes(2);
  });

  it('multiple refresh() calls between reads still produce one fetch', async () => {
    // Defense against accidental over-invalidation: refresh() is idempotent
    // until the next read consumes it.
    const reader = createMemoizedStoreReader();
    await reader.read();
    reader.refresh();
    reader.refresh();
    reader.invalidate();
    await reader.read();
    expect(readMock).toHaveBeenCalledTimes(2);
  });

  it('records total read time for observability', async () => {
    let delay = 0;
    readMock.mockImplementation(async () => {
      const d = delay;
      await new Promise((res) => setTimeout(res, d));
      return { projects: [], tasks: [], settings: {} } as any;
    });
    const reader = createMemoizedStoreReader();
    delay = 10;
    await reader.read();
    reader.refresh();
    delay = 20;
    await reader.read();
    const stats = reader.stats();
    expect(stats.misses).toBe(2);
    // Allow generous bounds since CI scheduling is noisy
    expect(stats.totalReadMs).toBeGreaterThanOrEqual(25);
    expect(stats.totalReadMs).toBeLessThan(200);
  });
});
