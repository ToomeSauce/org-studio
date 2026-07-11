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
  attribution: WorkerPipelineReceiptAttribution;
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
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  modelHistory: string[];
}

type AttributionRow = {
  model_used: string | null;
  tokens_in: number | string | null;
  tokens_out: number | string | null;
  cache_read_tokens: number | string | null;
  cache_write_tokens: number | string | null;
  cost_estimate: number | string | null;
};

type QueryResult = { rows?: unknown[] };
type QueryablePool = {
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>;
};

type CommentScope = { kind: string; taskId?: string; sectionId?: string; boardProjectId?: string; dmThreadId?: string };
type ListCommentsOptions = { limit?: number; before?: number };

type TaskRecord = WorkerPipelineReceiptInput & {
  comments?: TaskComment[] | null;
};

type StoreProviderLike = {
  read: () => Promise<{ tasks?: TaskRecord[] }>;
  listComments?: (scope: CommentScope, opts?: ListCommentsOptions) => Promise<unknown[]>;
};

const URL_REGEX = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const RECEIPT_COMMENT_LIMIT = 200;

let _pool: QueryablePool | null | undefined = undefined;

const emptyAttribution = (): WorkerPipelineReceiptAttribution => ({
  tokensIn: 0,
  tokensOut: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  modelHistory: [],
});

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

async function getPool(): Promise<QueryablePool | null> {
  if (_pool !== undefined) return _pool;
  if (!process.env.DATABASE_URL) {
    _pool = null;
    return null;
  }
  try {
    const pg = await import('pg');
    const Pool = (pg as { default?: { Pool?: new (config: { connectionString: string; max: number }) => QueryablePool }; Pool?: new (config: { connectionString: string; max: number }) => QueryablePool }).default?.Pool
      || (pg as { Pool?: new (config: { connectionString: string; max: number }) => QueryablePool }).Pool;
    if (!Pool) {
      _pool = null;
      return null;
    }
    _pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    return _pool;
  } catch {
    _pool = null;
    return null;
  }
}

export function __setPoolForTest(pool: QueryablePool | null): void {
  _pool = pool;
}

export function __resetForTest(): void {
  _pool = undefined;
}

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

function asFiniteNumber(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
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
  return [...seen];
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
  attribution?: WorkerPipelineReceiptAttribution | null,
): WorkerPipelineReceipt {
  const statusHistory = normalizeReceiptStatusHistory(task.statusHistory);
  const statusModelHistory = deriveModelHistory(statusHistory);
  const attr = attribution || emptyAttribution();
  const modelHistory = [...attr.modelHistory];
  for (const model of statusModelHistory) {
    if (!modelHistory.includes(model)) modelHistory.push(model);
  }
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
    attribution: attr,
  };
}

function parseTicketNumber(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function sumAttributionRows(rows: AttributionRow[] | null | undefined): WorkerPipelineReceiptAttribution {
  if (!rows?.length) return emptyAttribution();

  let tokensIn = 0;
  let tokensOut = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costTotal = 0;
  const models = new Set<string>();

  for (const row of rows) {
    tokensIn += asFiniteNumber(row.tokens_in) ?? 0;
    tokensOut += asFiniteNumber(row.tokens_out) ?? 0;
    cacheReadTokens += asFiniteNumber(row.cache_read_tokens) ?? 0;
    cacheWriteTokens += asFiniteNumber(row.cache_write_tokens) ?? 0;
    const cost = asFiniteNumber(row.cost_estimate);
    if (cost != null) costTotal += cost;
    const model = asNullableString(row.model_used);
    if (model) models.add(model);
  }

  return {
    tokensIn,
    tokensOut,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd: round6(costTotal),
    modelHistory: [...models],
  };
}

async function listTaskComments(
  provider: Pick<StoreProviderLike, 'listComments'>,
  taskId: string,
  fallbackComments: TaskComment[] | null | undefined,
): Promise<TaskComment[]> {
  try {
    if (typeof provider?.listComments === 'function') {
      const comments = await provider.listComments({ kind: 'task', taskId }, { limit: RECEIPT_COMMENT_LIMIT });
      if (Array.isArray(comments)) return comments as TaskComment[];
    }
  } catch {
    // Fail-soft: keep receipt path working even when comments table/provider call fails.
  }
  return Array.isArray(fallbackComments) ? fallbackComments : [];
}

async function fetchAttribution(workspaceId: string, ticketNumber: number): Promise<WorkerPipelineReceiptAttribution> {
  const pool = await getPool();
  if (!pool) return emptyAttribution();

  try {
    const result = await pool.query(
      `SELECT
         COALESCE(mc.model_served, mc.model_requested) AS model_used,
         mc.tokens_in,
         mc.tokens_out,
         mc.cache_read_tokens,
         mc.cache_write_tokens,
         mc.cost_estimate
       FROM org_studio_dispatch_ledger l
       LEFT JOIN org_studio_dispatch_model_calls mc
         ON mc.dispatch_id = l.dispatch_id
        AND mc.workspace_id = $1
       WHERE l.workspace_id = $1
         AND l.ticket_fingerprint ~ '^[0-9]+:'
         AND NULLIF(split_part(split_part(l.ticket_fingerprint, ',', 1), ':', 1), '')::bigint = $2::bigint
       ORDER BY l.dispatched_at ASC, mc.called_at ASC, l.dispatch_id ASC`,
      [workspaceId, ticketNumber],
    );
    return sumAttributionRows((result?.rows || []) as AttributionRow[]);
  } catch (error: unknown) {
    if (typeof error === 'object' && error && 'code' in error && (error as { code?: string }).code === '42P01') {
      return emptyAttribution();
    }
    return emptyAttribution();
  }
}

export async function getWorkerPipelineReceipt(
  workspaceId: string,
  ticketNumber: number,
): Promise<WorkerPipelineReceipt | null> {
  const ticket = parseTicketNumber(ticketNumber);
  if (!workspaceId || ticket == null) return null;

  const provider = getStoreProvider(workspaceId) as StoreProviderLike;
  const store = await provider.read();
  const task = (store?.tasks || []).find((entry) => parseTicketNumber(entry?.ticketNumber) === ticket);
  if (!task) return null;

  const comments = await listTaskComments(provider, String(task.id || ''), task.comments);
  const attribution = await fetchAttribution(workspaceId, ticket);
  return assembleWorkerPipelineReceipt(task, comments, attribution);
}
