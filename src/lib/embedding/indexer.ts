/**
 * #1591 — Incremental indexer: keep the embedding store fresh ON WRITE.
 *
 * Event-driven (NOT a polling cron — #1591 constraint). After a successful
 * task/comment/vision write, the store route fires one of these helpers to
 * re-embed just the affected record. Idempotent (content_hash) so a no-op
 * edit costs nothing; INSERT/UPSERT-only.
 *
 * Best-effort by design: every entrypoint is wrapped so an indexing failure
 * (or a missing DATABASE_URL in file-mode dev) can NEVER break the write that
 * triggered it. Errors are logged, swallowed, and the write still succeeds.
 *
 * Source list (fixed for v1, #1591): vision docs, change-history (inside
 * vision content), task description, task comments, task reviewNotes,
 * status-history notes, blocked reasons. The extraction itself lives in the
 * pure corpus module (#1590); this file only routes single records to it.
 */
import { docsFromTask, docFromVision, type TaskLike, type VisionDocLike } from './corpus';
import { indexDocs } from './pipeline';

/** True when embeddings can run (Postgres-backed). File-mode dev → no-op. */
function embeddingsEnabled(): boolean {
  return !!process.env.DATABASE_URL;
}

/**
 * Re-index a single task after it was written. Embeds its description,
 * reviewNotes, blocked-reason, human comments, and noted status entries.
 * Fire-and-forget safe.
 */
export async function reindexTask(task: TaskLike): Promise<void> {
  if (!embeddingsEnabled() || !task?.id) return;
  try {
    const docs = docsFromTask(task);
    if (docs.length === 0) return;
    await indexDocs(docs);
  } catch (e: any) {
    console.warn(`[indexer #1591] reindexTask(${task?.id}) failed (non-fatal):`, e?.message || e);
  }
}

/** Re-index a single vision doc after a save. Fire-and-forget safe. */
export async function reindexVisionDoc(doc: VisionDocLike): Promise<void> {
  if (!embeddingsEnabled() || !doc?.projectId) return;
  try {
    const d = docFromVision(doc);
    if (!d) return;
    await indexDocs([d]);
  } catch (e: any) {
    console.warn(`[indexer #1591] reindexVisionDoc(${doc?.projectId}) failed (non-fatal):`, e?.message || e);
  }
}

/**
 * Fire-and-forget wrapper. Schedules the re-index without awaiting so the
 * triggering request returns immediately. The promise's rejection is already
 * handled inside reindex* (they swallow), but we attach a catch as a belt to
 * satisfy no-floating-promise lint and guard against unexpected throws.
 */
export function fireReindexTask(task: TaskLike): void {
  void reindexTask(task).catch(() => {});
}

export function fireReindexVisionDoc(doc: VisionDocLike): void {
  void reindexVisionDoc(doc).catch(() => {});
}
