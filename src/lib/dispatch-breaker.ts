/**
 * dispatch-breaker.ts — #1643 (T3: dispatch budgets, circuit breaker,
 * summarized alerting).
 *
 * Per-workspace dispatch budget: max turns/hour + concurrent-turn cap,
 * configurable via `settings.dispatchBudget`. When a dispatch would exceed
 * the budget, the breaker QUEUES the dispatch *intent* (agentId + source)
 * instead of firing it — never drops. A background drain tick re-fires
 * queued intents when the workspace is back under budget.
 *
 * Design decisions (locked in ticket comment):
 *   - The gate lives INSIDE fireOneShot (scheduler route), so all call
 *     sites are covered by construction — same pattern as #1521/#1641.
 *   - We queue INTENTS, not composed messages. The drain re-runs
 *     fireOneShot, which re-reads the store fresh (#1521), so a queued
 *     dispatch can never fire with stale state. Deduped per agent via a
 *     partial unique index (one pending intent per agent is sufficient:
 *     buildDispatchMessage picks the current top task anyway).
 *   - Exactly ONE alert per breach window: alerts fire only when a
 *     breach-window row is INSERTed (rowCount-checked against a partial
 *     unique index → restart-safe idempotency, no in-memory state).
 *     Delivery reuses the #1621 HMAC'd health-alerts webhook — no new
 *     notification channel.
 *   - The budget check is AWAITED (it's a real gate) but fails OPEN:
 *     if the observability substrate (Postgres) is down, dispatch
 *     proceeds unbudgeted rather than stalling the org. Fail-loud via
 *     logOnce, not fail-closed.
 *   - Turns/hour is measured from the #1641 dispatch ledger
 *     (outcome='enqueued' rows in the trailing hour) — single source of
 *     truth, no second counter to drift.
 *
 * Anomaly nudges (same single-summary alert path, own window kinds):
 *   - 'volume-anomaly'  — trailing-hour dispatch volume > 3× the 7-day
 *     hourly baseline (with an absolute floor so quiet weeks don't
 *     false-positive).
 *   - 'turn-duration'   — a completed turn exceeded the configured
 *     duration ceiling.
 *
 * Host-signal ingestion lives in org_studio_host_samples (written by
 * lib/host-sampler.mjs locally and POST /api/observability/host from the
 * gateway). Joinable to ledger rows by time window — that's the "#1633
 * was found by fan noise; this makes the fan redundant" part.
 */

let _pool: any = undefined;
let _tablesEnsured = false;
const _loggedErrors = new Set<string>();

function logOnce(key: string, msg: string, err?: any): void {
  if (_loggedErrors.has(key)) return;
  _loggedErrors.add(key);
  console.error(`[DispatchBreaker] ${msg}`, err?.message || err || '');
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

/** Test hook: inject a fake pool (pattern from launch-already-current-1594 / #1641). */
export function __setPoolForTest(pool: any): void {
  _pool = pool;
  _tablesEnsured = true;
}

/** Test hook: inject a fake alert sender; returns calls for assertions. */
let _alertSender: ((payload: BreachAlertPayload) => Promise<void>) | null = null;
export function __setAlertSenderForTest(fn: ((p: BreachAlertPayload) => Promise<void>) | null): void {
  _alertSender = fn;
}

export function __resetForTest(): void {
  _pool = undefined;
  _tablesEnsured = false;
  _loggedErrors.clear();
  _alertSender = null;
  _lastAnomalyCheckMs = 0;
}

const CREATE_TABLES = `
  CREATE TABLE IF NOT EXISTS org_studio_dispatch_queue (
    id BIGSERIAL PRIMARY KEY,
    agent_id TEXT NOT NULL,
    source TEXT NOT NULL,
    workspace_id TEXT NOT NULL DEFAULT 'default-workspace',
    status TEXT NOT NULL DEFAULT 'pending',
    queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    drained_at TIMESTAMPTZ,
    drain_note TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_queue_pending_agent
    ON org_studio_dispatch_queue (workspace_id, agent_id)
    WHERE status = 'pending';
  CREATE INDEX IF NOT EXISTS idx_dispatch_queue_status
    ON org_studio_dispatch_queue (status, queued_at);

  CREATE TABLE IF NOT EXISTS org_studio_breaker_windows (
    id BIGSERIAL PRIMARY KEY,
    workspace_id TEXT NOT NULL DEFAULT 'default-workspace',
    kind TEXT NOT NULL,
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ,
    details TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_breaker_windows_open
    ON org_studio_breaker_windows (workspace_id, kind)
    WHERE closed_at IS NULL;

  CREATE TABLE IF NOT EXISTS org_studio_host_samples (
    id BIGSERIAL PRIMARY KEY,
    host TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'local',
    sampled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    load1 REAL,
    cpu_pct REAL,
    event_loop_delay_ms REAL,
    mem_used_mb REAL,
    mem_total_mb REAL
  );
  CREATE INDEX IF NOT EXISTS idx_host_samples_time
    ON org_studio_host_samples (sampled_at DESC);
`;

async function ensureTables(client: any): Promise<void> {
  if (_tablesEnsured) return;
  await client.query(CREATE_TABLES);
  _tablesEnsured = true;
}

// ── Budget config ─────────────────────────────────────────────────────────

export interface DispatchBudgetConfig {
  enabled: boolean;
  maxTurnsPerHour: number;
  maxConcurrentTurns: number;
  /** A completed turn longer than this triggers a 'turn-duration' anomaly alert. */
  turnDurationCeilingMs: number;
}

export const BUDGET_DEFAULTS: DispatchBudgetConfig = {
  enabled: true,
  maxTurnsPerHour: 30,
  maxConcurrentTurns: 4,
  turnDurationCeilingMs: 20 * 60 * 1000, // 20 minutes
};

/**
 * Resolve the effective budget config from workspace settings, applying
 * sane defaults for anything unset. `settings.dispatchBudget` is the
 * per-workspace knob (edited via the normal updateSettings path).
 */
export function resolveBudgetConfig(settings: any): DispatchBudgetConfig {
  const raw = settings?.dispatchBudget || {};
  const num = (v: any, dflt: number, min: number) =>
    typeof v === 'number' && Number.isFinite(v) && v >= min ? v : dflt;
  return {
    enabled: raw.enabled !== false, // default ON — silent-off would defeat the point
    maxTurnsPerHour: num(raw.maxTurnsPerHour, BUDGET_DEFAULTS.maxTurnsPerHour, 1),
    maxConcurrentTurns: num(raw.maxConcurrentTurns, BUDGET_DEFAULTS.maxConcurrentTurns, 1),
    turnDurationCeilingMs: num(raw.turnDurationCeilingMs, BUDGET_DEFAULTS.turnDurationCeilingMs, 1000),
  };
}

// ── Pure decision layer ───────────────────────────────────────────────────

export interface BudgetDecision {
  allow: boolean;
  reason?: string; // set when queued
}

/**
 * Pure budget evaluation — testable without a DB.
 * `turnsLastHour` counts ledger 'enqueued' rows in the trailing hour;
 * `concurrent` is the live in-flight agent count.
 */
export function evaluateBudget(
  cfg: DispatchBudgetConfig,
  usage: { turnsLastHour: number; concurrent: number },
): BudgetDecision {
  if (!cfg.enabled) return { allow: true };
  if (usage.concurrent >= cfg.maxConcurrentTurns) {
    return {
      allow: false,
      reason: `concurrent-cap: ${usage.concurrent}/${cfg.maxConcurrentTurns} turns in flight`,
    };
  }
  if (usage.turnsLastHour >= cfg.maxTurnsPerHour) {
    return {
      allow: false,
      reason: `hourly-cap: ${usage.turnsLastHour}/${cfg.maxTurnsPerHour} turns in trailing hour`,
    };
  }
  return { allow: true };
}

// ── Alerting (single summary per breach window, via #1621 webhook) ───────

export interface BreachAlertPayload {
  agentId: string; // 'system' for workspace-level breaches
  metric: string;
  value: string | number;
  threshold: string | number;
  status: 'warning' | 'critical';
}

/**
 * Deliver a breach alert through the HMAC'd health-alerts webhook (#1621).
 * No new notification channel — this IS the channel. Signed with the same
 * shared secret the endpoint verifies (webhook-auth.mjs); when no secret
 * is configured (OSS/dev) the endpoint is open and we just POST.
 */
async function sendBreachAlert(payload: BreachAlertPayload): Promise<void> {
  if (_alertSender) return _alertSender(payload);
  const baseUrl = `http://127.0.0.1:${process.env.PORT || '4501'}`;
  const rawBody = JSON.stringify(payload);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    // Shared canonical signer/verifier — same module the endpoint uses.
    const { computeHmacHex, resolveWebhookSecret } = await import(
      '../../lib/webhook-auth.mjs'
    );
    const secret = resolveWebhookSecret();
    if (secret) headers['X-Signature'] = `sha256=${computeHmacHex(rawBody, secret)}`;
  } catch (e: any) {
    logOnce('signer', 'webhook-auth import failed (sending unsigned):', e);
  }
  const res = await fetch(`${baseUrl}/api/webhooks/health-alerts`, {
    method: 'POST',
    headers,
    body: rawBody,
  });
  if (!res.ok) {
    // #1640 class — count non-ok internal responses, don't just swallow.
    const { recordInternalCallFailure } = await import('./dispatch-ledger');
    recordInternalCallFailure('dispatch-breaker:alert', '/api/webhooks/health-alerts', res.status, 'http-status');
  }
}

/**
 * Open a breach window for (workspace, kind) and — IFF this call created
 * the window (partial-unique INSERT actually inserted) — send exactly one
 * summarized alert. Re-entrant and restart-safe: while a window is open,
 * every subsequent breach is silent by construction. Fire-and-forget.
 */
export function openBreachWindow(
  workspaceId: string,
  kind: string,
  details: string,
  alert: BreachAlertPayload,
): void {
  void (async () => {
    try {
      const pool = await getPool();
      if (!pool) return;
      const client = await pool.connect();
      let inserted = false;
      try {
        await ensureTables(client);
        const res = await client.query(
          `INSERT INTO org_studio_breaker_windows (workspace_id, kind, details)
           VALUES ($1, $2, $3)
           ON CONFLICT (workspace_id, kind) WHERE closed_at IS NULL DO NOTHING`,
          [workspaceId, kind, details],
        );
        inserted = (res?.rowCount ?? 0) > 0;
      } finally {
        client.release();
      }
      if (inserted) {
        console.warn(`[DispatchBreaker] breach window OPENED (${kind}): ${details}`);
        try {
          await sendBreachAlert(alert);
        } catch (e: any) {
          // Alert failure must not roll back the window — the breach is
          // still real and the /health surface shows the open window.
          logOnce(`alert-${kind}`, `breach alert send failed (${kind}):`, e);
        }
      }
    } catch (e: any) {
      logOnce('openBreachWindow', 'openBreachWindow failed:', e);
    }
  })();
}

/** Close any open window of `kind` for the workspace (condition cleared). */
async function closeBreachWindow(client: any, workspaceId: string, kind: string): Promise<void> {
  const res = await client.query(
    `UPDATE org_studio_breaker_windows
     SET closed_at = NOW()
     WHERE workspace_id = $1 AND kind = $2 AND closed_at IS NULL`,
    [workspaceId, kind],
  );
  if ((res?.rowCount ?? 0) > 0) {
    console.log(`[DispatchBreaker] breach window CLOSED (${kind})`);
  }
}

// ── The gate (called from fireOneShot) ────────────────────────────────────

export interface GateResult {
  allow: boolean;
  queued: boolean;
  reason?: string;
}

/**
 * Budget gate + queue. Called from fireOneShot for every dispatch attempt.
 *
 * AWAITED (it's a real gate) but fails OPEN on any substrate error —
 * a broken observability layer must never stall the org (constraint:
 * breaker must never drop work; failing open preserves that trivially).
 *
 * When over budget: queues the dispatch intent (deduped per agent via the
 * pending-partial-unique index — ON CONFLICT DO NOTHING makes a duplicate
 * trigger a no-op, which is correct: one pending intent per agent already
 * guarantees the agent gets dispatched on drain) and opens the breach
 * window (which alerts exactly once).
 */
export async function gateDispatch(args: {
  cfg: DispatchBudgetConfig;
  agentId: string;
  source: string;
  concurrent: number;
  workspaceId?: string;
}): Promise<GateResult> {
  const workspaceId = args.workspaceId || 'default-workspace';
  if (!args.cfg.enabled) return { allow: true, queued: false };
  try {
    const pool = await getPool();
    if (!pool) return { allow: true, queued: false }; // file mode — no budget substrate
    const client = await pool.connect();
    try {
      await ensureTables(client);
      const cRes = await client.query(
        `SELECT count(*)::int AS cnt FROM org_studio_dispatch_ledger
         WHERE outcome = 'enqueued' AND workspace_id = $1
           AND dispatched_at >= NOW() - INTERVAL '1 hour'`,
        [workspaceId],
      );
      const turnsLastHour = cRes.rows[0]?.cnt ?? 0;
      const decision = evaluateBudget(args.cfg, {
        turnsLastHour,
        concurrent: args.concurrent,
      });
      if (decision.allow) return { allow: true, queued: false };

      // Over budget → queue the intent (never drop).
      await client.query(
        `INSERT INTO org_studio_dispatch_queue (agent_id, source, workspace_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (workspace_id, agent_id) WHERE status = 'pending' DO NOTHING`,
        [args.agentId, args.source, workspaceId],
      );

      openBreachWindow(
        workspaceId,
        'budget',
        decision.reason || 'over budget',
        {
          agentId: 'system',
          metric: 'dispatch-budget-breach',
          value: decision.reason || 'over budget',
          threshold: `${args.cfg.maxTurnsPerHour}/h, ${args.cfg.maxConcurrentTurns} concurrent`,
          status: 'warning',
        },
      );

      return { allow: false, queued: true, reason: decision.reason };
    } finally {
      client.release();
    }
  } catch (e: any) {
    logOnce('gateDispatch', 'budget gate failed — failing OPEN:', e);
    return { allow: true, queued: false };
  }
}

// ── Drain (background tick) ───────────────────────────────────────────────

export interface DrainResult {
  drained: string[]; // agentIds re-fired
  remaining: number; // pending intents left in queue
  skippedReason?: string;
}

/**
 * Drain queued dispatch intents while under budget.
 *
 * For each pending intent (oldest first): re-check budget headroom, mark
 * the row drained, and hand the agentId to `refire`. `refire` re-runs the
 * normal fireOneShot path, which re-reads the store fresh — and re-queues
 * via the gate if the budget was exhausted mid-drain, so work is never
 * lost, only deferred (queue → drain → gate → queue is a safe cycle).
 */
export async function drainQueue(args: {
  cfg: DispatchBudgetConfig;
  concurrent: number;
  workspaceId?: string;
  refire: (agentId: string, source: string) => Promise<void>;
}): Promise<DrainResult> {
  const workspaceId = args.workspaceId || 'default-workspace';
  try {
    const pool = await getPool();
    if (!pool) return { drained: [], remaining: 0, skippedReason: 'no-db' };
    const client = await pool.connect();
    let rows: any[] = [];
    let turnsLastHour = 0;
    try {
      await ensureTables(client);
      const cRes = await client.query(
        `SELECT count(*)::int AS cnt FROM org_studio_dispatch_ledger
         WHERE outcome = 'enqueued' AND workspace_id = $1
           AND dispatched_at >= NOW() - INTERVAL '1 hour'`,
        [workspaceId],
      );
      turnsLastHour = cRes.rows[0]?.cnt ?? 0;

      const qRes = await client.query(
        `SELECT id, agent_id, source FROM org_studio_dispatch_queue
         WHERE status = 'pending' AND workspace_id = $1
         ORDER BY queued_at ASC
         LIMIT 20`,
        [workspaceId],
      );
      rows = qRes.rows;

      if (rows.length === 0) {
        // Queue empty and under budget → the breach is over; close the window.
        if (evaluateBudget(args.cfg, { turnsLastHour, concurrent: args.concurrent }).allow) {
          await closeBreachWindow(client, workspaceId, 'budget');
        }
        return { drained: [], remaining: 0 };
      }
    } finally {
      client.release();
    }

    const drained: string[] = [];
    let concurrent = args.concurrent;
    let budgetUsed = turnsLastHour;
    for (const row of rows) {
      const decision = evaluateBudget(args.cfg, { turnsLastHour: budgetUsed, concurrent });
      if (!decision.allow) break; // still over budget — leave the rest queued

      // Mark drained BEFORE refire: refire goes through the gate again, so
      // if the budget is racing we get a fresh queue row, not a stuck one.
      const client2 = await pool.connect();
      try {
        const upd = await client2.query(
          `UPDATE org_studio_dispatch_queue
           SET status = 'drained', drained_at = NOW()
           WHERE id = $1 AND status = 'pending'`,
          [row.id],
        );
        if ((upd?.rowCount ?? 0) === 0) continue; // another drainer got it
      } finally {
        client2.release();
      }

      try {
        await args.refire(row.agent_id, row.source);
      } catch (e: any) {
        logOnce(`refire-${row.agent_id}`, `refire failed for ${row.agent_id}:`, e);
      }
      drained.push(row.agent_id);
      budgetUsed++;
      concurrent++;
    }

    // Recount what's left.
    const client3 = await pool.connect();
    let remaining = 0;
    try {
      const rRes = await client3.query(
        `SELECT count(*)::int AS cnt FROM org_studio_dispatch_queue
         WHERE status = 'pending' AND workspace_id = $1`,
        [workspaceId],
      );
      remaining = rRes.rows[0]?.cnt ?? 0;
      if (remaining === 0 && evaluateBudget(args.cfg, { turnsLastHour: budgetUsed, concurrent }).allow) {
        await closeBreachWindow(client3, workspaceId, 'budget');
      }
    } finally {
      client3.release();
    }

    if (drained.length > 0) {
      console.log(`[DispatchBreaker] drained ${drained.length} queued dispatch(es): ${drained.join(', ')} (${remaining} remaining)`);
    }
    return { drained, remaining };
  } catch (e: any) {
    logOnce('drainQueue', 'drainQueue failed:', e);
    return { drained: [], remaining: -1, skippedReason: String(e?.message || e) };
  }
}

// ── Anomaly nudges ────────────────────────────────────────────────────────

const ANOMALY_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const VOLUME_ANOMALY_FACTOR = 3;
/** Absolute floor: below this many turns/hour, never flag volume anomalies
 * (a 7-day quiet baseline of 0.1/h would make 1 turn a "10x spike"). */
const VOLUME_ANOMALY_FLOOR = 10;
let _lastAnomalyCheckMs = 0;

/**
 * Volume + turn-duration anomaly detection. Throttled to once per 5 min
 * (called from the same server tick as drainQueue). Uses the same
 * open-window-→-single-alert mechanism as budget breaches.
 */
export async function checkAnomalies(args: {
  cfg: DispatchBudgetConfig;
  workspaceId?: string;
  /** Test hook: bypass the 5-min throttle. */
  force?: boolean;
}): Promise<void> {
  const now = Date.now();
  if (!args.force && now - _lastAnomalyCheckMs < ANOMALY_CHECK_INTERVAL_MS) return;
  _lastAnomalyCheckMs = now;
  const workspaceId = args.workspaceId || 'default-workspace';
  try {
    const pool = await getPool();
    if (!pool) return;
    const client = await pool.connect();
    try {
      await ensureTables(client);

      // Volume: trailing hour vs 7-day hourly baseline.
      const vRes = await client.query(
        `SELECT
           count(*) FILTER (WHERE dispatched_at >= NOW() - INTERVAL '1 hour')::int AS last_hour,
           count(*) FILTER (WHERE dispatched_at >= NOW() - INTERVAL '7 days')::int AS last_week
         FROM org_studio_dispatch_ledger
         WHERE outcome = 'enqueued' AND workspace_id = $1`,
        [workspaceId],
      );
      const lastHour = vRes.rows[0]?.last_hour ?? 0;
      const baseline = (vRes.rows[0]?.last_week ?? 0) / (7 * 24);
      const volumeAnomalous =
        lastHour >= VOLUME_ANOMALY_FLOOR && lastHour > baseline * VOLUME_ANOMALY_FACTOR;
      if (volumeAnomalous) {
        openBreachWindow(workspaceId, 'volume-anomaly',
          `${lastHour} dispatches in trailing hour vs ${baseline.toFixed(2)}/h 7-day baseline`,
          {
            agentId: 'system',
            metric: 'dispatch-volume-anomaly',
            value: `${lastHour}/h`,
            threshold: `${VOLUME_ANOMALY_FACTOR}x baseline (${(baseline * VOLUME_ANOMALY_FACTOR).toFixed(1)}/h)`,
            status: 'warning',
          });
      } else {
        await closeBreachWindow(client, workspaceId, 'volume-anomaly');
      }

      // Turn duration: any turn completed in the last check interval that
      // exceeded the ceiling.
      const dRes = await client.query(
        `SELECT agent_id, duration_ms FROM org_studio_dispatch_ledger
         WHERE workspace_id = $1 AND completed_at >= NOW() - INTERVAL '10 minutes'
           AND duration_ms > $2
         ORDER BY duration_ms DESC LIMIT 1`,
        [workspaceId, args.cfg.turnDurationCeilingMs],
      );
      if (dRes.rows.length > 0) {
        const worst = dRes.rows[0];
        openBreachWindow(workspaceId, 'turn-duration',
          `agent ${worst.agent_id} turn ran ${Math.round(Number(worst.duration_ms) / 1000)}s (ceiling ${Math.round(args.cfg.turnDurationCeilingMs / 1000)}s)`,
          {
            agentId: worst.agent_id,
            metric: 'turn-duration-ceiling',
            value: `${Math.round(Number(worst.duration_ms) / 1000)}s`,
            threshold: `${Math.round(args.cfg.turnDurationCeilingMs / 1000)}s`,
            status: 'warning',
          });
      } else {
        await closeBreachWindow(client, workspaceId, 'turn-duration');
      }
    } finally {
      client.release();
    }
  } catch (e: any) {
    logOnce('checkAnomalies', 'anomaly check failed:', e);
  }
}

// ── Host samples ──────────────────────────────────────────────────────────

export interface HostSample {
  host: string;
  source?: string; // 'local' | 'gateway' | ...
  load1?: number | null;
  cpuPct?: number | null;
  eventLoopDelayMs?: number | null;
  memUsedMb?: number | null;
  memTotalMb?: number | null;
}

/** Insert a host sample (from the local sampler or the gateway push endpoint). */
export async function recordHostSample(s: HostSample): Promise<boolean> {
  try {
    const pool = await getPool();
    if (!pool) return false;
    const client = await pool.connect();
    try {
      await ensureTables(client);
      await client.query(
        `INSERT INTO org_studio_host_samples
           (host, source, load1, cpu_pct, event_loop_delay_ms, mem_used_mb, mem_total_mb)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          s.host,
          s.source || 'local',
          s.load1 ?? null,
          s.cpuPct ?? null,
          s.eventLoopDelayMs ?? null,
          s.memUsedMb ?? null,
          s.memTotalMb ?? null,
        ],
      );
      return true;
    } finally {
      client.release();
    }
  } catch (e: any) {
    logOnce('recordHostSample', 'recordHostSample failed:', e);
    return false;
  }
}

/** Prune host samples older than 7 days (called from the server tick). */
export async function pruneHostSamples(): Promise<void> {
  try {
    const pool = await getPool();
    if (!pool) return;
    await pool.query(
      `DELETE FROM org_studio_host_samples WHERE sampled_at < NOW() - INTERVAL '7 days'`,
    );
  } catch (e: any) {
    logOnce('pruneHostSamples', 'prune failed:', e);
  }
}

// ── Read surface (/api/observability) ────────────────────────────────────

export interface BreakerSummary {
  budget: DispatchBudgetConfig;
  turnsLastHour: number;
  queue: { pending: number; oldestQueuedAt: string | null };
  openWindows: Array<{ kind: string; openedAt: string; details: string | null }>;
  hostSamples: {
    count: number;
    latest: null | {
      host: string;
      sampledAt: string;
      load1: number | null;
      eventLoopDelayMs: number | null;
      memUsedMb: number | null;
    };
    /** p95 event-loop delay + max load over the window, for at-a-glance health. */
    p95EventLoopDelayMs: number | null;
    maxLoad1: number | null;
  };
}

export async function getBreakerSummary(
  settings: any,
  windowMinutes: number,
  workspaceId = 'default-workspace',
): Promise<BreakerSummary | null> {
  try {
    const pool = await getPool();
    if (!pool) return null;
    const client = await pool.connect();
    try {
      await ensureTables(client);
      const cfg = resolveBudgetConfig(settings);

      const tRes = await client.query(
        `SELECT count(*)::int AS cnt FROM org_studio_dispatch_ledger
         WHERE outcome = 'enqueued' AND workspace_id = $1
           AND dispatched_at >= NOW() - INTERVAL '1 hour'`,
        [workspaceId],
      );
      const qRes = await client.query(
        `SELECT count(*)::int AS cnt, min(queued_at) AS oldest
         FROM org_studio_dispatch_queue
         WHERE status = 'pending' AND workspace_id = $1`,
        [workspaceId],
      );
      const wRes = await client.query(
        `SELECT kind, opened_at, details FROM org_studio_breaker_windows
         WHERE workspace_id = $1 AND closed_at IS NULL
         ORDER BY opened_at ASC`,
        [workspaceId],
      );
      const clamped = Math.max(1, Math.min(60 * 24 * 90, windowMinutes));
      const hRes = await client.query(
        `SELECT host, sampled_at, load1, event_loop_delay_ms, mem_used_mb
         FROM org_studio_host_samples
         WHERE sampled_at >= NOW() - INTERVAL '1 minute' * $1
         ORDER BY sampled_at DESC`,
        [clamped],
      );

      const delays = hRes.rows
        .map((r: any) => (r.event_loop_delay_ms != null ? Number(r.event_loop_delay_ms) : null))
        .filter((v: number | null): v is number => v != null)
        .sort((a: number, b: number) => a - b);
      const p95Delay = delays.length
        ? delays[Math.min(delays.length - 1, Math.floor(delays.length * 0.95))]
        : null;
      const loads = hRes.rows
        .map((r: any) => (r.load1 != null ? Number(r.load1) : null))
        .filter((v: number | null): v is number => v != null);
      const latest = hRes.rows[0]
        ? {
            host: hRes.rows[0].host,
            sampledAt: hRes.rows[0].sampled_at,
            load1: hRes.rows[0].load1 != null ? Number(hRes.rows[0].load1) : null,
            eventLoopDelayMs:
              hRes.rows[0].event_loop_delay_ms != null ? Number(hRes.rows[0].event_loop_delay_ms) : null,
            memUsedMb: hRes.rows[0].mem_used_mb != null ? Number(hRes.rows[0].mem_used_mb) : null,
          }
        : null;

      return {
        budget: cfg,
        turnsLastHour: tRes.rows[0]?.cnt ?? 0,
        queue: {
          pending: qRes.rows[0]?.cnt ?? 0,
          oldestQueuedAt: qRes.rows[0]?.oldest ?? null,
        },
        openWindows: wRes.rows.map((r: any) => ({
          kind: r.kind,
          openedAt: r.opened_at,
          details: r.details,
        })),
        hostSamples: {
          count: hRes.rows.length,
          latest,
          p95EventLoopDelayMs: p95Delay,
          maxLoad1: loads.length ? Math.max(...loads) : null,
        },
      };
    } finally {
      client.release();
    }
  } catch (e: any) {
    logOnce('getBreakerSummary', 'summary failed:', e);
    return null;
  }
}
