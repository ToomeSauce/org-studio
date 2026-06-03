/**
 * #1590/#1591 — Corpus extraction: turn Org Studio records into embeddable
 * documents with STABLE ids + content hashes.
 *
 * The content hash is the idempotency key: re-indexing only re-embeds rows
 * whose text changed. Ids are deterministic so re-runs UPSERT the same row
 * rather than duplicating (#1590 constraint: idempotent, INSERT/UPSERT-only).
 *
 * Pure module: no IO. The indexer (#1591) feeds it records read from the
 * store; this file only transforms them.
 */

/** Source kinds we embed. Fixed for v1 (#1591 constraint). */
export type CorpusSourceType =
  | 'vision-doc'
  | 'change-history'
  | 'task-description'
  | 'task-comment'
  | 'task-review-notes'
  | 'status-history'
  | 'blocked-reason';

export interface CorpusDoc {
  /** Stable, deterministic id: `${sourceType}:${refId}`. UPSERT key. */
  id: string;
  sourceType: CorpusSourceType;
  /** The underlying record id (task id, version string, comment id, …). */
  refId: string;
  /** Optional scoping for search filters + citation links. */
  projectId?: string;
  taskId?: string;
  ticketNumber?: number;
  owner?: string;
  /** Human title for citations. */
  title?: string;
  /** The text to embed. */
  text: string;
  /** Stable content hash (idempotency). */
  contentHash: string;
}

/** FNV-1a 32-bit hex hash of a string. Deterministic; good enough for change-detection. */
export function contentHash(text: string): string {
  let h = 0x811c9dc5;
  const s = text || '';
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function mk(
  sourceType: CorpusSourceType,
  refId: string,
  text: string,
  extra: Partial<CorpusDoc> = {},
): CorpusDoc | null {
  const t = (text || '').trim();
  if (t.length === 0) return null; // never embed empty text
  return {
    id: `${sourceType}:${refId}`,
    sourceType,
    refId,
    text: t,
    contentHash: contentHash(t),
    ...extra,
  };
}

/** Minimal shapes (structural — avoids importing the heavy store types). */
export interface TaskLike {
  id: string;
  ticketNumber?: number;
  projectId?: string;
  title?: string;
  description?: string;
  reviewNotes?: string;
  blockedReasonType?: string;
  blockedReason?: string;
  assignee?: string;
  comments?: Array<{ id?: string; author?: string; content?: string; type?: string; createdAt?: number }>;
  statusHistory?: Array<{ status?: string; by?: string; timestamp?: number; note?: string }>;
}

export interface VisionDocLike {
  projectId: string;
  title?: string;
  content?: string;
}

export interface ChangeHistoryLike {
  projectId?: string;
  version?: string;
  title?: string;
  text?: string;
}

/** Extract all embeddable docs from one task. Skips empty fields. */
export function docsFromTask(task: TaskLike): CorpusDoc[] {
  const out: CorpusDoc[] = [];
  const base = {
    projectId: task.projectId,
    taskId: task.id,
    ticketNumber: task.ticketNumber,
    owner: task.assignee,
    title: task.title,
  };
  const desc = mk('task-description', task.id, [task.title, task.description].filter(Boolean).join('\n'), base);
  if (desc) out.push(desc);

  const rn = mk('task-review-notes', task.id, task.reviewNotes || '', base);
  if (rn) out.push(rn);

  // Blocked reason (#1588 field): embed the reason + its type for precedent recall.
  const blocked = mk(
    'blocked-reason',
    task.id,
    [task.blockedReasonType, task.blockedReason].filter(Boolean).join(': '),
    base,
  );
  if (blocked) out.push(blocked);

  for (const c of task.comments || []) {
    if (c.type === 'system') continue; // skip auto-generated noise
    const cid = c.id || `${task.id}-c${contentHash(c.content || '')}`;
    const doc = mk('task-comment', cid, c.content || '', { ...base, refId: cid });
    if (doc) out.push(doc);
  }

  // Status-history: embed only entries carrying a human note (status flips alone
  // are not decision-bearing text).
  for (const sh of task.statusHistory || []) {
    if (!sh.note || !sh.note.trim()) continue;
    const sid = `${task.id}-sh${sh.timestamp || contentHash(sh.note)}`;
    const doc = mk('status-history', sid, sh.note, { ...base, refId: sid });
    if (doc) out.push(doc);
  }
  return out;
}

export function docFromVision(v: VisionDocLike): CorpusDoc | null {
  return mk('vision-doc', v.projectId, [v.title, v.content].filter(Boolean).join('\n'), {
    projectId: v.projectId,
    title: v.title || 'Vision',
  });
}

export function docFromChangeHistory(ch: ChangeHistoryLike): CorpusDoc | null {
  const ref = `${ch.projectId || 'p'}:${ch.version || contentHash(ch.text || '')}`;
  return mk('change-history', ref, [ch.title, ch.text].filter(Boolean).join('\n'), {
    projectId: ch.projectId,
    title: ch.title || `Change ${ch.version || ''}`.trim(),
  });
}

/** Build the full corpus from store records. Pure. */
export function buildCorpus(args: {
  tasks?: TaskLike[];
  visionDocs?: VisionDocLike[];
  changeHistory?: ChangeHistoryLike[];
}): CorpusDoc[] {
  const out: CorpusDoc[] = [];
  for (const t of args.tasks || []) out.push(...docsFromTask(t));
  for (const v of args.visionDocs || []) { const d = docFromVision(v); if (d) out.push(d); }
  for (const c of args.changeHistory || []) { const d = docFromChangeHistory(c); if (d) out.push(d); }
  return out;
}
