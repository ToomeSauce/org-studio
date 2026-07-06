/**
 * dispatch-ledger.ts — #1641 (T1 observability substrate).
 *
 * Persists every agent dispatch to Postgres instead of log-only
 * `[dispatch #1515]` lines, plus two sibling tables:
 *
 *   org_studio_dispatch_ledger      — one row per fireOneShot invocation
 *   org_studio_dispatch_model_calls — one row per model call within a turn
 *                                     (fallback retries / sub-agents = multiple
 *                                     rows), keyed by dispatch_id
 *   org_studio_internal_call_failures — upsert counters for internal
 *                                     fetch/provider failures (the #1640 class:
 *                                     swallowed catch{}, surface reports fine)
 *
 * Design constraints (ticket #1641):
 *   - Fire-and-forget: no ledger write may block or fail a dispatch. Every
 *     public function catches internally and logs at most once per process
 *     per error signature.
 *   - Additive schema only (CREATE TABLE IF NOT EXISTS; no destructive DDL).
 *   - Runtime-neutral: token columns are nullable; runtimes that don't report
 *     usage (Hermes) simply leave them null.
 *   - Cost attribution is on model_served, never model_requested — fallback
 *     chains make requested-model attribution fiction.
 *
 * Why this exists: #1633 (7 agents × heavy turns/30min, found by fan noise),
 * #1640 (silent 401 on an internal fetch for 2 weeks), and the 2026-07-06
 * promote-sweep bug (per-item SQL error caught silently, launch reported
 * success with movedTasks:0) are all the same failure class — internal
 * degradation with no instrument. This module is the instrument.
 */

let _pool: any = undefined;
let _tablesEnsured = false;
const _loggedErrors = new Set<string>();

function logOnce(key: string, msg: string, err?: any): void {
  if (_loggedErrors.has(key)) return;
  _loggedErrors.add(key);
  console.error(`[DispatchLedger] ${msg}`, err?.message || err || '');
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

/** Test hook: inject a fake pool (pattern from launch-already-current-1594). */
export function __setPoolForTest(pool: any): void {
  _pool = pool;
  _tablesEnsured = true;
}

export function __resetForTest(): void {
  _pool = undefined;
  _tablesEnsured = false;
  _loggedErrors.clear();
}

const CREATE_TABLES = `
  CREATE TABLE IF NOT EXISTS org_studio_dispatch_ledger (
    id BIGSERIAL PRIMARY KEY,
    dispatch_id TEXT UNIQUE,
    agent_id TEXT NOT NULL,
    source TEXT NOT NULL,
    trigger_reason TEXT,
    outcome TEXT NOT NULL,
    dispatched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    duration_ms BIGINT,
    read_ms INTEGER,
    concurrent_dispatch_count INTEGER NOT NULL DEFAULT 0,
    ticket_fingerprint TEXT,
    workspace_id TEXT NOT NULL DEFAULT 'default-workspace'
  );
  CREATE INDEX IF NOT EXISTS idx_dispatch_ledger_agent_time
    ON org_studio_dispatch_ledger (agent_id, dispatched_at DESC);
  CREATE INDEX IF NOT EXISTS idx_dispatch_ledger_time
    ON org_studio_dispatch_ledger (dispatched_at DESC);

  CREATE TABLE IF NOT EXISTS org_studio_dispatch_model_calls (
    id BIGSERIAL PRIMARY KEY,
    dispatch_id TEXT,
    agent_id TEXT,
    model_requested TEXT,
    model_served TEXT,
    provider TEXT,
    tokens_in BIGINT,
    tokens_out BIGINT,
    cache_read_tokens BIGINT,
    cache_write_tokens BIGINT,
    cost_estimate NUMERIC(12,6),
    called_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    workspace_id TEXT NOT NULL DEFAULT 'default-workspace'
  );
  CREATE INDEX IF NOT EXISTS idx_dispatch_model_calls_dispatch
    ON org_studio_dispatch_model_calls (dispatch_id);
  CREATE INDEX IF NOT EXISTS idx_dispatch_model_calls_time
    ON org_studio_dispatch_model_calls (called_at DESC);

  CREATE TABLE IF NOT EXISTS org_studio_session_usage_snapshots (
    session_key TEXT PRIMARY KEY,
    tokens_in BIGINT,
    tokens_out BIGINT,
    total_tokens BIGINT,
    cost_usd NUMERIC(12,6),
    model TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS org_studio_internal_call_failures (
    id BIGSERIAL PRIMARY KEY,
    caller TEXT NOT NULL,
    target TEXT NOT NULL,
    status_code INTEGER,
    error_kind TEXT,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    count BIGINT NOT NULL DEFAULT 1,
    UNIQUE (caller, target, status_code, error_kind)
  );
`;

async function ensureTables(client: any): Promise<void> {
  if (_tablesEnsured) return;
  await client.query(CREATE_TABLES);
  _tablesEnsured = true;
}

export type DispatchOutcome =
  | 'enqueued'          // dispatch message enqueued to outbox
  | 'no-work'           // buildDispatchMessage found nothing actionable
  | 'skipped-in-flight' // agent already mid-turn
  | 'enqueue-failed';   // enqueueOutbox threw

export interface LedgerDispatch {
  dispatchId?: string; // idempotencyKey when enqueued; undefined for skips
  agentId: string;
  source: string;
  outcome: DispatchOutcome;
  readMs?: number;
  concurrentDispatchCount?: number;
  ticketFingerprint?: string;
  triggerReason?: string;
  workspaceId?: string;
}

/**
 * Record a dispatch attempt/enqueue. Fire-and-forget — swallow everything.
 */
export function recordDispatch(d: LedgerDispatch): void {
  void (async () => {
    try {
      const pool = await getPool();
      if (!pool) return;
      const client = await pool.connect();
      try {
        await ensureTables(client);
        await client.query(
          `INSERT INTO org_studio_dispatch_ledger
             (dispatch_id, agent_id, source, trigger_reason, outcome, read_ms,
              concurrent_dispatch_count, ticket_fingerprint, workspace_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (dispatch_id) DO NOTHING`,
          [
            d.dispatchId ?? null,
            d.agentId,
            d.source,
            d.triggerReason ?? null,
            d.outcome,
            d.readMs ?? null,
            d.concurrentDispatchCount ?? 0,
            d.ticketFingerprint ?? null,
            d.workspaceId ?? 'default-workspace',
          ],
        );
      } finally {
        client.release();
      }
    } catch (e: any) {
      logOnce('recordDispatch', 'recordDispatch failed:', e);
    }
  })();
}

/**
 * Mark the most recent 'enqueued' ledger row for this agent completed.
 * Called from the outbox-drain onComplete callback, which only knows the
 * agentId — dispatch_id isn't threaded through the runtime completion
 * signal yet (acceptable for T1: at most one in-flight dispatch per agent,
 * enforced by isInFlight, so "latest enqueued" is unambiguous).
 */
export function completeDispatch(agentId: string): void {
  void (async () => {
    try {
      const pool = await getPool();
      if (!pool) return;
      const client = await pool.connect();
      try {
        await ensureTables(client);
        await client.query(
          `UPDATE org_studio_dispatch_ledger
           SET completed_at = NOW(),
               duration_ms = (EXTRACT(EPOCH FROM (NOW() - dispatched_at)) * 1000)::BIGINT
           WHERE id = (
             SELECT id FROM org_studio_dispatch_ledger
             WHERE agent_id = $1 AND outcome = 'enqueued' AND completed_at IS NULL
             ORDER BY dispatched_at DESC LIMIT 1
           )`,
          [agentId],
        );
      } finally {
        client.release();
      }
    } catch (e: any) {
      logOnce('completeDispatch', 'completeDispatch failed:', e);
    }
  })();
}

// ── Token capture ─────────────────────────────────────────────────────────

/**
 * Rough per-1M-token USD pricing, keyed by substring of model_served.
 * First match wins; order matters (more specific first). Unknown models
 * get null cost (counted, shown as 'unmetered' in T4 — see #1644).
 * Update prices here; T4 may move this to a table.
 */
const PRICE_TABLE: Array<{ match: string; inPer1M: number; outPer1M: number; cacheReadPer1M?: number }> = [
  { match: 'opus', inPer1M: 15, outPer1M: 75, cacheReadPer1M: 1.5 },
  { match: 'sonnet', inPer1M: 3, outPer1M: 15, cacheReadPer1M: 0.3 },
  { match: 'haiku', inPer1M: 0.8, outPer1M: 4, cacheReadPer1M: 0.08 },
  { match: 'gpt-5.4-pro', inPer1M: 21, outPer1M: 168 },
  { match: 'gpt-5.4', inPer1M: 1.75, outPer1M: 14 },
  { match: 'gpt-5.3-codex', inPer1M: 1.75, outPer1M: 14 },
  { match: 'gpt-5', inPer1M: 1.75, outPer1M: 14 },
];

/** Estimate USD cost for a model call; null when model unknown or tokens missing. */
export function estimateCost(
  modelServed: string | null | undefined,
  tokensIn: number | null | undefined,
  tokensOut: number | null | undefined,
  cacheReadTokens?: number | null,
): number | null {
  if (!modelServed || tokensIn == null || tokensOut == null) return null;
  const lower = modelServed.toLowerCase();
  const price = PRICE_TABLE.find((p) => lower.includes(p.match));
  if (!price) return null;
  const cacheRead = cacheReadTokens ?? 0;
  // Cache-read tokens are billed at the discounted rate, not the input rate.
  const freshIn = Math.max(0, tokensIn - cacheRead);
  const cost =
    (freshIn / 1_000_000) * price.inPer1M +
    (cacheRead / 1_000_000) * (price.cacheReadPer1M ?? price.inPer1M * 0.1) +
    (tokensOut / 1_000_000) * price.outPer1M;
  return Math.round(cost * 1e6) / 1e6;
}

export interface ModelCallReport {
  dispatchId?: string;
  agentId?: string;
  modelRequested?: string;
  modelServed?: string;
  provider?: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  workspaceId?: string;
}

/**
 * Record one model call within a dispatch/turn. Capability-gated by the
 * caller: runtimes that don't report usage simply never call this (or call
 * with null tokens — both fine). Fire-and-forget.
 */
export function recordModelCall(r: ModelCallReport): void {
  void (async () => {
    try {
      const pool = await getPool();
      if (!pool) return;
      const client = await pool.connect();
      try {
        await ensureTables(client);
        const cost = estimateCost(r.modelServed, r.tokensIn, r.tokensOut, r.cacheReadTokens);
        await client.query(
          `INSERT INTO org_studio_dispatch_model_calls
             (dispatch_id, agent_id, model_requested, model_served, provider,
              tokens_in, tokens_out, cache_read_tokens, cache_write_tokens,
              cost_estimate, workspace_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            r.dispatchId ?? null,
            r.agentId ?? null,
            r.modelRequested ?? null,
            r.modelServed ?? null,
            r.provider ?? null,
            r.tokensIn ?? null,
            r.tokensOut ?? null,
            r.cacheReadTokens ?? null,
            r.cacheWriteTokens ?? null,
            cost,
            r.workspaceId ?? 'default-workspace',
          ],
        );
      } finally {
        client.release();
      }
    } catch (e: any) {
      logOnce('recordModelCall', 'recordModelCall failed:', e);
    }
  })();
}

// ── Session-usage delta capture (OpenClaw runtime) ───────────────────────

/**
 * The OpenClaw gateway reports CUMULATIVE per-session usage
 * (inputTokens/outputTokens/estimatedCostUsd on sessions.list rows) — not
 * per-turn. To attribute usage to a dispatch, we snapshot the session's
 * counters and record the DELTA since the previous snapshot as one
 * model-call row keyed to the completing dispatch.
 *
 * Caveats (documented, acceptable for T1):
 *   - The delta covers everything the session did between snapshots — if a
 *     human chats with the agent mid-dispatch, that usage lands in the
 *     dispatch's row. Per-turn attribution needs runtime support (future).
 *   - Counter resets (gateway restart, session rebind) make the delta
 *     negative — we detect that and re-baseline without recording.
 *   - modelRequested comes from the loop/teammate config when the caller
 *     passes it; modelServed from the live session row.
 * Fire-and-forget.
 */
export function captureSessionUsageDelta(args: {
  sessionKey: string;
  agentId: string;
  dispatchId?: string;
  modelRequested?: string;
  current: {
    tokensIn?: number | null;
    tokensOut?: number | null;
    totalTokens?: number | null;
    costUsd?: number | null;
    model?: string | null;
    provider?: string | null;
  };
  workspaceId?: string;
}): void {
  void (async () => {
    try {
      const pool = await getPool();
      if (!pool) return;
      const client = await pool.connect();
      try {
        await ensureTables(client);
        const prevRes = await client.query(
          `SELECT tokens_in, tokens_out, cost_usd FROM org_studio_session_usage_snapshots WHERE session_key = $1`,
          [args.sessionKey],
        );
        const prev = prevRes.rows[0];
        const curIn = args.current.tokensIn ?? null;
        const curOut = args.current.tokensOut ?? null;
        const curCost = args.current.costUsd ?? null;

        // Upsert the new baseline first (always — even when we skip recording).
        await client.query(
          `INSERT INTO org_studio_session_usage_snapshots
             (session_key, tokens_in, tokens_out, total_tokens, cost_usd, model, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,NOW())
           ON CONFLICT (session_key) DO UPDATE SET
             tokens_in = EXCLUDED.tokens_in,
             tokens_out = EXCLUDED.tokens_out,
             total_tokens = EXCLUDED.total_tokens,
             cost_usd = EXCLUDED.cost_usd,
             model = EXCLUDED.model,
             updated_at = NOW()`,
          [
            args.sessionKey,
            curIn,
            curOut,
            args.current.totalTokens ?? null,
            curCost,
            args.current.model ?? null,
          ],
        );

        if (!prev || curIn == null || curOut == null) return; // first sighting or unmetered: baseline only
        const dIn = curIn - Number(prev.tokens_in ?? 0);
        const dOut = curOut - Number(prev.tokens_out ?? 0);
        if (dIn < 0 || dOut < 0) return; // counter reset — re-baselined above, don't record garbage
        if (dIn === 0 && dOut === 0) return; // nothing happened
        const dCost =
          curCost != null && prev.cost_usd != null && curCost >= Number(prev.cost_usd)
            ? Math.round((curCost - Number(prev.cost_usd)) * 1e6) / 1e6
            : null;

        const cost = dCost ?? estimateCost(args.current.model, dIn, dOut);
        await client.query(
          `INSERT INTO org_studio_dispatch_model_calls
             (dispatch_id, agent_id, model_requested, model_served, provider,
              tokens_in, tokens_out, cost_estimate, workspace_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            args.dispatchId ?? null,
            args.agentId,
            args.modelRequested ?? null,
            args.current.model ?? null,
            args.current.provider ?? null,
            dIn,
            dOut,
            cost,
            args.workspaceId ?? 'default-workspace',
          ],
        );
      } finally {
        client.release();
      }
    } catch (e: any) {
      logOnce('captureSessionUsageDelta', 'captureSessionUsageDelta failed:', e);
    }
  })();
}

// ── Internal-call failure counters (#1640 finding) ────────────────────────

/**
 * Upsert-increment a failure counter for an internal call. Call this from
 * every catch{} / !res.ok branch around internal fetches or provider calls.
 * caller = code site ('roadmap-route:currentVersion-sync'), target = route
 * or resource ('/api/store'), statusCode = HTTP status (null for throws),
 * errorKind = short classifier ('http-status' | 'fetch-throw' | 'timeout' | ...).
 * Fire-and-forget.
 */
export function recordInternalCallFailure(
  caller: string,
  target: string,
  statusCode?: number | null,
  errorKind?: string,
): void {
  void (async () => {
    try {
      const pool = await getPool();
      if (!pool) return;
      const client = await pool.connect();
      try {
        await ensureTables(client);
        await client.query(
          `INSERT INTO org_studio_internal_call_failures
             (caller, target, status_code, error_kind, count)
           VALUES ($1,$2,$3,$4,1)
           ON CONFLICT (caller, target, status_code, error_kind)
           DO UPDATE SET count = org_studio_internal_call_failures.count + 1,
                         last_seen = NOW()`,
          [caller, target, statusCode ?? -1, errorKind ?? 'unknown'],
        );
      } finally {
        client.release();
      }
    } catch (e: any) {
      logOnce('recordInternalCallFailure', 'recordInternalCallFailure failed:', e);
    }
  })();
}

// ── Read path (/api/observability) ───────────────────────────────────────

export interface ObservabilitySummary {
  windowMinutes: number;
  dispatches: {
    total: number;
    byAgent: Record<string, number>;
    bySource: Record<string, number>;
    byOutcome: Record<string, number>;
    perHour: number;
    p95DurationMs: number | null;
    maxConcurrent: number;
  };
  tokens: {
    calls: number;
    meteredCalls: number;
    tokensIn: number;
    tokensOut: number;
    costEstimate: number;
    byModelServed: Record<string, { calls: number; tokensIn: number; tokensOut: number; cost: number }>;
  };
  internalCallFailures: Array<{
    caller: string;
    target: string;
    statusCode: number;
    errorKind: string;
    count: number;
    firstSeen: string;
    lastSeen: string;
  }>;
}

export async function getObservabilitySummary(
  windowMinutes: number,
): Promise<ObservabilitySummary | null> {
  try {
    const pool = await getPool();
    if (!pool) return null;
    const client = await pool.connect();
    try {
      await ensureTables(client);
      const since = `NOW() - INTERVAL '${Math.max(1, Math.min(60 * 24 * 90, windowMinutes))} minutes'`;

      const dRes = await client.query(
        `SELECT agent_id, source, outcome, duration_ms, concurrent_dispatch_count
         FROM org_studio_dispatch_ledger WHERE dispatched_at >= ${since}`,
      );
      const byAgent: Record<string, number> = {};
      const bySource: Record<string, number> = {};
      const byOutcome: Record<string, number> = {};
      const durations: number[] = [];
      let maxConcurrent = 0;
      for (const row of dRes.rows) {
        byAgent[row.agent_id] = (byAgent[row.agent_id] || 0) + 1;
        bySource[row.source] = (bySource[row.source] || 0) + 1;
        byOutcome[row.outcome] = (byOutcome[row.outcome] || 0) + 1;
        if (row.duration_ms != null) durations.push(Number(row.duration_ms));
        if (row.concurrent_dispatch_count > maxConcurrent) maxConcurrent = row.concurrent_dispatch_count;
      }
      durations.sort((a, b) => a - b);
      const p95 = durations.length
        ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))]
        : null;

      const tRes = await client.query(
        `SELECT model_served, tokens_in, tokens_out, cost_estimate
         FROM org_studio_dispatch_model_calls WHERE called_at >= ${since}`,
      );
      const byModelServed: ObservabilitySummary['tokens']['byModelServed'] = {};
      let tokensIn = 0, tokensOut = 0, cost = 0, metered = 0;
      for (const row of tRes.rows) {
        const key = row.model_served || '(unreported)';
        const bucket = (byModelServed[key] ||= { calls: 0, tokensIn: 0, tokensOut: 0, cost: 0 });
        bucket.calls++;
        if (row.tokens_in != null) { bucket.tokensIn += Number(row.tokens_in); tokensIn += Number(row.tokens_in); }
        if (row.tokens_out != null) { bucket.tokensOut += Number(row.tokens_out); tokensOut += Number(row.tokens_out); }
        if (row.cost_estimate != null) { bucket.cost += Number(row.cost_estimate); cost += Number(row.cost_estimate); metered++; }
      }

      const fRes = await client.query(
        `SELECT caller, target, status_code, error_kind, count, first_seen, last_seen
         FROM org_studio_internal_call_failures
         WHERE last_seen >= ${since}
         ORDER BY last_seen DESC LIMIT 200`,
      );

      return {
        windowMinutes,
        dispatches: {
          total: dRes.rows.length,
          byAgent,
          bySource,
          byOutcome,
          perHour: Math.round((dRes.rows.length / (windowMinutes / 60)) * 100) / 100,
          p95DurationMs: p95,
          maxConcurrent,
        },
        tokens: {
          calls: tRes.rows.length,
          meteredCalls: metered,
          tokensIn,
          tokensOut,
          costEstimate: Math.round(cost * 1e4) / 1e4,
          byModelServed,
        },
        internalCallFailures: fRes.rows.map((r: any) => ({
          caller: r.caller,
          target: r.target,
          statusCode: r.status_code,
          errorKind: r.error_kind,
          count: Number(r.count),
          firstSeen: r.first_seen,
          lastSeen: r.last_seen,
        })),
      };
    } finally {
      client.release();
    }
  } catch (e: any) {
    logOnce('getObservabilitySummary', 'summary query failed:', e);
    return null;
  }
}
