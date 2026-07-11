/**
 * Worker lane vs runtime lane scorecard (#1661, W-6).
 *
 * Read-only rollup over dispatch ledger/model-call tables + task status_history.
 * Returns null when Postgres is unavailable (same fail-open shape as budget-spend).
 */

import { MODEL_TIERS, type ModelTier } from '@/lib/model-tier';
import { getWorkerConfigs } from '@/lib/workers/config';

type LaneKey = 'worker' | 'runtime';

type StatusHistoryEntry = {
  status?: string | null;
  timestamp?: number | string | null;
  by?: string | null;
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
  tierModel: TierModelMetrics[];
  recommendations: TierRecommendation[];
  recommendationPolicy: TierRecommendationPolicy;
}

export interface TierAttemptInput {
  ticketNumber: number | string;
  dispatchId: string | null;
  workerId: string | null;
  model: string | null;
  costUsd: number | string | null;
  dispatchedAt: number | string;
  calledAt?: number | string | null;
}

export interface TierTaskInput {
  ticketNumber: number | string;
  modelTier: string | null;
  status: string | null;
  statusHistory: StatusHistoryEntry[] | string | null;
}

type TierAttemptDbRow = {
  ticket_number: number | string;
  dispatch_id: string | null;
  worker_id: string | null;
  model: string | null;
  cost_estimate: number | string | null;
  dispatched_at: number | string;
  called_at: number | string | null;
};

type TierTaskDbRow = {
  ticket_number: number | string;
  model_tier: string | null;
  status: string | null;
  status_history: StatusHistoryEntry[] | string | null;
};

export interface TierModelWorker {
  id: string;
  model: string;
  tiers: ModelTier[];
}

export interface TierModelMetrics {
  tier: ModelTier;
  /** Model used for the ticket's first worker attempt (the routing decision under evaluation). */
  model: string;
  workerIds: string[];
  tickets: number;
  ticketsDone: number;
  firstPassTickets: number;
  firstPassRate: number | null;
  bounceCount: number;
  attemptsToDone: number | null;
  costTotalUsd: number | null;
  costPerDoneTicketUsd: number | null;
}

export interface TierRecommendationPolicy {
  minTickets: number;
  firstPassThreshold: number;
}

export interface TierRecommendation {
  tier: ModelTier;
  model: string;
  nextModel: string;
  nextWorkerId: string;
  tickets: number;
  firstPassRate: number;
  message: string;
}

export const DEFAULT_TIER_RECOMMENDATION_POLICY: TierRecommendationPolicy = {
  minTickets: 5,
  firstPassThreshold: 0.6,
};

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
  // Matches both the agentId form ('worker-codex') and the scaffolded
  // teammate display-name form ('Worker (Codex)').
  return /^worker[-\s(]/.test(who) ? 'worker' : 'runtime';
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

function lastDoneBy(history: StatusHistoryEntry[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    if (normalizeStatus(history[i]?.status) === 'done') {
      return typeof history[i]?.by === 'string' ? history[i].by!.trim() : null;
    }
  }
  return null;
}

function normalizeWorkerIdentity(raw: unknown): string {
  return typeof raw === 'string' ? raw.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
}

function asModelTier(raw: unknown): ModelTier | null {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return (MODEL_TIERS as readonly string[]).includes(value) ? (value as ModelTier) : null;
}

function numericCost(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

type FoldedAttempt = {
  dispatchId: string;
  workerId: string;
  model: string | null;
  dispatchedAt: number;
  calledAt: number;
  costUsd: number;
  fullyMetered: boolean;
};

type MutableTierModelMetrics = TierModelMetrics & {
  attemptsToDoneTotal: number;
  workerIdSet: Set<string>;
  costComplete: boolean;
};

/**
 * Advisory v1 scorecard contract. A ticket belongs to the cell for its FIRST
 * worker model: that is the routing decision we are evaluating. Retries on a
 * stronger model remain charged to the original cell, so first-pass and cost
 * expose the true consequence of the cheap-model choice instead of making the
 * retry look like an unrelated success.
 */
export function computeTierModelScorecard(
  attemptRows: TierAttemptInput[],
  taskRows: TierTaskInput[],
  workers: TierModelWorker[],
  policy: TierRecommendationPolicy = DEFAULT_TIER_RECOMMENDATION_POLICY,
): { tierModel: TierModelMetrics[]; recommendations: TierRecommendation[] } {
  const workerModels = new Map(workers.map((worker) => [worker.id.toLowerCase(), worker.model]));
  const attemptsByTicket = new Map<number, TierAttemptInput[]>();
  for (const row of attemptRows) {
    const ticket = parseTicketNumber(row.ticketNumber);
    if (ticket == null) continue;
    const list = attemptsByTicket.get(ticket) || [];
    list.push(row);
    attemptsByTicket.set(ticket, list);
  }

  const groups = new Map<string, MutableTierModelMetrics>();

  for (const task of taskRows) {
    const ticket = parseTicketNumber(task.ticketNumber);
    const tier = asModelTier(task.modelTier);
    if (ticket == null || !tier) continue;

    const rawAttempts = attemptsByTicket.get(ticket) || [];
    const foldedByDispatch = new Map<string, FoldedAttempt>();
    for (let index = 0; index < rawAttempts.length; index++) {
      const row = rawAttempts[index];
      const dispatchedAt = toTimestampMs(row.dispatchedAt);
      if (dispatchedAt == null) continue;
      const dispatchId = row.dispatchId || `unkeyed-${ticket}-${index}`;
      const calledAt = toTimestampMs(row.calledAt) ?? dispatchedAt;
      const cost = numericCost(row.costUsd);
      const existing = foldedByDispatch.get(dispatchId);
      if (!existing) {
        foldedByDispatch.set(dispatchId, {
          dispatchId,
          workerId: row.workerId || '',
          model: row.model || null,
          dispatchedAt,
          calledAt,
          costUsd: cost ?? 0,
          fullyMetered: cost != null,
        });
      } else {
        if ((!existing.model || calledAt < existing.calledAt) && row.model) {
          existing.model = row.model;
          existing.calledAt = calledAt;
        }
        if (!existing.workerId && row.workerId) existing.workerId = row.workerId;
        if (cost != null) {
          existing.costUsd += cost;
        } else {
          existing.fullyMetered = false;
        }
      }
    }

    const history = parseStatusHistory(task.statusHistory);
    const doneAt = normalizeStatus(task.status) === 'done'
      ? lastTimestampForStatus(history, 'done')
      : null;
    const attempts = [...foldedByDispatch.values()]
      .filter((attempt) => doneAt == null || attempt.dispatchedAt <= doneAt)
      .sort((a, b) => a.dispatchedAt - b.dispatchedAt || a.calledAt - b.calledAt);
    if (attempts.length === 0) continue;

    const first = attempts[0];
    const model = first.model || workerModels.get(first.workerId.toLowerCase()) || '(unreported)';
    const key = `${tier}\u0000${model}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        tier,
        model,
        workerIds: [],
        tickets: 0,
        ticketsDone: 0,
        firstPassTickets: 0,
        firstPassRate: null,
        bounceCount: 0,
        attemptsToDone: null,
        costTotalUsd: null,
        costPerDoneTicketUsd: null,
        attemptsToDoneTotal: 0,
        workerIdSet: new Set<string>(),
        costComplete: true,
      };
      groups.set(key, group);
    }

    group.tickets += 1;
    if (first.workerId) group.workerIdSet.add(first.workerId);
    if (doneAt == null) continue;

    const bounces = countBounces(history);
    const completedByInitialWorker =
      normalizeWorkerIdentity(lastDoneBy(history)) === normalizeWorkerIdentity(first.workerId);
    group.ticketsDone += 1;
    group.bounceCount += bounces;
    group.attemptsToDoneTotal += attempts.length;
    if (attempts.length === 1 && bounces === 0 && completedByInitialWorker) {
      group.firstPassTickets += 1;
    }
    for (const attempt of attempts) {
      group.costTotalUsd = (group.costTotalUsd ?? 0) + attempt.costUsd;
      if (!attempt.fullyMetered) group.costComplete = false;
    }
  }

  const tierOrder = new Map(MODEL_TIERS.map((tier, index) => [tier, index]));
  const tierModel = [...groups.values()]
    .map((group): TierModelMetrics => ({
      tier: group.tier,
      model: group.model,
      workerIds: [...group.workerIdSet].sort(),
      tickets: group.tickets,
      ticketsDone: group.ticketsDone,
      firstPassTickets: group.firstPassTickets,
      firstPassRate: group.ticketsDone > 0
        ? round4(group.firstPassTickets / group.ticketsDone)
        : null,
      bounceCount: group.bounceCount,
      attemptsToDone: group.ticketsDone > 0
        ? round4(group.attemptsToDoneTotal / group.ticketsDone)
        : null,
      costTotalUsd: group.costComplete && group.ticketsDone > 0
        ? round6(group.costTotalUsd ?? 0)
        : null,
      costPerDoneTicketUsd: group.costComplete && group.ticketsDone > 0
        ? round6((group.costTotalUsd ?? 0) / group.ticketsDone)
        : null,
    }))
    .sort((a, b) =>
      (tierOrder.get(a.tier) ?? 99) - (tierOrder.get(b.tier) ?? 99) ||
      a.model.localeCompare(b.model),
    );

  return {
    tierModel,
    recommendations: computeTierRecommendations(tierModel, workers, policy),
  };
}

export function computeTierRecommendations(
  tierModel: TierModelMetrics[],
  workers: TierModelWorker[],
  policy: TierRecommendationPolicy = DEFAULT_TIER_RECOMMENDATION_POLICY,
): TierRecommendation[] {
  const recommendations: TierRecommendation[] = [];
  for (const cell of tierModel) {
    if (
      cell.ticketsDone < policy.minTickets ||
      cell.firstPassRate == null ||
      cell.firstPassRate >= policy.firstPassThreshold
    ) continue;

    const currentIndex = workers.findIndex((worker) =>
      cell.workerIds.some((id) => id.toLowerCase() === worker.id.toLowerCase()) ||
      worker.model === cell.model,
    );
    if (currentIndex < 0) continue;
    const next = workers
      .slice(currentIndex + 1)
      .find((worker) => worker.tiers.includes(cell.tier) && worker.model !== cell.model);
    if (!next) continue; // already the strongest configured option for this tier

    const pct = Math.round(cell.firstPassRate * 100);
    recommendations.push({
      tier: cell.tier,
      model: cell.model,
      nextModel: next.model,
      nextWorkerId: next.id,
      tickets: cell.ticketsDone,
      firstPassRate: cell.firstPassRate,
      message:
        `${cell.tier} on ${cell.model} is ${pct}% first-pass over ${cell.ticketsDone} done tickets; ` +
        `consider moving the tier to ${next.model} (${next.id}).`,
    });
  }
  return recommendations;
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

    const [dispatchRes, costRes, attributedTicketRes, taskRes, tierAttemptRes] = await Promise.all([
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
        `SELECT ticket_number, assignee, status, status_history, data->>'modelTier' AS model_tier
         FROM org_studio_tasks
         WHERE workspace_id = $1
           AND (data->>'isArchived')::boolean IS DISTINCT FROM TRUE
           AND status_history IS NOT NULL`,
        [workspaceId],
      ),
      pool.query(
        `SELECT
           NULLIF(split_part(split_part(l.ticket_fingerprint, ',', 1), ':', 1), '')::bigint AS ticket_number,
           l.dispatch_id,
           l.agent_id AS worker_id,
           COALESCE(mc.model_served, mc.model_requested) AS model,
           mc.cost_estimate,
           (EXTRACT(EPOCH FROM l.dispatched_at) * 1000)::bigint AS dispatched_at,
           (EXTRACT(EPOCH FROM mc.called_at) * 1000)::bigint AS called_at
         FROM org_studio_dispatch_ledger l
         LEFT JOIN org_studio_dispatch_model_calls mc
           ON mc.dispatch_id = l.dispatch_id AND mc.workspace_id = $1
         WHERE l.workspace_id = $1
           AND l.dispatched_at >= ${since}
           AND l.outcome = 'enqueued'
           AND l.ticket_fingerprint ~ '^[0-9]+:'
           AND (
             lower(COALESCE(l.source, '')) = 'worker'
             OR lower(COALESCE(l.agent_id, '')) LIKE 'worker-%'
           )
         ORDER BY l.dispatched_at, mc.called_at`,
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

    const configuredWorkers: TierModelWorker[] = getWorkerConfigs().map((configured) => ({
      id: configured.id,
      model: configured.model,
      tiers: configured.tiers,
    }));
    const tierAttemptRows = (tierAttemptRes.rows || []) as TierAttemptDbRow[];
    const tierTaskRows = (taskRes.rows || []) as TierTaskDbRow[];
    const tierScorecard = computeTierModelScorecard(
      tierAttemptRows.map((row): TierAttemptInput => ({
        ticketNumber: row.ticket_number,
        dispatchId: row.dispatch_id,
        workerId: row.worker_id,
        model: row.model,
        costUsd: row.cost_estimate,
        dispatchedAt: row.dispatched_at,
        calledAt: row.called_at,
      })),
      tierTaskRows.map((row): TierTaskInput => ({
        ticketNumber: row.ticket_number,
        modelTier: row.model_tier,
        status: row.status,
        statusHistory: row.status_history,
      })),
      configuredWorkers,
    );

    return {
      windowDays: days,
      generatedAt: new Date().toISOString(),
      worker,
      runtime,
      tierModel: tierScorecard.tierModel,
      recommendations: tierScorecard.recommendations,
      recommendationPolicy: DEFAULT_TIER_RECOMMENDATION_POLICY,
    };
  } catch (e) {
    console.warn('[worker-scorecard] rollup failed:', e);
    return null;
  }
}
