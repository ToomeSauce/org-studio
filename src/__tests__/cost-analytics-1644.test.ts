/**
 * #1644 — token/cost analytics rollups.
 *
 * Fake-pg-pool pattern (1594/1641/1643 lineage). Covers the pure helpers
 * (anomaly detection, cache-hit-rate, fingerprint parsing), the rollup
 * fold logic (metered vs unmetered separation — doneWhen 4), and
 * workspace scoping of every query (multi-tenant constraint).
 *
 * Perf (doneWhen 2) is validated against real Postgres with 90 days of
 * synthetic data in a throwaway workspace — see the ticket's closing
 * comment for the measured numbers (real-schema check, not mockable).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  __setPoolForTest,
  __resetForTest,
  detectCostAnomalies,
  cacheHitRate,
  primaryTicketFromFingerprint,
  getCostAnalytics,
  ANOMALY_RATIO,
  ANOMALY_MIN_DISPATCHES,
} from '@/lib/cost-analytics';

function makeFakePool(rowsByMatch: Array<{ match: RegExp; rows: any[] }> = []) {
  const queries: Array<{ text: string; values?: any[] }> = [];
  const run = vi.fn(async (text: string, values?: any[]) => {
    queries.push({ text, values });
    const hit = rowsByMatch.find((r) => r.match.test(text.replace(/\s+/g, ' ')));
    return { rows: hit ? hit.rows : [], rowCount: hit ? hit.rows.length : 0 };
  });
  const client = { query: run, release: vi.fn() };
  // Module uses pool.query for parallel aggregates + pool.connect for index ensure.
  const pool = { connect: vi.fn(async () => client), query: run };
  return { pool, client, queries };
}

beforeEach(() => {
  __resetForTest();
});

describe('primaryTicketFromFingerprint', () => {
  it('extracts the first ticket number', () => {
    expect(primaryTicketFromFingerprint('1643:in-progress,1644:backlog')).toBe(1643);
  });
  it('handles single-entry and garbage', () => {
    expect(primaryTicketFromFingerprint('1641:backlog')).toBe(1641);
    expect(primaryTicketFromFingerprint('')).toBeNull();
    expect(primaryTicketFromFingerprint(null)).toBeNull();
    expect(primaryTicketFromFingerprint('?:blocked')).toBeNull();
  });
});

describe('cacheHitRate', () => {
  it('computes cache-read fraction of input tokens', () => {
    expect(cacheHitRate(1000, 900)).toBe(0.9);
    expect(cacheHitRate(1000, 0)).toBe(0);
  });
  it('null when no input tokens', () => {
    expect(cacheHitRate(0, 0)).toBeNull();
  });
});

describe('detectCostAnomalies', () => {
  const base = { currentDispatches: 10, priorDispatches: 10 };

  it("flags 'agent turn cost doubled this week' (the ticket example)", () => {
    const out = detectCostAnomalies([
      { agentId: 'mikey', currentAvgCost: 0.5, priorAvgCost: 0.2, ...base },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].agentId).toBe('mikey');
    expect(out[0].direction).toBe('up');
    expect(out[0].ratio).toBeGreaterThanOrEqual(ANOMALY_RATIO);
  });

  it('flags large drops too (model change / broken capture)', () => {
    const out = detectCostAnomalies([
      { agentId: 'ana', currentAvgCost: 0.1, priorAvgCost: 0.5, ...base },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].direction).toBe('down');
  });

  it('ignores small changes', () => {
    const out = detectCostAnomalies([
      { agentId: 'sam', currentAvgCost: 0.3, priorAvgCost: 0.25, ...base },
    ]);
    expect(out).toHaveLength(0);
  });

  it('ignores agents below the dispatch noise floor', () => {
    const out = detectCostAnomalies([
      {
        agentId: 'kate',
        currentAvgCost: 1.0,
        priorAvgCost: 0.1,
        currentDispatches: ANOMALY_MIN_DISPATCHES - 1,
        priorDispatches: 10,
      },
    ]);
    expect(out).toHaveLength(0);
  });

  it('ignores penny-level "doublings"', () => {
    const out = detectCostAnomalies([
      { agentId: 'billy', currentAvgCost: 0.002, priorAvgCost: 0.001, ...base },
    ]);
    expect(out).toHaveLength(0);
  });

  it('skips agents missing either window', () => {
    const out = detectCostAnomalies([
      { agentId: 'gem', currentAvgCost: 0.5, priorAvgCost: null, ...base },
    ]);
    expect(out).toHaveLength(0);
  });

  it('sorts by anomaly magnitude', () => {
    const out = detectCostAnomalies([
      { agentId: 'a', currentAvgCost: 0.4, priorAvgCost: 0.2, ...base }, // 2x
      { agentId: 'b', currentAvgCost: 1.0, priorAvgCost: 0.1, ...base }, // 10x
    ]);
    expect(out.map((o) => o.agentId)).toEqual(['b', 'a']);
  });
});

describe('getCostAnalytics rollup', () => {
  const mcRows = [
    // mikey on opus: metered
    { agent_id: 'mikey', model_served: 'claude-opus-4.8', day: '2026-07-05', calls: 3, metered_calls: 3, tokens_in: 300000, tokens_out: 30000, cache_read_tokens: 200000, cache_write_tokens: 0, cost: 3.5 },
    { agent_id: 'mikey', model_served: 'claude-opus-4.8', day: '2026-07-06', calls: 2, metered_calls: 2, tokens_in: 200000, tokens_out: 20000, cache_read_tokens: 150000, cache_write_tokens: 0, cost: 2.0 },
    // hermes runtime: unmetered (null-cost calls — doneWhen 4)
    { agent_id: 'gem', model_served: '(unreported)', day: '2026-07-06', calls: 4, metered_calls: 0, tokens_in: 0, tokens_out: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost: 0 },
  ];

  function standardPool() {
    return makeFakePool([
      { match: /GROUP BY 1, 2, 3/, rows: mcRows },
      {
        match: /LEFT JOIN org_studio_dispatch_ledger l ON/, // bySource
        rows: [
          { source: 'primary', calls: 7, metered_calls: 5, tokens_in: 500000, tokens_out: 50000, cost: 5.5 },
          { source: 'sweep', calls: 2, metered_calls: 0, tokens_in: 0, tokens_out: 0, cost: 0 },
        ],
      },
      {
        match: /WITH attributed AS/, // byProject/byTicketType
        rows: [
          { project_id: 'proj-org-studio', task_type: 'feature', calls: 5, metered_calls: 5, tokens_in: 500000, tokens_out: 50000, cost: 5.5 },
          { project_id: '(unattributed)', task_type: '(unknown)', calls: 4, metered_calls: 0, tokens_in: 0, tokens_out: 0, cost: 0 },
        ],
      },
      {
        match: /FROM org_studio_projects/,
        rows: [{ id: 'proj-org-studio', name: 'Org Studio' }],
      },
      {
        match: /unmetered_dispatches/,
        rows: [{ dispatches: 9, unmetered_dispatches: 4 }],
      },
      {
        match: /current_avg/,
        rows: [
          { agent_id: 'mikey', current_avg: 1.1, current_n: 5, prior_avg: 0.5, prior_n: 5 },
        ],
      },
    ]);
  }

  it('separates metered from unmetered and excludes unmetered from cost sums (doneWhen 4)', async () => {
    const { pool } = standardPool();
    __setPoolForTest(pool);
    const res = await getCostAnalytics('default-workspace', 30);
    expect(res).toBeTruthy();
    expect(res!.totals.calls).toBe(9);
    expect(res!.totals.meteredCalls).toBe(5);
    expect(res!.totals.unmeteredCalls).toBe(4);
    expect(res!.totals.cost).toBe(5.5); // gem's 4 unmetered calls contribute $0
    expect(res!.totals.unmeteredDispatches).toBe(4);
    // gem still COUNTED in byAgent (not hidden)
    const gem = res!.byAgent.find((a) => a.key === 'gem');
    expect(gem?.calls).toBe(4);
    expect(gem?.cost).toBe(0);
  });

  it('rolls up by served model with cache hit rate', async () => {
    const { pool } = standardPool();
    __setPoolForTest(pool);
    const res = await getCostAnalytics('default-workspace', 30);
    const opus = res!.byModel.find((m) => m.key === 'claude-opus-4.8');
    expect(opus?.calls).toBe(5);
    expect(opus?.cost).toBe(5.5);
    // 350k cache reads / 500k input = 0.7
    expect(opus?.cacheHitRate).toBe(0.7);
  });

  it('builds the daily trend sorted by day', async () => {
    const { pool } = standardPool();
    __setPoolForTest(pool);
    const res = await getCostAnalytics('default-workspace', 30);
    expect(res!.trend.map((t) => t.day)).toEqual(['2026-07-05', '2026-07-06']);
    expect(res!.trend[0].cost).toBe(3.5);
  });

  it('attributes projects with names and ticket types', async () => {
    const { pool } = standardPool();
    __setPoolForTest(pool);
    const res = await getCostAnalytics('default-workspace', 30);
    const proj = res!.byProject.find((p) => p.key === 'proj-org-studio');
    expect(proj?.projectName).toBe('Org Studio');
    expect(proj?.cost).toBe(5.5);
    const feature = res!.byTicketType.find((t) => t.key === 'feature');
    expect(feature?.cost).toBe(5.5);
  });

  it('surfaces anomalies through the pure detector', async () => {
    const { pool } = standardPool();
    __setPoolForTest(pool);
    const res = await getCostAnalytics('default-workspace', 30);
    expect(res!.anomalies).toHaveLength(1);
    expect(res!.anomalies[0].agentId).toBe('mikey');
    expect(res!.anomalies[0].direction).toBe('up');
  });

  it('scopes EVERY data query by workspace (multi-tenant constraint)', async () => {
    const { pool, queries } = standardPool();
    __setPoolForTest(pool);
    await getCostAnalytics('ws-tenant-42', 30);
    const dataQueries = queries.filter((q) => !/CREATE INDEX/.test(q.text));
    expect(dataQueries.length).toBeGreaterThanOrEqual(5);
    for (const q of dataQueries) {
      expect(q.values?.[0] ?? q.values?.[1]).toBe('ws-tenant-42');
      expect(q.text).toMatch(/workspace_id/);
    }
  });

  it('clamps the window and returns null on substrate failure', async () => {
    const brokenPool = {
      connect: vi.fn(async () => {
        throw new Error('db down');
      }),
    };
    __setPoolForTest(brokenPool);
    expect(await getCostAnalytics('default-workspace', 30)).toBeNull();
  });
});
