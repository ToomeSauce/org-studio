/**
 * Vision Inbox — P0 aggregation logic (pure, no I/O).
 *
 * The IA primitive: a "vision" is a Project. Its Inbox is one chronological
 * feed merging every comment across all of that vision's tickets (tasks whose
 * projectId === visionId), each feed item carrying its ticket metadata so a
 * reply can route back to the owning thread.
 *
 * This module is intentionally pure and side-effect free so it can be unit
 * tested as a single file (host build constraints: no full-project test runs).
 * The route layer (src/app/api/vision/[id]/inbox/route.ts) does the I/O:
 * reads the store, calls buildVisionInbox(), and writes replies via addComment.
 *
 * Scope (P0): read-only aggregated feed + clean vision↔ticket join + the
 * shape reply-routing needs. Vision-notes lane / roles / version-kind are P1.
 */

export interface InboxComment {
  id: string;
  author: string;
  content: string;
  createdAt: number;
  type?: 'comment' | 'system' | 'stop' | 'resume';
  model?: string;
  mentions?: string[];
}

export interface InboxTask {
  id: string;
  projectId: string;
  // Display metadata the feed needs. Names kept loose (any-ish) because the
  // store returns untyped rows; we read only these fields defensively.
  ticketNumber?: number | string;
  title?: string;
  status?: string;
  assignee?: string;
  version?: string;
  comments?: InboxComment[];
}

export interface InboxProject {
  id: string;
  name?: string;
  visionOwner?: string;
  owner?: string;
  components?: Array<{ name?: string }>;
  sections?: Array<{ name?: string }>;
}

/** One item in the aggregated feed: a single comment + its ticket context. */
export interface FeedItem {
  commentId: string;
  taskId: string;
  ticketNumber: number | string | null;
  ticketTitle: string | null;
  ticketStatus: string | null;
  author: string;
  content: string;
  createdAt: number;
  type: 'comment' | 'system' | 'stop' | 'resume';
  model?: string;
  mentions: string[];
}

export interface VisionInboxResult {
  visionId: string;
  visionName: string | null;
  owner: string | null;
  components: string[];
  ticketCount: number;     // tickets contributing at least one comment
  totalTickets: number;    // all tickets in the vision (for context)
  items: FeedItem[];       // newest-first
  tickets: Array<{ taskId: string; ticketNumber: number | string | null; title: string | null; status: string | null; commentCount: number }>;
}

/**
 * Resolve a vision's owner from the project's explicit fields, preferring the
 * vision-specific owner. (Role explicitness is P1; this is the P0 best-effort.)
 */
export function resolveVisionOwner(project: InboxProject | undefined): string | null {
  if (!project) return null;
  return project.visionOwner || project.owner || null;
}

/** Component/section display names for the left rail. */
export function resolveComponents(project: InboxProject | undefined): string[] {
  if (!project) return [];
  const fromComponents = (project.components || []).map((c) => c?.name).filter(Boolean) as string[];
  if (fromComponents.length) return fromComponents;
  return (project.sections || []).map((s) => s?.name).filter(Boolean) as string[];
}

/**
 * Build the aggregated, newest-first feed for one vision (project).
 *
 * The join: a task belongs to the vision iff task.projectId === visionId.
 * Every comment on every such task becomes a FeedItem stamped with its ticket
 * metadata. Items are sorted by createdAt descending (stable by commentId on
 * ties so output is deterministic for tests).
 *
 * Defensive against malformed rows: tasks without ids or with non-array
 * comments are skipped without throwing.
 */
export function buildVisionInbox(
  visionId: string,
  projects: InboxProject[],
  tasks: InboxTask[],
  opts: { includeSystem?: boolean; limit?: number } = {},
): VisionInboxResult {
  const includeSystem = opts.includeSystem ?? true;

  const project = projects.find((p) => p && p.id === visionId);
  const visionTasks = tasks.filter((t) => t && t.id && t.projectId === visionId);

  const items: FeedItem[] = [];
  const ticketSummaries: VisionInboxResult['tickets'] = [];

  for (const task of visionTasks) {
    const comments = Array.isArray(task.comments) ? task.comments : [];
    let contributed = 0;
    for (const c of comments) {
      if (!c || !c.id) continue;
      const type = (c.type || 'comment') as FeedItem['type'];
      if (!includeSystem && (type === 'system')) continue;
      items.push({
        commentId: c.id,
        taskId: task.id,
        ticketNumber: task.ticketNumber ?? null,
        ticketTitle: task.title ?? null,
        ticketStatus: task.status ?? null,
        author: c.author || 'unknown',
        content: c.content || '',
        createdAt: typeof c.createdAt === 'number' ? c.createdAt : 0,
        type,
        model: c.model,
        mentions: Array.isArray(c.mentions) ? c.mentions : [],
      });
      contributed++;
    }
    if (contributed > 0) {
      ticketSummaries.push({
        taskId: task.id,
        ticketNumber: task.ticketNumber ?? null,
        title: task.title ?? null,
        status: task.status ?? null,
        commentCount: contributed,
      });
    }
  }

  // Newest first; deterministic tie-break by commentId.
  items.sort((a, b) => (b.createdAt - a.createdAt) || (a.commentId < b.commentId ? -1 : a.commentId > b.commentId ? 1 : 0));

  const limited = typeof opts.limit === 'number' && opts.limit > 0 ? items.slice(0, opts.limit) : items;

  // Tickets sorted by most-recent activity (highest createdAt among its comments).
  const lastActivity = new Map<string, number>();
  for (const it of items) {
    const prev = lastActivity.get(it.taskId) ?? 0;
    if (it.createdAt > prev) lastActivity.set(it.taskId, it.createdAt);
  }
  ticketSummaries.sort((a, b) => (lastActivity.get(b.taskId)! - lastActivity.get(a.taskId)!));

  return {
    visionId,
    visionName: project?.name ?? null,
    owner: resolveVisionOwner(project),
    components: resolveComponents(project),
    ticketCount: ticketSummaries.length,
    totalTickets: visionTasks.length,
    items: limited,
    tickets: ticketSummaries,
  };
}

/**
 * Validate a reply before it's routed to addComment. The feed reply must name
 * the ticket (taskId) it belongs to AND that ticket must actually belong to the
 * vision — this is what prevents a feed reply from leaking onto an unrelated
 * vision's ticket. Returns the resolved taskId or an error reason.
 */
export function validateReplyRoute(
  visionId: string,
  taskId: string | undefined,
  content: string | undefined,
  tasks: InboxTask[],
): { ok: true; taskId: string } | { ok: false; error: string } {
  if (!taskId) return { ok: false, error: 'taskId is required — a feed reply must route to a ticket' };
  if (!content || !content.trim()) return { ok: false, error: 'content is required' };
  const task = tasks.find((t) => t && t.id === taskId);
  if (!task) return { ok: false, error: `task ${taskId} not found` };
  if (task.projectId !== visionId) {
    return { ok: false, error: `task ${taskId} does not belong to vision ${visionId}` };
  }
  return { ok: true, taskId };
}
