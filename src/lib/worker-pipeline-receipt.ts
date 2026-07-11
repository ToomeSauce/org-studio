import type { TaskComment } from '@/lib/store';
import { getStoreProvider } from '@/lib/store-provider';
import type { StoreProvider } from '@/lib/store-provider';

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

type ModelCallAttributionRow = {
  model_served: string | null;
  tokens_in: number | string | null;
  tokens_out: number | string | null;
  cache_read_tokens: number | string | null;
  cache_write_tokens: number | string | null;
  cost_estimate: number | string | null;
};

const EMPTY_ATTRIBUTION: WorkerPipelineReceiptAttribution = {
  tokensIn: 0,
  tokensOut: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  modelHistory: [],
};

type QueryResult = { rows?: unknown[] };
type QueryPool = { query: (text: string, values?: unknown[]) => Promise<QueryResult> };
type PgLikeModule = { Pool?: new (opts: { connectionString: string; max: number }) => QueryPool; default?: { Pool?: new (opts: { connectionString: string; max: number }) => QueryPool } };
type TaskShape = WorkerPipelineReceiptInput & { comments?: TaskComment[] | null };
type ReceiptStoreSnapshot = { tasks?: TaskShape[] };
type ReceiptStoreProvider = Pick<StoreProvider, 'read'> & {
  listComments?: (scope: { kind: string; taskId?: string }, opts?: { limit?: number; before?: number }) => Promise<TaskComment[]>;
};

let _pool: QueryPool | null | undefined = undefined;
const _loggedErrors = new Set<string>();
let _storeProviderGetter: (workspaceId: string) => ReceiptStoreProvider = getStoreProvider;

function logOnce(key: string, msg: string, err?: unknown): void {
  if (_loggedErrors.has(key)) return;
  _loggedErrors.add(key);
  const maybe = err as { message?: string } | undefined;
  console.error(`[WorkerPipelineReceipt] ${msg}`, maybe?.message || err || '');
}

export function __setPoolForTest(pool: QueryPool | null): void {
  _pool = pool;
}

export function __setStoreProviderGetterForTest(fn: (workspaceId: string) => ReceiptStoreProvider): void {
  _storeProviderGetter = fn;
}

export function __resetForTest(): void {
  _pool = undefined;
  _loggedErrors.clear();
  _storeProviderGetter = getStoreProvider;
}

const URL_REGEX = /\bhttps?:\/\/[^\s<>"'`]+/gi;

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

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

function asNumberOrZero(raw: unknown): number {
  if (raw == null || raw === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

async function getPool(): Promise<QueryPool | null> {
  if (_pool !== undefined) return _pool;
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    _pool = null;
    return null;
  }
  try {
    const pg = await import('pg') as PgLikeModule;
    const Pool = pg.default?.Pool || pg.Pool;
    if (!Pool) throw new Error('pg Pool not available');
    _pool = new Pool({ connectionString: dbUrl, max: 2 });
    return _pool;
  } catch (e: unknown) {
    logOnce('pool', 'Failed to create pool:', e);
    _pool = null;
    return null;
  }
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
  const attributionModelHistory = attribution?.modelHistory || [];
  const modelHistory = [...new Set([...statusModelHistory, ...attributionModelHistory])];
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
    attribution: attribution || { ...EMPTY_ATTRIBUTION },
  };
}

function isTask(value: unknown): value is TaskShape {
  return !!value && typeof value === 'object';
}

function pgCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

async function listTaskComments(provider: ReceiptStoreProvider, task: TaskShape): Promise<TaskComment[]> {
  try {
    if (typeof provider?.listComments === 'function' && task?.id) {
      const comments = await provider.listComments({ kind: 'task', taskId: task.id }, { limit: 200 });
      if (Array.isArray(comments)) return comments as TaskComment[];
    }
  } catch (e: unknown) {
    logOnce('comments', `listComments failed for task ${task?.id}; falling back to inline comments`, e);
  }
  return Array.isArray(task?.comments) ? (task.comments as TaskComment[]) : [];
}

async function getTicketAttribution(workspaceId: string, ticketNumber: number): Promise<WorkerPipelineReceiptAttribution> {
  try {
    const pool = await getPool();
    if (!pool) return { ...EMPTY_ATTRIBUTION };
    const res = await pool.query(
      `SELECT
         mc.model_served,
         mc.tokens_in,
         mc.tokens_out,
         mc.cache_read_tokens,
         mc.cache_write_tokens,
         mc.cost_estimate
       FROM org_studio_dispatch_model_calls mc
       JOIN org_studio_dispatch_ledger l
         ON l.dispatch_id = mc.dispatch_id
       WHERE mc.workspace_id = $1
         AND l.workspace_id = $1
         AND l.ticket_fingerprint ~ '^[0-9]+:'
         AND NULLIF(split_part(split_part(l.ticket_fingerprint, ',', 1), ':', 1), '')::bigint = $2
       ORDER BY mc.called_at ASC, mc.dispatch_id ASC, mc.id ASC`,
      [workspaceId, ticketNumber],
    );
    const rows = Array.isArray(res?.rows) ? (res.rows as ModelCallAttributionRow[]) : [];
    if (rows.length === 0) return { ...EMPTY_ATTRIBUTION };

    let tokensIn = 0;
    let tokensOut = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let costUsd = 0;
    const models = new Set<string>();

    for (const row of rows) {
      tokensIn += asNumberOrZero(row.tokens_in);
      tokensOut += asNumberOrZero(row.tokens_out);
      cacheReadTokens += asNumberOrZero(row.cache_read_tokens);
      cacheWriteTokens += asNumberOrZero(row.cache_write_tokens);
      costUsd += asNumberOrZero(row.cost_estimate);
      const model = asNullableString(row.model_served);
      if (model) models.add(model);
    }

    return {
      tokensIn,
      tokensOut,
      cacheReadTokens,
      cacheWriteTokens,
      costUsd: round6(costUsd),
      modelHistory: [...models],
    };
  } catch (e: unknown) {
    if (pgCode(e) !== '42P01') {
      logOnce('attribution', `attribution query failed for ${workspaceId}#${ticketNumber}`, e);
    }
    return { ...EMPTY_ATTRIBUTION };
  }
}

export async function getWorkerPipelineReceipt(
  workspaceId: string,
  ticketNumber: number,
): Promise<WorkerPipelineReceipt | null> {
  if (!workspaceId || !Number.isFinite(ticketNumber)) return null;

  const provider = _storeProviderGetter(workspaceId);
  const store = await provider.read();
  const snapshot = store as ReceiptStoreSnapshot;
  const task = (snapshot.tasks || []).find((candidate: unknown) => {
    if (!isTask(candidate)) return false;
    const n = typeof candidate?.ticketNumber === 'number'
      ? candidate.ticketNumber
      : parseInt(String(candidate?.ticketNumber || ''), 10);
    return Number.isFinite(n) && n === ticketNumber;
  });
  if (!task) return null;

  const [comments, attribution] = await Promise.all([
    listTaskComments(provider, task),
    getTicketAttribution(workspaceId, ticketNumber),
  ]);

  return assembleWorkerPipelineReceipt(task, comments, attribution);
}
