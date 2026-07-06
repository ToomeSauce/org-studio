/**
 * cost-analytics.ts — #1644 (T4: token/cost analytics rollups).
 *
 * Read-only analysis layer over the #1641 ledger tables
 * (org_studio_dispatch_ledger + org_studio_dispatch_model_calls).
 * NO new capture paths (ticket constraint) — every number here is derived
 * from what T1 already records.
 *
 * Attribution rules (locked in the ticket):
 *   - Cost attributes to model_served, NEVER model_requested (fallback
 *     chains make requested-model attribution fiction). model_requested
 *     is not even read here.
 *   - Project / ticket-class attribution is BY DISPATCH CONTEXT: the
 *     ledger's ticket_fingerprint ("1643:in-progress,1644:backlog,...")
 *     names the agent's actionable tickets at dispatch time; the FIRST
 *     entry is the ticket the dispatch message targeted, so it gets the
 *     bill. A turn may touch several tickets — same simplification T1
 *     made for session-usage deltas. Documented, acceptable.
 *   - Unmetered (doneWhen 4): model-call rows with NULL cost_estimate are
 *     counted in call totals but excluded from every cost sum, and
 *     surfaced as `unmeteredCalls`. Dispatches with zero model-call rows
 *     at all (non-reporting runtimes, e.g. Hermes) are surfaced as
 *     `unmeteredDispatches`.
 *
 * Multi-tenant: every query filters workspace_id (mandatory — cloud
 * launch feature). Perf (doneWhen 2): composite (workspace_id, time DESC)
 * indexes are ensured additively below; target <500ms over 90 days.
 */

let _pool: any = undefined;
let _indexesEnsured = false;
const _loggedErrors = new Set<string>();

function logOnce(key: string, msg: string, err?: any): void {
  if (_loggedErrors.has(key)) return;
  _loggedErrors.add(key);
  console.error(`[CostAnalytics] ${msg}`, err?.message || err || '');
}

async function getPool(): Promise<any> {
  if (_pool !== undefined) return _pool;
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    _pool = null;
    return null;
  }
  try {
    const pg = await import('pg');
    const Pool = (pg as any).default?.Pool || (pg as any).Pool;
    _pool = new Pool({ connectionString: dbUrl, max: 3 });
    return _pool;
  } catch (e: any) {
    logOnce('pool', 'Failed to create pool:', e);
    _pool = null;
    return null;
  }
}

/** Test hook (pattern from #1641/#1643). */
export function __setPoolForTest(pool: any): void {
  _pool = pool;
  _indexesEnsured = true;
}

export function __resetForTest(): void {
  _pool = undefined;
  _indexesEnsured = false;
  _loggedErrors.clear();
}

/**
 * Additive perf indexes (doneWhen 2). The #1641 tables index on bare time /
 * (agent_id, time); the analytics queries all filter workspace_id FIRST, so
 * give them composite (workspace_id, time DESC) paths. CREATE INDEX IF NOT
 * EXISTS — reversible with two DROP INDEX statements.
 */
const ENSURE_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_model_calls_ws_time
    ON org_studio_dispatch_model_calls (workspace_id, called_at DESC);
  CREATE INDEX IF NOT EXISTS idx_dispatch_ledger_ws_time
    ON org_studio_dispatch_ledger (workspace_id, dispatched_at DESC);
`;

async function ensureIndexes(client: any): Promise<void> {
  if (_indexesEnsured) return;
  await client.query(ENSURE_INDEXES);
  _indexesEnsured = true;
}

// ── Pure helpers (unit-testable without a DB) ─────────────────────────────

export interface AgentWindowCost {
  agentId: string;
  currentAvgCost: number | null; // avg metered cost/dispatch, current window
  currentDispatches: number;
  priorAvgCost: number | null; // same, prior window
  priorDispatches: number;
}

export interface CostAnomaly {
  agentId: string;
  currentAvgCost: number;
  priorAvgCost: number;
  ratio: number; // current / prior
  direction: 'up' | 'down';
}

/** Anomaly flag threshold: avg cost per dispatch changed by ≥2x week-over-week. */
export const ANOMALY_RATIO = 2;
/** Ignore agents with fewer dispatches than this in either window (noise floor). */
export const ANOMALY_MIN_DISPATCHES = 3;
/** Ignore avg costs below this (a $0.001→$0.002 "doubling" is noise). */
export const ANOMALY_MIN_AVG_COST = 0.01;

/**
 * Pure anomaly detection over per-agent window aggregates: flags agents
 * whose avg cost per dispatch changed ≥ANOMALY_RATIO× between the prior
 * and current windows ("agent X turn cost doubled this week"). Both
 * directions flagged — a 2x drop usually means a model change or a broken
 * capture path, worth eyes either way.
 */
export function detectCostAnomalies(rows: AgentWindowCost[]): CostAnomaly[] {
  const out: CostAnomaly[] = [];
  for (const r of rows) {
    if (r.currentAvgCost == null || r.priorAvgCost == null) continue;
    if (r.currentDispatches < ANOMALY_MIN_DISPATCHES || r.priorDispatches < ANOMALY_MIN_DISPATCHES) continue;
    if (Math.max(r.currentAvgCost, r.priorAvgCost) < ANOMALY_MIN_AVG_COST) continue;
    if (r.priorAvgCost === 0 || r.currentAvgCost === 0) continue;
    const ratio = r.currentAvgCost / r.priorAvgCost;
    if (ratio >= ANOMALY_RATIO || ratio <= 1 / ANOMALY_RATIO) {
      out.push({
        agentId: r.agentId,
        currentAvgCost: Math.round(r.currentAvgCost * 1e6) / 1e6,
        priorAvgCost: Math.round(r.priorAvgCost * 1e6) / 1e6,
        ratio: Math.round(ratio * 100) / 100,
        direction: ratio > 1 ? 'up' : 'down',
      });
    }
  }
  return out.sort((a, b) => Math.abs(Math.log(b.ratio)) - Math.abs(Math.log(a.ratio)));
}

/**
 * Cache hit rate for a bucket: cache-read tokens as a fraction of total
 * input tokens. Cache tokens change effective cost ~10x, so this is the
 * "are we getting prompt-cache value" number.
 */
export function cacheHitRate(tokensIn: number, cacheReadTokens: number): number | null {
  if (!tokensIn || tokensIn <= 0) return null;
  return Math.round((cacheReadTokens / tokensIn) * 1000) / 1000;
}

/** First ticket number from a ledger ticket_fingerprint ("1643:in-progress,..."). */
export function primaryTicketFromFingerprint(fp: string | null | undefined): number | null {
  if (!fp) return null;
  const first = fp.split(',')[0];
  const n = parseInt(first, 10);
  return Number.isFinite(n) ? n : null;
}

// ── Response shape ────────────────────────────────────────────────────────

interface BucketTotals {
  calls: number;
  meteredCalls: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
}

export interface CostAnalyticsSummary {
  workspaceId: string;
  windowDays: number;
  totals: BucketTotals & {
    unmeteredCalls: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cacheHitRate: number | null;
    dispatches: number;
    unmeteredDispatches: number; // dispatches with no model-call rows at all
  };
  byAgent: Array<{ key: string } & BucketTotals>;
  byModel: Array<
    { key: string; cacheReadTokens: number; cacheHitRate: number | null } & BucketTotals
  >;
  bySource: Array<{ key: string } & BucketTotals>;
  byProject: Array<{ key: string; projectName: string | null } & BucketTotals>;
  byTicketType: Array<{ key: string } & BucketTotals>;
  trend: Array<{ day: string; calls: number; tokensIn: number; tokensOut: number; cost: number }>;
  anomalies: CostAnomaly[];
  queryMs: number;
}

// ── Main entry ────────────────────────────────────────────────────────────

const bucketBase = () => ({ calls: 0, meteredCalls: 0, tokensIn: 0, tokensOut: 0, cost: 0 });

function accumulate(bucket: any, row: any): void {
  bucket.calls += Number(row.calls || 0);
  bucket.meteredCalls += Number(row.metered_calls || 0);
  bucket.tokensIn += Number(row.tokens_in || 0);
  bucket.tokensOut += Number(row.tokens_out || 0);
  bucket.cost += Number(row.cost || 0);
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/**
 * Compute the full cost-analytics rollup for one workspace + window.
 * Read-only; a handful of aggregate queries, all workspace-scoped and
 * index-aligned. Returns null when no DB (file mode).
 */
export async function getCostAnalytics(
  workspaceId: string,
  windowDays: number,
): Promise<CostAnalyticsSummary | null> {
  const started = Date.now();
  try {
    const pool = await getPool();
    if (!pool) return null;
    // Index-ensure gets one dedicated client; the aggregates below run in
    // PARALLEL via pool.query (a single client serializes queries — with 6
    // sequential Azure round trips the wall time burned most of the 500ms
    // budget on network latency alone).
    {
      const client = await pool.connect();
      try {
        await ensureIndexes(client);
      } finally {
        client.release();
      }
    }
    {
      const days = Math.max(1, Math.min(365, windowDays));
      // NOTE: `days` is clamped-numeric (never user text) — safe to inline.
      const since = `NOW() - INTERVAL '${days} days'`;

      // 1. Model-call rollup by (agent, model, day) — one scan feeds
      //    byAgent, byModel, trend, and the metered/unmetered totals.
      //    "metered" = cost_estimate IS NOT NULL (doneWhen 4).
      const mcQ = pool.query(
        `SELECT
           COALESCE(agent_id, '(unknown)') AS agent_id,
           COALESCE(model_served, '(unreported)') AS model_served,
           date_trunc('day', called_at)::date::text AS day,
           count(*)::int AS calls,
           count(cost_estimate)::int AS metered_calls,
           COALESCE(sum(tokens_in), 0)::bigint AS tokens_in,
           COALESCE(sum(tokens_out), 0)::bigint AS tokens_out,
           COALESCE(sum(cache_read_tokens), 0)::bigint AS cache_read_tokens,
           COALESCE(sum(cache_write_tokens), 0)::bigint AS cache_write_tokens,
           COALESCE(sum(cost_estimate), 0)::numeric AS cost
         FROM org_studio_dispatch_model_calls
         WHERE workspace_id = $1 AND called_at >= ${since}
         GROUP BY 1, 2, 3`,
        [workspaceId],
      );

      // 2. Per-source rollup — model calls joined to their dispatch's
      //    ledger row for the trigger source (primary/sweep/resume/...).
      const srcQ = pool.query(
        `SELECT
           COALESCE(l.source, '(no-dispatch)') AS source,
           count(*)::int AS calls,
           count(mc.cost_estimate)::int AS metered_calls,
           COALESCE(sum(mc.tokens_in), 0)::bigint AS tokens_in,
           COALESCE(sum(mc.tokens_out), 0)::bigint AS tokens_out,
           COALESCE(sum(mc.cost_estimate), 0)::numeric AS cost
         FROM org_studio_dispatch_model_calls mc
         LEFT JOIN org_studio_dispatch_ledger l ON l.dispatch_id = mc.dispatch_id
         WHERE mc.workspace_id = $1 AND mc.called_at >= ${since}
         GROUP BY 1`,
        [workspaceId],
      );

      // 3. Project + ticket-class attribution: model call → ledger row →
      //    primary ticket number from the fingerprint → task → project/type.
      //    split_part before the first ':' of the first fingerprint entry.
      const projQ = pool.query(
        `WITH attributed AS (
           SELECT
             mc.tokens_in, mc.tokens_out, mc.cost_estimate,
             NULLIF(split_part(split_part(l.ticket_fingerprint, ',', 1), ':', 1), '')::bigint AS ticket_number
           FROM org_studio_dispatch_model_calls mc
           JOIN org_studio_dispatch_ledger l ON l.dispatch_id = mc.dispatch_id
           WHERE mc.workspace_id = $1 AND mc.called_at >= ${since}
             AND l.ticket_fingerprint ~ '^[0-9]+:'
         )
         SELECT
           COALESCE(t.project_id, '(unattributed)') AS project_id,
           COALESCE(t.data->>'taskType', '(unknown)') AS task_type,
           count(*)::int AS calls,
           count(a.cost_estimate)::int AS metered_calls,
           COALESCE(sum(a.tokens_in), 0)::bigint AS tokens_in,
           COALESCE(sum(a.tokens_out), 0)::bigint AS tokens_out,
           COALESCE(sum(a.cost_estimate), 0)::numeric AS cost
         FROM attributed a
         LEFT JOIN org_studio_tasks t
           ON t.ticket_number = a.ticket_number AND t.workspace_id = $1
         GROUP BY 1, 2`,
        [workspaceId],
      );

      // Fire all five aggregates concurrently — pool multiplexes connections
      // so total latency ≈ the slowest single query, not the sum.
      // (dQ and aQ are declared below; Promise.all moved after them.)

      // 5. Dispatch counts + unmetered dispatches (no model-call rows at all).
      const dQ = pool.query(
        `SELECT
           count(*)::int AS dispatches,
           count(*) FILTER (
             WHERE l.outcome = 'enqueued' AND NOT EXISTS (
               SELECT 1 FROM org_studio_dispatch_model_calls mc
               WHERE mc.dispatch_id = l.dispatch_id
             )
           )::int AS unmetered_dispatches
         FROM org_studio_dispatch_ledger l
         WHERE l.workspace_id = $1 AND l.dispatched_at >= ${since}`,
        [workspaceId],
      );

      // 6. Anomaly windows: avg metered cost per dispatch, this 7d vs prior 7d.
      const aQ = pool.query(
        `SELECT
           agent_id,
           avg(cost_estimate) FILTER (WHERE called_at >= NOW() - INTERVAL '7 days') AS current_avg,
           count(DISTINCT dispatch_id) FILTER (WHERE called_at >= NOW() - INTERVAL '7 days')::int AS current_n,
           avg(cost_estimate) FILTER (WHERE called_at < NOW() - INTERVAL '7 days' AND called_at >= NOW() - INTERVAL '14 days') AS prior_avg,
           count(DISTINCT dispatch_id) FILTER (WHERE called_at < NOW() - INTERVAL '7 days' AND called_at >= NOW() - INTERVAL '14 days')::int AS prior_n
         FROM org_studio_dispatch_model_calls
         WHERE workspace_id = $1 AND called_at >= NOW() - INTERVAL '14 days'
           AND cost_estimate IS NOT NULL AND agent_id IS NOT NULL
         GROUP BY agent_id`,
        [workspaceId],
      );

      const [mcRes, srcRes, projRes, dRes, aRes] = await Promise.all([mcQ, srcQ, projQ, dQ, aQ]);

      // 4b. Project names for display (depends on projRes — runs after).
      const projectIds = [
        ...new Set(projRes.rows.map((r: any) => r.project_id).filter((p: string) => p && !p.startsWith('('))),
      ];
      let projectNames = new Map<string, string>();
      if (projectIds.length > 0) {
        const pnRes = await pool.query(
          `SELECT id, name FROM org_studio_projects WHERE workspace_id = $1 AND id = ANY($2)`,
          [workspaceId, projectIds],
        );
        projectNames = new Map(pnRes.rows.map((r: any) => [r.id, r.name]));
      }

      // ── Fold the (agent, model, day) scan into the response buckets ──
      const byAgent = new Map<string, any>();
      const byModel = new Map<string, any>();
      const trend = new Map<string, any>();
      const totals = {
        ...bucketBase(),
        unmeteredCalls: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheHitRate: null as number | null,
        dispatches: dRes.rows[0]?.dispatches ?? 0,
        unmeteredDispatches: dRes.rows[0]?.unmetered_dispatches ?? 0,
      };

      for (const row of mcRes.rows) {
        accumulate(totals, row);
        totals.cacheReadTokens += Number(row.cache_read_tokens || 0);
        totals.cacheWriteTokens += Number(row.cache_write_tokens || 0);

        const a = byAgent.get(row.agent_id) || { key: row.agent_id, ...bucketBase() };
        accumulate(a, row);
        byAgent.set(row.agent_id, a);

        const m =
          byModel.get(row.model_served) ||
          { key: row.model_served, ...bucketBase(), cacheReadTokens: 0, cacheHitRate: null };
        accumulate(m, row);
        m.cacheReadTokens += Number(row.cache_read_tokens || 0);
        byModel.set(row.model_served, m);

        const t = trend.get(row.day) || { day: row.day, calls: 0, tokensIn: 0, tokensOut: 0, cost: 0 };
        t.calls += Number(row.calls);
        t.tokensIn += Number(row.tokens_in);
        t.tokensOut += Number(row.tokens_out);
        t.cost += Number(row.cost);
        trend.set(row.day, t);
      }
      totals.unmeteredCalls = totals.calls - totals.meteredCalls;
      totals.cacheHitRate = cacheHitRate(totals.tokensIn, totals.cacheReadTokens);
      totals.cost = round4(totals.cost);
      for (const m of byModel.values()) {
        m.cacheHitRate = cacheHitRate(m.tokensIn, m.cacheReadTokens);
        m.cost = round4(m.cost);
      }
      for (const a of byAgent.values()) a.cost = round4(a.cost);
      for (const t of trend.values()) t.cost = round4(t.cost);

      const bySource = srcRes.rows.map((r: any) => {
        const b = { key: r.source, ...bucketBase() };
        accumulate(b, r);
        b.cost = round4(b.cost);
        return b;
      });

      const byProject = new Map<string, any>();
      const byTicketType = new Map<string, any>();
      for (const r of projRes.rows) {
        const p =
          byProject.get(r.project_id) ||
          { key: r.project_id, projectName: projectNames.get(r.project_id) ?? null, ...bucketBase() };
        accumulate(p, r);
        byProject.set(r.project_id, p);
        const tt = byTicketType.get(r.task_type) || { key: r.task_type, ...bucketBase() };
        accumulate(tt, r);
        byTicketType.set(r.task_type, tt);
      }
      for (const p of byProject.values()) p.cost = round4(p.cost);
      for (const t of byTicketType.values()) t.cost = round4(t.cost);

      const anomalies = detectCostAnomalies(
        aRes.rows.map((r: any) => ({
          agentId: r.agent_id,
          currentAvgCost: r.current_avg != null ? Number(r.current_avg) : null,
          currentDispatches: Number(r.current_n || 0),
          priorAvgCost: r.prior_avg != null ? Number(r.prior_avg) : null,
          priorDispatches: Number(r.prior_n || 0),
        })),
      );

      const desc = (a: any, b: any) => b.cost - a.cost || b.calls - a.calls;
      return {
        workspaceId,
        windowDays: days,
        totals,
        byAgent: [...byAgent.values()].sort(desc),
        byModel: [...byModel.values()].sort(desc),
        bySource: bySource.sort(desc),
        byProject: [...byProject.values()].sort(desc),
        byTicketType: [...byTicketType.values()].sort(desc),
        trend: [...trend.values()].sort((a, b) => a.day.localeCompare(b.day)),
        anomalies,
        queryMs: Date.now() - started,
      };
    }
  } catch (e: any) {
    logOnce('getCostAnalytics', 'rollup failed:', e);
    return null;
  }
}
