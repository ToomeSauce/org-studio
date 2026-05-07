/**
 * Unified notification router for Org Studio comments.
 *
 * Single entry point: routeCommentNotifications(params)
 * Replaces the per-scope branchy dispatch in the addComment handler.
 *
 * Features:
 * - Scope-aware recipient resolution (task / board / section / dm)
 * - In-memory LRU dedup (process-local, size-capped)
 * - Self-mention suppression
 * - Per-scope message templates
 * - Delivery via sendToAgent (runtime registry)
 */
import { sendToAgent } from '@/lib/runtimes/registry';
import { rpc } from '@/lib/gateway-rpc';
import { parseMentions, getProjectTeammateNames } from '@/lib/mentions';
import type { Teammate, MentionMatch } from '@/lib/mentions';
import type { CommentScope } from '@/lib/store';

// ---------- Types ----------

export interface RouterComment {
  id?: string;
  author: string;
  content: string;
  mentions?: string[];
  /**
   * Comment kind. 'system' = auto-generated (e.g. backward-move reasons,
   * reopen notes); these MUST NOT trigger agent notifications. Anything
   * else (undefined / 'comment' / 'handoff' / etc.) is treated as a
   * human/agent comment that follows the normal recipient-resolution path.
   * #1268 — done-when #2.
   */
  type?: string;
}

export interface RouterTask {
  id: string;
  title: string;
  projectId?: string;
  assignee?: string;
}

export interface RouterProject {
  id: string;
  name: string;
  devOwner?: string;
  visionOwner?: string;
  qaOwner?: string;
  owner?: string;
  sections?: { id: string; name: string; owner?: string }[];
}

export interface RouterSection {
  id: string;
  name: string;
  owner?: string;
}

export interface RouteParams {
  comment: RouterComment;
  scope: CommentScope;
  teammates: Teammate[];
  context: {
    task?: RouterTask;
    project?: RouterProject;
    section?: RouterSection;
    projectTasks?: { assignee?: string }[];
    watchers?: string[]; // agent ids watching this task (future, OK empty for now)
  };
}

export interface RouteResult {
  notified: string[];
  skipped: { agentId: string; reason: string }[];
}

// ---------- Dedup LRU ----------

const DEDUP_MAX_SIZE = 1000;
const DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface DedupEntry {
  timestamp: number;
}

const dedupCache = new Map<string, DedupEntry>();

function dedupKey(agentId: string, commentId: string): string {
  return `${agentId}:${commentId}`;
}

function isDuplicate(agentId: string, commentId: string): boolean {
  const key = dedupKey(agentId, commentId);
  const entry = dedupCache.get(key);
  if (!entry) return false;
  if (Date.now() - entry.timestamp > DEDUP_TTL_MS) {
    dedupCache.delete(key);
    return false;
  }
  return true;
}

function markNotified(agentId: string, commentId: string): void {
  const key = dedupKey(agentId, commentId);
  dedupCache.set(key, { timestamp: Date.now() });

  // Evict oldest entries if over capacity
  if (dedupCache.size > DEDUP_MAX_SIZE) {
    const it = dedupCache.keys();
    const oldest = it.next().value;
    if (oldest) dedupCache.delete(oldest);
  }
}

/** Exported for testing */
export function _resetDedupCache(): void {
  dedupCache.clear();
}

// ---------- Snippet helper ----------

function makeSnippet(content: string, maxLen = 200): string {
  const cleaned = (content || '').replace(/\n/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen) + '…';
}

// ---------- Message templates ----------

// Why the recipient is being notified — lets the template tailor the
// envelope (e.g. "mentioned you" vs. "commented on your task").
export type RecipientReason =
  | 'mention'
  | 'assignee'
  | 'watcher'
  | 'project-owner'
  | 'section-owner'
  | 'dm-participant'
  | 'dm';

function buildMessage(
  scope: CommentScope,
  comment: RouterComment,
  ctx: RouteParams['context'],
  reason: RecipientReason = 'mention',
): string {
  const snippet = makeSnippet(comment.content);
  switch (scope.kind) {
    case 'task': {
      // #1262 — use the same rich "reply on the task" envelope that the
      // LISTEN-path mention notifier emits. The previous one-line snippet
      // template ("📣 @author commented on task «...»") landed in agent
      // sessions as easy-to-skim chat noise; the rich envelope is what
      // makes agents actually pick the comment up and reply on the
      // ticket. Reason switches the verb so an assignee-only delivery
      // reads "commented on your task" instead of "mentioned you".
      const title = ctx.task?.title || 'Unknown task';
      const taskId = ctx.task?.id || (scope as any).taskId || '';
      const verb = reason === 'mention' ? 'mentioned you on task' : 'commented on your task';
      const author = comment.author;
      // Keep the body short — use the snippet, not full content. Long
      // comments still arrive through the UI; the prompt's job is to
      // make the agent stop and look.
      return (
        `💬 **${author}** ${verb}: **${title}**\n\n` +
        `> ${snippet}\n\n` +
        `Task ID: ${taskId}\n\n` +
        `**Reply on the task, not in chat.** Call \`addComment\` against this task id ` +
        `so ${author} sees your response on the ticket. Include @${author} in your reply ` +
        `to notify them.`
      );
    }
    case 'board': {
      const projectName = ctx.project?.name || 'Unknown project';
      return `💬 @${comment.author} in #general (${projectName}): ${snippet}`;
    }
    case 'section': {
      const sectionName = ctx.section?.name || 'unknown';
      const projectName = ctx.project?.name || 'Unknown project';
      return `💬 @${comment.author} in #${sectionName} (${projectName}): ${snippet}`;
    }
    case 'dm':
      return `✉️ DM from @${comment.author}: ${snippet}`;
    default:
      return `💬 @${comment.author}: ${snippet}`;
  }
}

// ---------- Recipient resolution ----------

function resolveTeammate(nameOrId: string, teammates: Teammate[]): Teammate | undefined {
  const lower = nameOrId.toLowerCase();
  return teammates.find(t =>
    t.name?.toLowerCase() === lower ||
    t.agentId?.toLowerCase() === lower ||
    t.id?.toLowerCase() === lower
  );
}

function isAuthor(teammate: Teammate, authorName: string): boolean {
  const authorLower = (authorName || '').toLowerCase();
  return (
    (teammate.name?.toLowerCase() === authorLower) ||
    (teammate.agentId?.toLowerCase() === authorLower) ||
    (teammate.id?.toLowerCase() === authorLower)
  );
}

function resolveRecipients(params: RouteParams): Map<string, RecipientReason> {
  const { scope, comment, teammates, context } = params;
  // First-write-wins: we want 'mention' to beat 'assignee' for the same
  // recipient so the envelope says "mentioned you" rather than "commented
  // on your task". Mentions are added first below.
  const recipientIds = new Map<string, RecipientReason>();
  const addOnce = (agentId: string, reason: RecipientReason) => {
    if (!recipientIds.has(agentId)) recipientIds.set(agentId, reason);
  };

  // 1. Mentioned agents (all scopes) — added first so mention wins on tie.
  const mentions = parseMentions(comment.content, teammates);
  for (const m of mentions) {
    addOnce(m.teammate.agentId, 'mention');
  }

  switch (scope.kind) {
    case 'task': {
      // assignee
      if (context.task?.assignee) {
        const t = resolveTeammate(context.task.assignee, teammates);
        if (t) addOnce(t.agentId, 'assignee');
      }
      // watchers
      for (const wid of context.watchers || []) {
        addOnce(wid, 'watcher');
      }
      // project owners (auto-notify: devOwner + qaOwner)
      if (context.project) {
        for (const ownerName of [context.project.devOwner, context.project.qaOwner].filter(Boolean)) {
          const t = resolveTeammate(ownerName!, teammates);
          if (t) addOnce(t.agentId, 'project-owner');
        }
      }
      break;
    }

    case 'board': {
      // Only mentioned agents from project teammate set
      if (context.project && context.projectTasks) {
        const projSet = getProjectTeammateNames(context.project, context.projectTasks);
        const projSetLower = new Set([...projSet].map(n => n.toLowerCase()));
        // Filter mentions to project teammates only
        for (const id of [...recipientIds.keys()]) {
          const t = teammates.find(tm => tm.agentId === id);
          if (t && !projSetLower.has(t.name?.toLowerCase() || '') && !projSetLower.has(t.agentId?.toLowerCase() || '')) {
            recipientIds.delete(id);
          }
        }
      }
      break;
    }

    case 'section': {
      // section owner
      if (context.section?.owner) {
        const t = resolveTeammate(context.section.owner, teammates);
        if (t) addOnce(t.agentId, 'section-owner');
      }
      // Filter mentions to project teammate set
      if (context.project && context.projectTasks) {
        const projSet = getProjectTeammateNames(context.project, context.projectTasks);
        if (context.section?.owner) projSet.add(context.section.owner);
        const projSetLower = new Set([...projSet].map(n => n.toLowerCase()));
        for (const id of [...recipientIds.keys()]) {
          const t = teammates.find(tm => tm.agentId === id);
          if (t && !projSetLower.has(t.name?.toLowerCase() || '') && !projSetLower.has(t.agentId?.toLowerCase() || '')) {
            recipientIds.delete(id);
          }
        }
      }
      break;
    }

    case 'dm': {
      // The OTHER participant in the DM thread
      if (scope.dmThreadId) {
        const parts = scope.dmThreadId.split('::');
        if (parts.length === 3 && parts[0] === 'dm') {
          for (const pid of [parts[1], parts[2]]) {
            const t = resolveTeammate(pid, teammates);
            if (t) addOnce(t.agentId, 'dm-participant');
          }
        }
      }
      break;
    }
  }

  return recipientIds;
}

// ---------- Delivery ----------

async function deliverToAgent(
  agentId: string,
  message: string,
  idempotencyKey: string,
): Promise<boolean> {
  try {
    await sendToAgent(agentId, message, {
      sessionKey: `agent:${agentId}:main`,
      idempotencyKey,
    });
    return true;
  } catch {
    // Fallback: direct OpenClaw RPC
    try {
      await rpc('chat.send', {
        sessionKey: `agent:${agentId}:main`,
        message,
        idempotencyKey,
      });
      return true;
    } catch (e) {
      console.error(`[notification-router] Failed to deliver to ${agentId}:`, e);
      return false;
    }
  }
}

// ---------- Main router ----------

/**
 * Unified notification routing for comments across all scopes.
 *
 * Resolves recipients based on scope, deduplicates, suppresses self-mentions,
 * and delivers notifications via the runtime registry.
 */
export async function routeCommentNotifications(params: RouteParams): Promise<RouteResult> {
  const { comment, scope, teammates } = params;
  const commentId = comment.id || String(Date.now());
  const result: RouteResult = { notified: [], skipped: [] };

  // #1268 — system comments are auto-generated (status-rewind reasons,
  // reopen notes, etc.). They must not page anyone; the change they record
  // already produced its own notification (status-change ping, etc.).
  if (comment.type === 'system') {
    return result;
  }

  // Resolve all candidate recipients (with reason → template)
  const recipientReasons = resolveRecipients(params);

  for (const [agentId, reason] of recipientReasons) {
    const teammate = teammates.find(t => t.agentId === agentId);
    if (!teammate) {
      result.skipped.push({ agentId, reason: 'not-found' });
      continue;
    }

    // Skip humans (they see it in the UI)
    if (teammate.isHuman) {
      result.skipped.push({ agentId, reason: 'human' });
      continue;
    }

    // Self-mention suppression
    if (isAuthor(teammate, comment.author)) {
      result.skipped.push({ agentId, reason: 'self' });
      continue;
    }

    // Dedup check
    if (isDuplicate(agentId, commentId)) {
      result.skipped.push({ agentId, reason: 'duplicate' });
      continue;
    }

    // Build message (template branches on the reason for task scope)
    const message = buildMessage(scope, comment, params.context, reason);
    const idempotencyKey = `notify-${scope.kind}-${commentId}-${agentId}`;

    // Deliver
    const ok = await deliverToAgent(agentId, message, idempotencyKey);
    if (ok) {
      markNotified(agentId, commentId);
      result.notified.push(agentId);
    } else {
      result.skipped.push({ agentId, reason: 'delivery-failed' });
    }
  }

  return result;
}

// ---------- Agent inbox fetch (for scheduler prompt) ----------

/**
 * Fetch recent comments where the agent was mentioned or is a DM recipient.
 * Groups by scope kind. Returns formatted text for prompt injection.
 *
 * Implementation uses the StoreProvider to query comments.
 * Falls back to [] if the provider doesn't support the needed queries.
 *
 * TODO(v0.14): If Postgres, use a proper SQL query with JSONB containment.
 * For now, delegates to listDmThreads (existing) + returns mentions as TODO.
 */
export async function fetchAgentInbox(
  agentId: string,
  agentName: string,
  since: number,
): Promise<string> {
  // This is a structural placeholder — the DM inbox fetch is handled by
  // getRecentDmInbox in scheduler.ts. Cross-scope mention fetching requires
  // a new store query that doesn't exist yet.
  //
  // TODO(v0.14): Implement cross-scope mention query:
  //   SELECT * FROM comments
  //   WHERE created_at > $since
  //     AND (data->'mentions' @> '"agentId"' OR scope_kind='dm' AND participant=agentId)
  //   ORDER BY created_at DESC LIMIT 10
  //
  // For now, return empty — the scheduler's DM section still works via getRecentDmInbox.
  return '';
}
