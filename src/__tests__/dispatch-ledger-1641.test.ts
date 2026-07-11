/**
 * #1641 — dispatch-ledger unit tests.
 *
 * Fake-pg-client pattern (reused from launch-already-current-1594): a stub
 * pool that records queries. NOTE (from the 2026-07-06 promote-sweep bug):
 * fake clients can't catch column-shape errors against the real schema —
 * these tests verify write shapes, fire-and-forget semantics, delta logic,
 * and cost math, not DDL correctness. Real-schema verification happens in
 * the deploy smoke check.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  __setPoolForTest,
  __resetForTest,
  recordDispatch,
  completeDispatch,
  recordModelCall,
  recordInternalCallFailure,
  captureSessionUsageDelta,
  estimateCost,
  getObservabilitySummary,
} from '@/lib/dispatch-ledger';

function makeFakePool(rowsByMatch: Array<{ match: RegExp; rows: any[] }> = []) {
  const queries: Array<{ text: string; values?: any[] }> = [];
  const client = {
    query: vi.fn(async (text: string, values?: any[]) => {
      queries.push({ text, values });
      const hit = rowsByMatch.find((r) => r.match.test(text));
      return { rows: hit ? hit.rows : [] };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client) };
  return { pool, client, queries };
}

/** Ledger writes are fire-and-forget (void async IIFE) — flush microtasks. */
const flush = () => new Promise((r) => setTimeout(r, 10));

beforeEach(() => {
  __resetForTest();
});

describe('estimateCost', () => {
  it('prices a known model by served-model substring', () => {
    // 1M in + 1M out on opus pricing = 15 + 75
    expect(estimateCost('claude-opus-4.8', 1_000_000, 1_000_000)).toBe(90);
  });

  it('bills cache-read tokens at the discounted rate, not input rate', () => {
    const noCache = estimateCost('claude-opus-4.8', 1_000_000, 0, 0)!;
    const cached = estimateCost('claude-opus-4.8', 1_000_000, 0, 1_000_000)!;
    expect(cached).toBeLessThan(noCache);
    expect(cached).toBeCloseTo(1.5, 3); // opus cacheReadPer1M
  });

  it('prices the cheap OpenAI-compatible worker model used by tier routing', () => {
    expect(estimateCost('gpt-4.1-mini', 1_000_000, 1_000_000)).toBe(2);
    expect(estimateCost('gpt-4.1-mini', 1_000_000, 0, 1_000_000)).toBe(0.1);
  });

  it('returns null for unknown models (unmetered, not zero)', () => {
    expect(estimateCost('mystery-model-9000', 1000, 1000)).toBeNull();
  });

  it('returns null when tokens are missing', () => {
    expect(estimateCost('claude-opus-4.8', null, 1000)).toBeNull();
    expect(estimateCost('claude-opus-4.8', 1000, undefined)).toBeNull();
  });
});

describe('recordDispatch', () => {
  it('writes a ledger row with all fields', async () => {
    const { pool, queries } = makeFakePool();
    __setPoolForTest(pool);
    recordDispatch({
      dispatchId: 'dispatch-mikey-123',
      agentId: 'mikey',
      source: 'primary',
      outcome: 'enqueued',
      readMs: 433,
      concurrentDispatchCount: 2,
      ticketFingerprint: '1641:in-progress',
    });
    await flush();
    const insert = queries.find((q) => q.text.includes('INSERT INTO org_studio_dispatch_ledger'));
    expect(insert).toBeDefined();
    expect(insert!.values).toEqual([
      'dispatch-mikey-123', 'mikey', 'primary', null, 'enqueued', 433, 2,
      '1641:in-progress', 'default-workspace',
    ]);
  });

  it('never throws when the pool is unavailable (fire-and-forget)', async () => {
    __setPoolForTest(null);
    expect(() =>
      recordDispatch({ agentId: 'mikey', source: 'sweep', outcome: 'no-work' }),
    ).not.toThrow();
    await flush();
  });

  it('never throws when the query rejects', async () => {
    const client = {
      query: vi.fn(async () => { throw new Error('boom'); }),
      release: vi.fn(),
    };
    __setPoolForTest({ connect: async () => client });
    expect(() =>
      recordDispatch({ agentId: 'mikey', source: 'primary', outcome: 'enqueued' }),
    ).not.toThrow();
    await flush();
    expect(client.release).toHaveBeenCalled(); // no connection leak on error
  });
});

describe('completeDispatch', () => {
  it('closes the latest enqueued row for the agent', async () => {
    const { pool, queries } = makeFakePool();
    __setPoolForTest(pool);
    completeDispatch('mikey');
    await flush();
    const update = queries.find((q) => q.text.includes('SET completed_at = NOW()'));
    expect(update).toBeDefined();
    expect(update!.text).toContain(`outcome = 'enqueued' AND completed_at IS NULL`);
    expect(update!.values).toEqual(['mikey']);
  });
});

describe('recordModelCall', () => {
  it('computes cost from served model and stores requested separately', async () => {
    const { pool, queries } = makeFakePool();
    __setPoolForTest(pool);
    recordModelCall({
      dispatchId: 'd1',
      agentId: 'mikey',
      modelRequested: 'github-copilot/claude-opus-4.8-fast',
      modelServed: 'claude-fable-5', // fallback actually served — unknown pricing
      tokensIn: 1000,
      tokensOut: 500,
    });
    await flush();
    const insert = queries.find((q) => q.text.includes('org_studio_dispatch_model_calls'));
    expect(insert).toBeDefined();
    const v = insert!.values!;
    expect(v[2]).toBe('github-copilot/claude-opus-4.8-fast'); // requested preserved
    expect(v[3]).toBe('claude-fable-5'); // served preserved
    expect(v[9]).toBeNull(); // unknown served model → null cost (unmetered)
  });

  it('accepts null tokens without error (non-reporting runtime)', async () => {
    const { pool, queries } = makeFakePool();
    __setPoolForTest(pool);
    recordModelCall({ agentId: 'trevor', modelServed: 'hermes-local' });
    await flush();
    const insert = queries.find((q) => q.text.includes('org_studio_dispatch_model_calls'));
    expect(insert!.values![5]).toBeNull(); // tokens_in
    expect(insert!.values![6]).toBeNull(); // tokens_out
  });
});

describe('recordInternalCallFailure', () => {
  it('upserts with caller/target/status attribution', async () => {
    const { pool, queries } = makeFakePool();
    __setPoolForTest(pool);
    recordInternalCallFailure('roadmap-route:upsert-currentVersion-sync', '/api/store', 401, 'http-status');
    await flush();
    const upsert = queries.find((q) => q.text.includes('org_studio_internal_call_failures'));
    expect(upsert).toBeDefined();
    expect(upsert!.text).toContain('ON CONFLICT');
    expect(upsert!.text).toContain('count = org_studio_internal_call_failures.count + 1');
    expect(upsert!.values).toEqual(['roadmap-route:upsert-currentVersion-sync', '/api/store', 401, 'http-status']);
  });

  it('normalizes null status to -1 so the unique constraint holds', async () => {
    const { pool, queries } = makeFakePool();
    __setPoolForTest(pool);
    recordInternalCallFailure('outbox-drain:redispatch', '/api/scheduler', null, 'fetch-throw');
    await flush();
    const upsert = queries.find((q) => q.text.includes('org_studio_internal_call_failures'));
    expect(upsert!.values![2]).toBe(-1);
  });
});

describe('captureSessionUsageDelta', () => {
  const snapshotMatch = /SELECT tokens_in, tokens_out, cost_usd FROM org_studio_session_usage_snapshots/;

  it('records the delta since the previous snapshot', async () => {
    const { pool, queries } = makeFakePool([
      { match: snapshotMatch, rows: [{ tokens_in: 1000, tokens_out: 400, cost_usd: '0.10' }] },
    ]);
    __setPoolForTest(pool);
    captureSessionUsageDelta({
      sessionKey: 'agent:mikey:main',
      agentId: 'mikey',
      dispatchId: 'd2',
      current: { tokensIn: 3000, tokensOut: 900, costUsd: 0.25, model: 'claude-opus-4.8' },
    });
    await flush();
    const insert = queries.find((q) => q.text.includes('org_studio_dispatch_model_calls'));
    expect(insert).toBeDefined();
    const v = insert!.values!;
    expect(v[5]).toBe(2000); // tokens_in delta
    expect(v[6]).toBe(500);  // tokens_out delta
    expect(v[7]).toBeCloseTo(0.15, 6); // provider-reported cost delta preferred
  });

  it('re-baselines without recording on counter reset (negative delta)', async () => {
    const { pool, queries } = makeFakePool([
      { match: snapshotMatch, rows: [{ tokens_in: 50000, tokens_out: 9000, cost_usd: '1.0' }] },
    ]);
    __setPoolForTest(pool);
    captureSessionUsageDelta({
      sessionKey: 'agent:mikey:main',
      agentId: 'mikey',
      current: { tokensIn: 100, tokensOut: 20, model: 'claude-opus-4.8' }, // gateway restarted
    });
    await flush();
    expect(queries.some((q) => q.text.includes('org_studio_session_usage_snapshots'))).toBe(true); // baseline updated
    expect(queries.some((q) => q.text.includes('org_studio_dispatch_model_calls'))).toBe(false); // no garbage row
  });

  it('baselines only on first sighting (no previous snapshot)', async () => {
    const { pool, queries } = makeFakePool([{ match: snapshotMatch, rows: [] }]);
    __setPoolForTest(pool);
    captureSessionUsageDelta({
      sessionKey: 'agent:ana:main',
      agentId: 'ana',
      current: { tokensIn: 5000, tokensOut: 1000, model: 'gpt-5.4' },
    });
    await flush();
    expect(queries.some((q) => q.text.includes('org_studio_dispatch_model_calls'))).toBe(false);
  });

  it('skips recording when nothing happened (zero delta)', async () => {
    const { pool, queries } = makeFakePool([
      { match: snapshotMatch, rows: [{ tokens_in: 1000, tokens_out: 400, cost_usd: '0.1' }] },
    ]);
    __setPoolForTest(pool);
    captureSessionUsageDelta({
      sessionKey: 'agent:mikey:main',
      agentId: 'mikey',
      current: { tokensIn: 1000, tokensOut: 400, costUsd: 0.1, model: 'claude-opus-4.8' },
    });
    await flush();
    expect(queries.some((q) => q.text.includes('org_studio_dispatch_model_calls'))).toBe(false);
  });
});

describe('getObservabilitySummary', () => {
  it('aggregates dispatches, tokens, and failures', async () => {
    const { pool } = makeFakePool([
      {
        match: /FROM org_studio_dispatch_ledger/,
        rows: [
          { agent_id: 'mikey', source: 'primary', outcome: 'enqueued', duration_ms: 120000, concurrent_dispatch_count: 1 },
          { agent_id: 'mikey', source: 'sweep', outcome: 'no-work', duration_ms: null, concurrent_dispatch_count: 0 },
          { agent_id: 'ana', source: 'primary', outcome: 'enqueued', duration_ms: 60000, concurrent_dispatch_count: 2 },
        ],
      },
      {
        match: /FROM org_studio_dispatch_model_calls/,
        rows: [
          { model_served: 'claude-opus-4.8', tokens_in: 1000, tokens_out: 500, cost_estimate: '0.05' },
          { model_served: null, tokens_in: null, tokens_out: null, cost_estimate: null }, // unmetered
        ],
      },
      {
        match: /FROM org_studio_internal_call_failures/,
        rows: [
          { caller: 'outbox-drain:redispatch', target: '/api/scheduler', status_code: 401, error_kind: 'http-status', count: '7', first_seen: 'a', last_seen: 'b' },
        ],
      },
    ]);
    __setPoolForTest(pool);
    const s = await getObservabilitySummary(60);
    expect(s).not.toBeNull();
    expect(s!.dispatches.total).toBe(3);
    expect(s!.dispatches.byAgent).toEqual({ mikey: 2, ana: 1 });
    expect(s!.dispatches.byOutcome).toEqual({ enqueued: 2, 'no-work': 1 });
    expect(s!.dispatches.perHour).toBe(3);
    expect(s!.dispatches.maxConcurrent).toBe(2);
    expect(s!.tokens.calls).toBe(2);
    expect(s!.tokens.meteredCalls).toBe(1);
    expect(s!.tokens.tokensIn).toBe(1000);
    expect(s!.tokens.byModelServed['(unreported)'].calls).toBe(1);
    expect(s!.internalCallFailures).toHaveLength(1);
    expect(s!.internalCallFailures[0].count).toBe(7);
  });

  it('returns null without a pool (503 at the route)', async () => {
    __setPoolForTest(null);
    expect(await getObservabilitySummary(60)).toBeNull();
  });
});
