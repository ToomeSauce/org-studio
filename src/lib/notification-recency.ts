/**
 * #1513 — Recency tracker helper for the notification router.
 *
 * Walks a task's comment history and produces a map of
 *   agentId -> latest comment createdAt (ms since epoch)
 * for each AGENT author who has commented on the task.
 *
 * Consumed by:
 *   - /api/notify/comment/route.ts (bridge) — passes the map into
 *     routeCommentNotifications() via context.recipientLastReplies.
 *
 * Used by:
 *   - routeCommentNotifications() in notification-router.ts — suppresses
 *     deliveries whose source comment is OLDER than the recipient's most
 *     recent reply on the same task ("stale-superseded").
 *
 * Resolution rules:
 *   - Skip the source comment itself (we're notifying about it, not about
 *     its author's prior replies).
 *   - Skip 'system' comments — auto-generated, never count as a "reply".
 *   - Resolve comment.author (string) to a teammate via name/agentId/id
 *     (case-insensitive). Skip authors that don't resolve.
 *   - Skip humans and authors with no agentId — the router doesn't page
 *     them, so suppression is moot.
 *
 * Returns undefined when nothing usable was found, so the router cleanly
 * falls through to existing behavior (no suppression).
 */

export interface RecencyTeammate {
  id?: string;
  name?: string;
  agentId?: string;
  isHuman?: boolean;
}

export interface RecencyComment {
  id?: string;
  author?: string;
  type?: string;
  createdAt?: number;
}

export interface RecencyTask {
  comments?: RecencyComment[];
}

/**
 * Compute the latest non-system comment timestamp per agent author.
 *
 * #1524 — prefer the explicit `comments` argument (fetched via
 * `listComments` / `listCommentsForTasks`). Falls back to `task.comments[]`
 * for legacy callers and the file-provider mode; this fallback goes away
 * with Phase 3 (#1295) when the inline column is dropped.
 */
export function computeRecipientLastReplies(
  task: RecencyTask | null | undefined,
  teammates: RecencyTeammate[],
  sourceComment: RecencyComment | null | undefined,
  comments?: RecencyComment[],
): Map<string, number> | undefined {
  const list = comments ?? (task && Array.isArray(task.comments) ? task.comments : undefined);
  if (!list || list.length === 0) {
    return undefined;
  }
  const map = new Map<string, number>();
  for (const c of list) {
    if (!c || c.id === sourceComment?.id) continue;
    if (c.type === 'system') continue;
    const createdAt = typeof c.createdAt === 'number' ? c.createdAt : 0;
    if (createdAt <= 0) continue;
    const authorLower = String(c.author || '').toLowerCase();
    if (!authorLower) continue;
    const tm = teammates.find((t) =>
      t.name?.toLowerCase() === authorLower ||
      t.agentId?.toLowerCase() === authorLower ||
      t.id?.toLowerCase() === authorLower
    );
    if (!tm || tm.isHuman || !tm.agentId) continue;
    const existing = map.get(tm.agentId) || 0;
    if (createdAt > existing) map.set(tm.agentId, createdAt);
  }
  return map.size > 0 ? map : undefined;
}
