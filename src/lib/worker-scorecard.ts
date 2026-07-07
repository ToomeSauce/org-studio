/**
 * Worker lane vs runtime lane scorecard (#1661, W-6).
 *
 * Read-only rollup over dispatch ledger/model-call tables + task status_history.
 * Returns null when Postgres is unavailable (same fail-open shape as budget-spend).
 */

type LaneKey = 'worker' | 'runtime';

type StatusHistoryEntry = {
  status?: string | null;
  timestamp?: number | string | null;
};

export interface LaneMetrics {
  lane: 'worker' | 'runtime';
  tickets: number;              // distinct tickets with attributed spend or status activity in window
  dispatches: number;
  costTotalUsd: number | null;  // sum cost_estimate (metered only)
  costPerTicketUsd: number | null;
  ticketsDone: number;
  medianTimeToDoneMs: number | null;  // per done ticket: first in-progress ts → last done ts from status_history
  bounces: number;              // backward moves across done tickets
  bounceRate: number | null;    // bounces-affected tickets / ticketsDone
}

export interface WorkerScorecard {
  windowDays: number;
  generatedAt: string;
  worker: LaneMetrics;
  runtime: LaneMetrics;
}

let poolPromise: Promise<any> | null = null;

async function getPool(): Promise<any> {
  if (!process.env.DATABASE_URL) return null;
  if (!poolPromise) {
    poolPromise = (async () => {
      const { Pool } = await import('pg');
      return new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    })();
  }
  return poolPromise;
}

const STATUS_ORDER: Record<string, number> = {
  planning: 0,
  backlog: 1,
  'in-progress': 2,
  done: 3,
};

function normalizeStatus(status: unknown): string {
  return typeof status === 'string' ? status.trim().toLowerCase() : '';
}

function toTimestampMs(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseStatusHistory(raw: unknown): StatusHistoryEntry[] {
  if (Array.isArray(raw)) return raw as StatusHistoryEntry[];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as StatusHistoryEntry[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function lastTimestampForStatus(history: StatusHistoryEntry[], status: string): number | null {
  const needle = normalizeStatus(status);
  for (let i = history.length - 1; i >= 0; i--) {
    if (normalizeStatus(history[i]?.status) === needle) {
      const ts = toTimestampMs(history[i]?.timestamp);
      if (ts != null) return ts;
    }
  }
  return null;
}

function firstTimestampForStatus(history: StatusHistoryEntry[], status: string): number | null {
  const needle = normalizeStatus(status);
  for (let i = 0; i < history.length; i++) {
    if (normalizeStatus(history[i]?.status) === needle) {
      const ts = toTimestampMs(history[i]?.timestamp);
      if (ts != null) return ts;
    }
  }
  return null;
}

function parseTicketNumber(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function assigneeLane(assignee: unknown): LaneKey {
  const who = typeof assignee === 'string' ? assignee.toLowerCase() : '';
  return who.startsWith('worker-') ? 'worker' : 'runtime';
}

function asLane(raw: unknown): LaneKey | null {
  return raw === 'worker' || raw === 'runtime' ? raw : null;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

export function computeMedian(values: number[]): number | null {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const mid = Math.floor(clean.length / 2);
  if (clean.length % 2 === 1) return clean[mid];
  return (clean[mid - 1] + clean[mid]) / 2;
}

export function computeTimeToDoneMs(historyRaw: StatusHistoryEntry[] | null | undefined): number | null {
  const history = Array.isArray(historyRaw) ? historyRaw : [];
  if (history.length === 0) return null;
  const firstInProgress = firstTimestampForStatus(history, 'in-progress');
  const lastDone = lastTimestampForStatus(history, 'done');
  if (firstInProgress == null || lastDone == null) return null;
  const delta = lastDone - firstInProgress;
  return delta >= 0 ? delta : null;
}

/**
 * Count backward pipeline transitions in a status history.
 * Pipeline order: planning < backlog < in-progress < done.
 * Any transition involving "blocked" is ignored both ways.
 */
export function countBounces(historyRaw: StatusHistoryEntry[] | null | undefined): number {
  const history = Array.isArray(historyRaw) ? historyRaw : [];
  let bounces = 0;
  for (let i = 1; i < history.length; i++) {
    const prevStatus = normalizeStatus(history[i - 1]?.status);
    const currStatus = normalizeStatus(history[i]?.status);
    if (!prevStatus || !currStatus) continue;
    if (prevStatus === 'blocked' || currStatus === 'blocked') continue;
    const prev = STATUS_ORDER[prevStatus];
    const curr = STATUS_ORDER[currStatus];
    if (prev == null || curr == null) continue;
    if (curr < prev) bounces += 1;
  }
  return bounces;
}

export async function getWorkerScorecard(
  workspaceId: string,
  windowDays: number,
): Promise<WorkerScorecard | null> {
  try {
    const pool = await getPool();
    if (!pool) return null;

    const days = Math.max(1, Math.min(90, Number.isFinite(windowDays) ? windowDays : 14));
    const since = `NOW() - INTERVAL '${days} days'`;
    const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;

    const [dispatchRes, costRes, attributedTicketRes, taskRes] = await Promise.all([
      pool.query(
        `SELECT
           CASE
             WHEN lower(COALESCE(source, '')) = 'worker'
               OR lower(COALESCE(agent_id, '')) LIKE 'worker-%'
             THEN 'worker'
             ELSE 'runtime'
           END AS lane,
           count(*)::int AS dispatches
         FROM org_studio_dispatch_ledger
         WHERE workspace_id = $1
           AND dispatched_at >= ${since}
         GROUP BY 1`,
        [workspaceId],
      ),
      pool.query(
        `WITH attributed AS (
           SELECT
             CASE
               WHEN lower(COALESCE(l.source, '')) = 'worker'
                 OR lower(COALESCE(l.agent_id, '')) LIKE 'worker-%'
               THEN 'worker'
               ELSE 'runtime'
             END AS lane,
             mc.cost_estimate
           FROM org_studio_dispatch_model_calls mc
           JOIN org_studio_dispatch_ledger l ON l.dispatch_id = mc.dispatch_id
           WHERE mc.workspace_id = $1
             AND l.workspace_id = $1
             AND mc.called_at >= ${since}
             AND l.dispatched_at >= ${since}
         )
         SELECT
           lane,
           count(cost_estimate)::int AS metered_calls,
           COALESCE(sum(cost_estimate), 0)::numeric AS cost_total
         FROM attributed
         GROUP BY 1`,
        [workspaceId],
      ),
      pool.query(
        `WITH attributed AS (
           SELECT
             CASE
               WHEN lower(COALESCE(l.source, '')) = 'worker'
                 OR lower(COALESCE(l.agent_id, '')) LIKE 'worker-%'
               THEN 'worker'
               ELSE 'runtime'
             END AS lane,
             NULLIF(split_part(split_part(l.ticket_fingerprint, ',', 1), ':', 1), '')::bigint AS ticket_number
           FROM org_studio_dispatch_model_calls mc
           JOIN org_studio_dispatch_ledger l ON l.dispatch_id = mc.dispatch_id
           WHERE mc.workspace_id = $1
             AND l.workspace_id = $1
             AND mc.called_at >= ${since}
             AND l.dispatched_at >= ${since}
             AND l.ticket_fingerprint ~ '^[0-9]+:'
         )
         SELECT lane, ticket_number
         FROM attributed
         WHERE ticket_number IS NOT NULL
         GROUP BY lane, ticket_number`,
        [workspaceId],
      ),
      pool.query(
        `SELECT ticket_number, assignee, status_history
         FROM org_studio_tasks
         WHERE workspace_id = $1
           AND is_archived IS DISTINCT FROM TRUE
           AND status_history IS NOT NULL`,
        [workspaceId],
      ),
    ]);

    const worker: LaneMetrics = {
      lane: 'worker',
      tickets: 0,
      dispatches: 0,
      costTotalUsd: null,
      costPerTicketUsd: null,
      ticketsDone: 0,
      medianTimeToDoneMs: null,
      bounces: 0,
      bounceRate: null,
    };

    const runtime: LaneMetrics = {
      lane: 'runtime',
      tickets: 0,
      dispatches: 0,
      costTotalUsd: null,
      costPerTicketUsd: null,
      ticketsDone: 0,
      medianTimeToDoneMs: null,
      bounces: 0,
      bounceRate: null,
    };

    const byLane: Record<LaneKey, LaneMetrics> = { worker, runtime };
    const ticketSets: Record<LaneKey, Set<number>> = {
      worker: new Set<number>(),
      runtime: new Set<number>(),
    };
    const durations: Record<LaneKey, number[]> = {
      worker: [],
      runtime: [],
    };
    const bouncedTickets: Record<LaneKey, number> = {
      worker: 0,
      runtime: 0,
    };

    for (const row of dispatchRes.rows || []) {
      const lane = asLane(row.lane);
      if (!lane) continue;
      byLane[lane].dispatches = Number(row.dispatches || 0);
    }

    for (const row of costRes.rows || []) {
      const lane = asLane(row.lane);
      if (!lane) continue;
      const metered = Number(row.metered_calls || 0);
      const total = Number(row.cost_total || 0);
      if (metered > 0 && Number.isFinite(total)) {
        byLane[lane].costTotalUsd = round6(total);
      }
    }

    for (const row of attributedTicketRes.rows || []) {
      const lane = asLane(row.lane);
      if (!lane) continue;
      const ticket = parseTicketNumber(row.ticket_number);
      if (ticket != null) ticketSets[lane].add(ticket);
    }

    for (const row of taskRes.rows || []) {
      const lane = assigneeLane(row.assignee);
      const ticket = parseTicketNumber(row.ticket_number);
      const history = parseStatusHistory(row.status_history);
      const lastDone = lastTimestampForStatus(history, 'done');
      if (lastDone == null || lastDone < sinceMs) continue;

      if (ticket != null) ticketSets[lane].add(ticket);
      byLane[lane].ticketsDone += 1;

      const ttd = computeTimeToDoneMs(history);
      if (ttd != null) durations[lane].push(ttd);

      const b = countBounces(history);
      byLane[lane].bounces += b;
      if (b > 0) bouncedTickets[lane] += 1;
    }

    for (const lane of ['worker', 'runtime'] as const) {
      byLane[lane].tickets = ticketSets[lane].size;
      byLane[lane].medianTimeToDoneMs = computeMedian(durations[lane]);
      byLane[lane].bounceRate = byLane[lane].ticketsDone > 0
        ? round4(bouncedTickets[lane] / byLane[lane].ticketsDone)
        : null;
      byLane[lane].costPerTicketUsd =
        byLane[lane].costTotalUsd != null && byLane[lane].tickets > 0
          ? round6(byLane[lane].costTotalUsd / byLane[lane].tickets)
          : null;
    }

    return {
      windowDays: days,
      generatedAt: new Date().toISOString(),
      worker,
      runtime,
    };
  } catch (e) {
    console.warn('[worker-scorecard] rollup failed:', e);
    return null;
  }
}
