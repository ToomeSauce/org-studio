/**
 * #1643 — dispatch budgets, circuit breaker + summarized alerting.
 *
 * Fake-pg-pool pattern (from 1594/1641). These verify decision logic,
 * queue-not-drop semantics, single-alert-per-breach-window idempotency,
 * and the synthetic load test (doneWhen 5): flooding triggers the breaker,
 * emits exactly ONE alert, and loses zero dispatches (queued + enqueued
 * accounts for every attempt).
 *
 * NOTE (2026-07-06 promote-sweep lesson): fake clients can't catch
 * column-shape errors against the real schema — real-schema verification
 * happens in the deploy smoke check.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  __setPoolForTest,
  __setAlertSenderForTest,
  __resetForTest,
  resolveBudgetConfig,
  evaluateBudget,
  gateDispatch,
  drainQueue,
  openBreachWindow,
  checkAnomalies,
  recordHostSample,
  BUDGET_DEFAULTS,
} from '@/lib/dispatch-breaker';

/**
 * Stateful fake pool: simulates the ledger count, the dispatch queue
 * (with the pending-partial-unique semantics), and breach windows
 * (with the open-partial-unique semantics) well enough to exercise the
 * breaker's control flow.
 */
function makeStatefulFakePool(state: {
  turnsLastHour?: number;
  lastWeek?: number;
  longTurns?: any[];
}) {
  const queue: Array<{ id: number; agent_id: string; source: string; status: string }> = [];
  const windows: Array<{ workspace_id: string; kind: string; closed_at: string | null }> = [];
  let nextId = 1;
  const queries: Array<{ text: string; values?: any[] }> = [];

  const query = vi.fn(async (text: string, values?: any[]) => {
    queries.push({ text, values });
    const t = text.replace(/\s+/g, ' ');

    if (t.includes('CREATE TABLE')) return { rows: [], rowCount: 0 };

    if (t.includes("outcome = 'enqueued'") && t.includes('count(*) FILTER')) {
      // anomaly volume query
      return {
        rows: [{ last_hour: state.turnsLastHour ?? 0, last_week: state.lastWeek ?? 0 }],
        rowCount: 1,
      };
    }
    if (t.includes("outcome = 'enqueued'") && t.includes('count(*)')) {
      return { rows: [{ cnt: state.turnsLastHour ?? 0 }], rowCount: 1 };
    }
    if (t.includes('INSERT INTO org_studio_dispatch_queue')) {
      const [agentId, source, ws] = values as any[];
      const dup = queue.find((q) => q.agent_id === agentId && q.status === 'pending');
      if (dup) return { rows: [], rowCount: 0 }; // partial-unique conflict
      queue.push({ id: nextId++, agent_id: agentId, source, status: 'pending' });
      return { rows: [], rowCount: 1 };
    }
    if (t.includes('SELECT id, agent_id, source FROM org_studio_dispatch_queue')) {
      return {
        rows: queue.filter((q) => q.status === 'pending').slice(0, 20),
        rowCount: 0,
      };
    }
    if (t.includes("SET status = 'drained'")) {
      const [id] = values as any[];
      const row = queue.find((q) => q.id === id && q.status === 'pending');
      if (!row) return { rows: [], rowCount: 0 };
      row.status = 'drained';
      return { rows: [], rowCount: 1 };
    }
    if (t.includes('count(*)') && t.includes('org_studio_dispatch_queue')) {
      return {
        rows: [{ cnt: queue.filter((q) => q.status === 'pending').length, oldest: null }],
        rowCount: 1,
      };
    }
    if (t.includes('INSERT INTO org_studio_breaker_windows')) {
      const [ws, kind] = values as any[];
      const open = windows.find((w) => w.workspace_id === ws && w.kind === kind && !w.closed_at);
      if (open) return { rows: [], rowCount: 0 }; // partial-unique conflict → no alert
      windows.push({ workspace_id: ws, kind, closed_at: null });
      return { rows: [], rowCount: 1 };
    }
    if (t.includes('UPDATE org_studio_breaker_windows')) {
      const [ws, kind] = values as any[];
      const open = windows.filter((w) => w.workspace_id === ws && w.kind === kind && !w.closed_at);
      open.forEach((w) => (w.closed_at = 'now'));
      return { rows: [], rowCount: open.length };
    }
    if (t.includes('duration_ms >')) {
      return { rows: state.longTurns ?? [], rowCount: (state.longTurns ?? []).length };
    }
    if (t.includes('INSERT INTO org_studio_host_samples')) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  const client = { query, release: vi.fn() };
  const pool = { connect: vi.fn(async () => client), query };
  return { pool, queries, queue, windows };
}

const flush = () => new Promise((r) => setTimeout(r, 15));

beforeEach(() => {
  __resetForTest();
});

describe('resolveBudgetConfig', () => {
  it('applies sane defaults when settings are empty (doneWhen 1)', () => {
    const cfg = resolveBudgetConfig({});
    expect(cfg).toEqual(BUDGET_DEFAULTS);
    expect(cfg.enabled).toBe(true);
    expect(cfg.maxTurnsPerHour).toBeGreaterThan(0);
    expect(cfg.maxConcurrentTurns).toBeGreaterThan(0);
  });

  it('honors workspace overrides and clamps garbage', () => {
    const cfg = resolveBudgetConfig({
      dispatchBudget: { maxTurnsPerHour: 5, maxConcurrentTurns: -3, turnDurationCeilingMs: 'lol' },
    });
    expect(cfg.maxTurnsPerHour).toBe(5);
    expect(cfg.maxConcurrentTurns).toBe(BUDGET_DEFAULTS.maxConcurrentTurns); // negative → default
    expect(cfg.turnDurationCeilingMs).toBe(BUDGET_DEFAULTS.turnDurationCeilingMs);
  });

  it('can be explicitly disabled', () => {
    expect(resolveBudgetConfig({ dispatchBudget: { enabled: false } }).enabled).toBe(false);
  });
});

describe('evaluateBudget (pure)', () => {
  const cfg = { ...BUDGET_DEFAULTS, maxTurnsPerHour: 10, maxConcurrentTurns: 3 };

  it('allows under budget', () => {
    expect(evaluateBudget(cfg, { turnsLastHour: 5, concurrent: 1 }).allow).toBe(true);
  });

  it('blocks at the hourly cap', () => {
    const d = evaluateBudget(cfg, { turnsLastHour: 10, concurrent: 0 });
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('hourly-cap');
  });

  it('blocks at the concurrent cap', () => {
    const d = evaluateBudget(cfg, { turnsLastHour: 0, concurrent: 3 });
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('concurrent-cap');
  });

  it('disabled budget always allows', () => {
    expect(
      evaluateBudget({ ...cfg, enabled: false }, { turnsLastHour: 999, concurrent: 999 }).allow,
    ).toBe(true);
  });
});

describe('gateDispatch', () => {
  it('allows and does not queue when under budget', async () => {
    const { pool, queue } = makeStatefulFakePool({ turnsLastHour: 2 });
    __setPoolForTest(pool);
    const res = await gateDispatch({
      cfg: { ...BUDGET_DEFAULTS, maxTurnsPerHour: 10 },
      agentId: 'mikey',
      source: 'primary',
      concurrent: 0,
    });
    expect(res.allow).toBe(true);
    expect(queue).toHaveLength(0);
  });

  it('queues (never drops) when over budget (doneWhen 2)', async () => {
    const { pool, queue } = makeStatefulFakePool({ turnsLastHour: 10 });
    __setPoolForTest(pool);
    const res = await gateDispatch({
      cfg: { ...BUDGET_DEFAULTS, maxTurnsPerHour: 10 },
      agentId: 'mikey',
      source: 'primary',
      concurrent: 0,
    });
    expect(res.allow).toBe(false);
    expect(res.queued).toBe(true);
    expect(queue).toHaveLength(1);
    expect(queue[0].agent_id).toBe('mikey');
  });

  it('dedupes pending intents per agent (partial-unique semantics)', async () => {
    const { pool, queue } = makeStatefulFakePool({ turnsLastHour: 99 });
    __setPoolForTest(pool);
    const cfg = { ...BUDGET_DEFAULTS, maxTurnsPerHour: 10 };
    await gateDispatch({ cfg, agentId: 'mikey', source: 'primary', concurrent: 0 });
    await gateDispatch({ cfg, agentId: 'mikey', source: 'sweep', concurrent: 0 });
    await gateDispatch({ cfg, agentId: 'ana', source: 'primary', concurrent: 0 });
    expect(queue.filter((q) => q.status === 'pending')).toHaveLength(2); // mikey deduped
  });

  it('fails OPEN when the substrate is unavailable', async () => {
    const brokenPool = {
      connect: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    };
    __setPoolForTest(brokenPool);
    const res = await gateDispatch({
      cfg: BUDGET_DEFAULTS,
      agentId: 'mikey',
      source: 'primary',
      concurrent: 0,
    });
    expect(res.allow).toBe(true); // broken observability must never stall the org
  });
});

describe('single alert per breach window (doneWhen 3)', () => {
  it('alerts exactly once while a window is open, re-alerts after close', async () => {
    const { pool, windows } = makeStatefulFakePool({});
    __setPoolForTest(pool);
    const alerts: any[] = [];
    __setAlertSenderForTest(async (p) => {
      alerts.push(p);
    });

    const payload = {
      agentId: 'system',
      metric: 'dispatch-budget-breach',
      value: 'x',
      threshold: 'y',
      status: 'warning' as const,
    };
    openBreachWindow('default-workspace', 'budget', 'first breach', payload);
    openBreachWindow('default-workspace', 'budget', 'second breach', payload);
    openBreachWindow('default-workspace', 'budget', 'third breach', payload);
    await flush();

    expect(alerts).toHaveLength(1); // idempotent within the window
    expect(windows.filter((w) => !w.closed_at)).toHaveLength(1);

    // Close the window (simulating drain-under-budget) → next breach re-alerts.
    windows.forEach((w) => (w.closed_at = 'now'));
    openBreachWindow('default-workspace', 'budget', 'new breach window', payload);
    await flush();
    expect(alerts).toHaveLength(2);
  });

  it('alert failure does not prevent the window from opening', async () => {
    const { pool, windows } = makeStatefulFakePool({});
    __setPoolForTest(pool);
    __setAlertSenderForTest(async () => {
      throw new Error('telegram down');
    });
    openBreachWindow('default-workspace', 'budget', 'breach', {
      agentId: 'system',
      metric: 'm',
      value: 1,
      threshold: 2,
      status: 'warning',
    });
    await flush();
    expect(windows.filter((w) => !w.closed_at)).toHaveLength(1); // window still opened
  });
});

describe('drainQueue', () => {
  it('drains queued intents when under budget and refires them', async () => {
    const { pool, queue } = makeStatefulFakePool({ turnsLastHour: 0 });
    __setPoolForTest(pool);
    queue.push({ id: 101, agent_id: 'mikey', source: 'primary', status: 'pending' });
    queue.push({ id: 102, agent_id: 'ana', source: 'sweep', status: 'pending' });

    const refired: string[] = [];
    const res = await drainQueue({
      cfg: { ...BUDGET_DEFAULTS, maxTurnsPerHour: 10, maxConcurrentTurns: 5 },
      concurrent: 0,
      refire: async (agentId) => {
        refired.push(agentId);
      },
    });
    expect(res.drained).toEqual(['mikey', 'ana']);
    expect(refired).toEqual(['mikey', 'ana']);
    expect(res.remaining).toBe(0);
    expect(queue.every((q) => q.status === 'drained')).toBe(true);
  });

  it('stops draining when headroom runs out — leaves the rest queued', async () => {
    const { pool, queue } = makeStatefulFakePool({ turnsLastHour: 9 });
    __setPoolForTest(pool);
    queue.push({ id: 201, agent_id: 'mikey', source: 'primary', status: 'pending' });
    queue.push({ id: 202, agent_id: 'ana', source: 'primary', status: 'pending' });

    const refired: string[] = [];
    const res = await drainQueue({
      cfg: { ...BUDGET_DEFAULTS, maxTurnsPerHour: 10, maxConcurrentTurns: 5 },
      concurrent: 0,
      refire: async (a) => {
        refired.push(a);
      },
    });
    // Only 1 slot of hourly headroom (9/10 used) → drain exactly one.
    expect(refired).toEqual(['mikey']);
    expect(res.remaining).toBe(1);
    expect(queue.find((q) => q.agent_id === 'ana')?.status).toBe('pending');
  });

  it('refire failure does not lose the drain accounting', async () => {
    const { pool, queue } = makeStatefulFakePool({ turnsLastHour: 0 });
    __setPoolForTest(pool);
    queue.push({ id: 301, agent_id: 'mikey', source: 'primary', status: 'pending' });
    const res = await drainQueue({
      cfg: BUDGET_DEFAULTS,
      concurrent: 0,
      refire: async () => {
        throw new Error('gateway offline');
      },
    });
    // The intent was handed to refire; fireOneShot's own retry/queue paths
    // own it from there. Drain doesn't crash and reports the attempt.
    expect(res.drained).toEqual(['mikey']);
  });
});

describe('synthetic load test — flood triggers breaker + single alert, no dispatch loss (doneWhen 5)', () => {
  it('floods 25 dispatch attempts against a 10/hour budget', async () => {
    const FLOOD = 25;
    const HOURLY_CAP = 10;
    let enqueuedCount = 0; // simulated ledger state — grows as dispatches "fire"

    const { pool, queue, windows } = makeStatefulFakePool({ turnsLastHour: 0 });
    // Make the ledger count LIVE: reflect enqueuedCount on every read.
    const origConnect = pool.connect;
    (pool as any).connect = vi.fn(async () => {
      const client = await origConnect();
      const origQuery = client.query;
      (client as any).query = vi.fn(async (text: string, values?: any[]) => {
        const t = text.replace(/\s+/g, ' ');
        if (t.includes("outcome = 'enqueued'") && t.includes('count(*)') && !t.includes('FILTER')) {
          return { rows: [{ cnt: enqueuedCount }], rowCount: 1 };
        }
        return origQuery(text, values);
      });
      return client;
    });
    __setPoolForTest(pool);

    const alerts: any[] = [];
    __setAlertSenderForTest(async (p) => {
      alerts.push(p);
    });

    const cfg = { ...BUDGET_DEFAULTS, maxTurnsPerHour: HOURLY_CAP, maxConcurrentTurns: 100 };

    // Flood: 25 distinct agents all trigger at once.
    let fired = 0;
    for (let i = 0; i < FLOOD; i++) {
      const res = await gateDispatch({
        cfg,
        agentId: `agent-${i}`,
        source: 'primary',
        concurrent: 0,
      });
      if (res.allow) {
        fired++;
        enqueuedCount++; // the dispatch "fires" → ledger row
      } else {
        expect(res.queued).toBe(true); // never dropped
      }
    }
    await flush();

    // Breaker engaged at the cap: exactly HOURLY_CAP fired, the rest queued.
    expect(fired).toBe(HOURLY_CAP);
    const queuedPending = queue.filter((q) => q.status === 'pending').length;
    expect(queuedPending).toBe(FLOOD - HOURLY_CAP);
    // NO DISPATCH LOSS: every attempt is either fired or queued.
    expect(fired + queuedPending).toBe(FLOOD);

    // EXACTLY ONE alert for the whole flood.
    expect(alerts).toHaveLength(1);
    expect(alerts[0].metric).toBe('dispatch-budget-breach');
    expect(windows.filter((w) => !w.closed_at && w.kind === 'budget')).toHaveLength(1);

    // Budget hour rolls over → drain refires queued intents, still no loss.
    enqueuedCount = 0; // trailing-hour window empties
    const refired: string[] = [];
    const drainRes = await drainQueue({
      cfg,
      concurrent: 0,
      refire: async (agentId) => {
        refired.push(agentId);
        enqueuedCount++;
      },
    });
    expect(drainRes.drained.length).toBe(HOURLY_CAP); // next hour's allowance
    expect(drainRes.remaining).toBe(FLOOD - 2 * HOURLY_CAP);
    // Still exactly one alert — draining is not a breach.
    expect(alerts).toHaveLength(1);
  });
});

describe('checkAnomalies', () => {
  it('opens a volume-anomaly window when trailing hour >3x baseline (above floor)', async () => {
    // baseline: 168 turns over 7 days = 1/h; last hour = 12 (>10 floor, >3x)
    const { pool, windows } = makeStatefulFakePool({ turnsLastHour: 12, lastWeek: 168 });
    __setPoolForTest(pool);
    const alerts: any[] = [];
    __setAlertSenderForTest(async (p) => {
      alerts.push(p);
    });
    await checkAnomalies({ cfg: BUDGET_DEFAULTS, force: true });
    await flush();
    expect(windows.filter((w) => w.kind === 'volume-anomaly' && !w.closed_at)).toHaveLength(1);
    expect(alerts).toHaveLength(1);
  });

  it('does not flag low absolute volume even when it beats the baseline ratio', async () => {
    // 3 turns/h vs 0.1/h baseline = 30x — but below the 10/h floor.
    const { pool, windows } = makeStatefulFakePool({ turnsLastHour: 3, lastWeek: 17 });
    __setPoolForTest(pool);
    const alerts: any[] = [];
    __setAlertSenderForTest(async (p) => {
      alerts.push(p);
    });
    await checkAnomalies({ cfg: BUDGET_DEFAULTS, force: true });
    await flush();
    expect(windows.filter((w) => w.kind === 'volume-anomaly' && !w.closed_at)).toHaveLength(0);
    expect(alerts).toHaveLength(0);
  });

  it('opens a turn-duration window when a turn exceeded the ceiling', async () => {
    const { pool, windows } = makeStatefulFakePool({
      longTurns: [{ agent_id: 'billy', duration_ms: 30 * 60 * 1000 }],
    });
    __setPoolForTest(pool);
    const alerts: any[] = [];
    __setAlertSenderForTest(async (p) => {
      alerts.push(p);
    });
    await checkAnomalies({ cfg: BUDGET_DEFAULTS, force: true });
    await flush();
    expect(windows.filter((w) => w.kind === 'turn-duration' && !w.closed_at)).toHaveLength(1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].agentId).toBe('billy');
  });
});

describe('recordHostSample (doneWhen 4)', () => {
  it('stores a sample row', async () => {
    const { pool, queries } = makeStatefulFakePool({});
    __setPoolForTest(pool);
    const ok = await recordHostSample({
      host: 'hanktank',
      source: 'local',
      load1: 2.5,
      eventLoopDelayMs: 12.3,
      memUsedMb: 4096,
      memTotalMb: 8192,
    });
    expect(ok).toBe(true);
    const insert = queries.find((q) => q.text.includes('INSERT INTO org_studio_host_samples'));
    expect(insert).toBeTruthy();
    expect(insert!.values![0]).toBe('hanktank');
  });
});
