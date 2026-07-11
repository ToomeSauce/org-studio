import type { TaskComment } from '@/lib/store';

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

function latestStatusModel(history: WorkerPipelineReceiptStatusEntry[]): string | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].model) return history[i].model;
  }
  return null;
}

export function assembleWorkerPipelineReceipt(
  task: WorkerPipelineReceiptInput,
  comments?: TaskComment[] | null,
): WorkerPipelineReceipt {
  const statusHistory = normalizeReceiptStatusHistory(task.statusHistory);
  const modelHistory = deriveModelHistory(statusHistory);
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
  };
}
