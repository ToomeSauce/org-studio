import type { TaskComment } from '@/lib/store';
import { getStoreProvider } from '@/lib/store-provider';

export interface WorkerPipelineReceiptStatusEntry {
  status: string;
  timestamp: number | null;
  by: string | null;
  model: string | null;
}

export interface WorkerPipelineEvidenceLinks {
  workerRuns: string[];
  pullRequests: string[];
}

export interface WorkerPipelineModelTierSnapshot {
  requested: string | null;
  latestStatusModel: string | null;
}

export interface WorkerPipelineReceipt {
  ticketNumber: number | null;
  taskId: string | null;
  plannerSourceTaskId: string | null;
  parentId: string | null;
  roadmapItemId: string | null;
  projectId: string | null;
  version: string | null;
  statusHistory: WorkerPipelineReceiptStatusEntry[];
  statusPath: string[];
  modelHistory: string[];
  modelTierSnapshot: WorkerPipelineModelTierSnapshot;
  evidenceLinks: WorkerPipelineEvidenceLinks;
  attributions: WorkerPipelineReceiptAttribution[];
}

export interface WorkerPipelineReceiptInput {
  ticketNumber?: number | null;
  id?: string | null;
  plannerSourceTaskId?: string | null;
  parentId?: string | null;
  roadmapItemId?: string | null;
  projectId?: string | null;
  version?: string | null;
  modelTier?: string | null;
  reviewNotes?: string | null;
  statusHistory?: Array<{
    status?: string | null;
    timestamp?: number | string | null;
    by?: string | null;
    model?: string | null;
  }> | null;
}

export interface WorkerPipelineReceiptAttribution {
  dispatchId: string;
  dispatchedAt: number | null;
  calledAt: number | null;
  workerId: string | null;
  source: string | null;
  modelRequested: string | null;
  modelServed: string | null;
  modelUsed: string | null;
  costUsd: number | null;
}

type DispatchAttributionDbRow = {
  dispatch_id: string | null;
  dispatched_at: number | string | null;
  called_at: number | string | null;
  worker_id: string | null;
  source: string | null;
  model_requested: string | null;
  model_served: string | null;
  model_used: string | null;
  cost_estimate: number | string | null;
};

const URL_REGEX = /\bhttps?:\/\/[^\s<>"'`]+/gi;
let poolPromise: Promise<any> | null | undefined;

function asNullableString(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value.length > 0 ? value : null;
}

function asNullableNumber(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asNullableCost(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function normalizeStatus(raw: unknown): string | null {
  return asNullableString(raw)?.toLowerCase() ?? null;
}

function normalizeUrl(rawUrl: string): string | null {
  let candidate = rawUrl.trim();
  while (/[),.!?:;]+$/.test(candidate)) {
    candidate = candidate.slice(0, -1);
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.hash = '';
    if (parsed.hostname === 'github.com') {
      const segments = parsed.pathname.split('/');
      if (segments.length >= 4) {
        segments[1] = segments[1].toLowerCase();
        segments[2] = segments[2].toLowerCase();
      }
      parsed.pathname = segments.join('/');
    }
    if (parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function collectEvidenceText(reviewNotes: string | null | undefined, comments: TaskComment[] | null | undefined): string[] {
  const chunks: string[] = [];
  if (typeof reviewNotes === 'string' && reviewNotes.trim()) chunks.push(reviewNotes);
  for (const comment of comments || []) {
    if (comment?.content && comment.content.trim()) chunks.push(comment.content);
  }
  return chunks;
}

export function extractEvidenceLinks(
  reviewNotes: string | null | undefined,
  comments: TaskComment[] | null | undefined,
): WorkerPipelineEvidenceLinks {
  const workerRuns = new Set<string>();
  const pullRequests = new Set<string>();
  const text = collectEvidenceText(reviewNotes, comments).join('\n');
  const matches = text.match(URL_REGEX) || [];

  for (const rawUrl of matches) {
    const normalized = normalizeUrl(rawUrl);
    if (!normalized) continue;
    const parsed = new URL(normalized);
    if (/\/pull\/\d+$/i.test(parsed.pathname)) {
      pullRequests.add(normalized);
      continue;
    }
    if (/\/runs\/\d+$/i.test(parsed.pathname) || /[?&]run_id=\d+/i.test(parsed.search)) {
      workerRuns.add(normalized);
    }
  }

  return {
    workerRuns: [...workerRuns].sort((a, b) => a.localeCompare(b)),
    pullRequests: [...pullRequests].sort((a, b) => a.localeCompare(b)),
  };
}

export function normalizeReceiptStatusHistory(
  statusHistory: WorkerPipelineReceiptInput['statusHistory'],
): WorkerPipelineReceiptStatusEntry[] {
  const normalized: WorkerPipelineReceiptStatusEntry[] = [];
  for (const item of statusHistory || []) {
    const status = normalizeStatus(item?.status);
    if (!status) continue;
    normalized.push({
      status,
      timestamp: asNullableNumber(item?.timestamp),
      by: asNullableString(item?.by),
      model: asNullableString(item?.model),
    });
  }

  return normalized.sort((a, b) => {
    const ta = a.timestamp ?? Number.POSITIVE_INFINITY;
    const tb = b.timestamp ?? Number.POSITIVE_INFINITY;
    if (ta !== tb) return ta - tb;
    const sa = a.status.localeCompare(b.status);
    if (sa !== 0) return sa;
    const ba = (a.by || '').localeCompare(b.by || '');
    if (ba !== 0) return ba;
    return (a.model || '').localeCompare(b.model || '');
  });
}

function deriveStatusPath(history: WorkerPipelineReceiptStatusEntry[]): string[] {
  const path: string[] = [];
  for (const entry of history) {
    if (path[path.length - 1] !== entry.status) path.push(entry.status);
  }
  return path;
}

function deriveModelHistory(history: WorkerPipelineReceiptStatusEntry[]): string[] {
  const seen = new Set<string>();
  for (const entry of history) {
    if (entry.model) seen.add(entry.model);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

function deriveAttributionModelHistory(attributions: WorkerPipelineReceiptAttribution[]): string[] {
  const seen = new Set<string>();
  for (const entry of attributions) {
    if (entry.modelUsed) seen.add(entry.modelUsed);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

function latestStatusModel(history: WorkerPipelineReceiptStatusEntry[]): string | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].model) return history[i].model;
  }
  return null;
}

export function assembleWorkerPipelineReceipt(
  task: WorkerPipelineReceiptInput,
  comments?: TaskComment[] | null,
  attributions?: WorkerPipelineReceiptAttribution[] | null,
): WorkerPipelineReceipt {
  const statusHistory = normalizeReceiptStatusHistory(task.statusHistory);
  const statusModels = deriveModelHistory(statusHistory);
  const attributionModels = deriveAttributionModelHistory(attributions || []);
  const modelHistory = [...new Set([...statusModels, ...attributionModels])].sort((a, b) => a.localeCompare(b));
  const evidenceLinks = extractEvidenceLinks(task.reviewNotes, comments);

  return {
    ticketNumber: typeof task.ticketNumber === 'number' && Number.isFinite(task.ticketNumber) ? task.ticketNumber : null,
    taskId: asNullableString(task.id),
    plannerSourceTaskId: asNullableString(task.plannerSourceTaskId),
    parentId: asNullableString(task.parentId),
    roadmapItemId: asNullableString(task.roadmapItemId),
    projectId: asNullableString(task.projectId),
    version: asNullableString(task.version),
    statusHistory,
    statusPath: deriveStatusPath(statusHistory),
    modelHistory,
    modelTierSnapshot: {
      requested: asNullableString(task.modelTier),
      latestStatusModel: latestStatusModel(statusHistory),
    },
    evidenceLinks,
    attributions: (attributions || []).slice(),
  };
}

async function getPool(): Promise<any> {
  if (poolPromise !== undefined) return poolPromise;
  if (!process.env.DATABASE_URL) {
    poolPromise = null;
    return null;
  }
  poolPromise = (async () => {
    const { Pool } = await import('pg');
    return new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  })();
  return poolPromise;
}

function parseTicketNumber(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function foldDispatchAttributions(rows: DispatchAttributionDbRow[]): WorkerPipelineReceiptAttribution[] {
  const byDispatch = new Map<string, WorkerPipelineReceiptAttribution>();
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const dispatchId = asNullableString(row.dispatch_id) || `unkeyed-${i}`;
    const dispatchedAt = asNullableNumber(row.dispatched_at);
    const calledAt = asNullableNumber(row.called_at);
    const modelRequested = asNullableString(row.model_requested);
    const modelServed = asNullableString(row.model_served);
    const modelUsed = asNullableString(row.model_used) || modelServed || modelRequested;
    const nextCost = asNullableCost(row.cost_estimate);
    const existing = byDispatch.get(dispatchId);

    if (!existing) {
      byDispatch.set(dispatchId, {
        dispatchId,
        dispatchedAt,
        calledAt,
        workerId: asNullableString(row.worker_id),
        source: asNullableString(row.source),
        modelRequested,
        modelServed,
        modelUsed,
        costUsd: nextCost,
      });
      continue;
    }

    if (calledAt != null && (existing.calledAt == null || calledAt < existing.calledAt)) {
      existing.calledAt = calledAt;
      existing.modelRequested = modelRequested;
      existing.modelServed = modelServed;
      existing.modelUsed = modelUsed;
    } else if (!existing.modelUsed && modelUsed) {
      existing.modelRequested = modelRequested;
      existing.modelServed = modelServed;
      existing.modelUsed = modelUsed;
    }

    if (nextCost != null) {
      existing.costUsd = existing.costUsd == null ? nextCost : existing.costUsd + nextCost;
    }
  }

  return [...byDispatch.values()].sort((a, b) => {
    const da = a.dispatchedAt ?? Number.POSITIVE_INFINITY;
    const db = b.dispatchedAt ?? Number.POSITIVE_INFINITY;
    if (da !== db) return da - db;
    const ca = a.calledAt ?? Number.POSITIVE_INFINITY;
    const cb = b.calledAt ?? Number.POSITIVE_INFINITY;
    if (ca !== cb) return ca - cb;
    return a.dispatchId.localeCompare(b.dispatchId);
  });
}

async function loadDispatchAttributions(
  workspaceId: string,
  ticketNumber: number,
): Promise<WorkerPipelineReceiptAttribution[]> {
  try {
    const pool = await getPool();
    if (!pool) return [];
    const result = await pool.query(
      `SELECT
         l.dispatch_id,
         (EXTRACT(EPOCH FROM l.dispatched_at) * 1000)::bigint AS dispatched_at,
         (EXTRACT(EPOCH FROM mc.called_at) * 1000)::bigint AS called_at,
         l.agent_id AS worker_id,
         l.source,
         mc.model_requested,
         mc.model_served,
         COALESCE(mc.model_served, mc.model_requested) AS model_used,
         mc.cost_estimate
       FROM org_studio_dispatch_ledger l
       LEFT JOIN org_studio_dispatch_model_calls mc
         ON mc.dispatch_id = l.dispatch_id
         AND mc.workspace_id = $1
       WHERE l.workspace_id = $1
         AND l.ticket_fingerprint ~ '^[0-9]+:'
         AND NULLIF(split_part(split_part(l.ticket_fingerprint, ',', 1), ':', 1), '')::bigint = $2
       ORDER BY l.dispatched_at ASC, mc.called_at ASC`,
      [workspaceId, ticketNumber],
    );
    return foldDispatchAttributions((result.rows || []) as DispatchAttributionDbRow[]);
  } catch {
    // Fail-soft: receipt must still resolve from store/comment surfaces.
    return [];
  }
}

export async function getWorkerPipelineReceipt(
  workspaceId: string,
  ticketNumber: number,
): Promise<WorkerPipelineReceipt | null> {
  const parsedTicket = parseTicketNumber(ticketNumber);
  if (!workspaceId || parsedTicket == null) return null;

  const provider = getStoreProvider(workspaceId) as any;
  const store = await provider.read();
  const task = (store?.tasks || []).find((candidate: any) => parseTicketNumber(candidate?.ticketNumber) === parsedTicket);
  if (!task) return null;

  let comments: TaskComment[] = [];
  if (typeof provider.listComments === 'function' && task.id) {
    try {
      comments = await provider.listComments({ kind: 'task', taskId: task.id }, { limit: 200 });
    } catch {
      comments = Array.isArray(task.comments) ? task.comments : [];
    }
  } else {
    comments = Array.isArray(task.comments) ? task.comments : [];
  }

  const attributions = await loadDispatchAttributions(workspaceId, parsedTicket);
  return assembleWorkerPipelineReceipt(task, comments, attributions);
}

export function __setWorkerPipelineReceiptPoolForTest(pool: any): void {
  poolPromise = Promise.resolve(pool);
}

export function __resetWorkerPipelineReceiptForTest(): void {
  poolPromise = undefined;
}
