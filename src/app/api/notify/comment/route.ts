/**
 * #1268 — Internal notification bridge for comments inserted via OTHER
 * processes (notably the staging Next.js process). The local custom server
 * (server.mjs) listens on Postgres NOTIFY for `comment_added` events; when
 * the comment did NOT originate in this process, the in-process call to
 * routeCommentNotifications() inside the addComment route never fires for
 * us, and the assignee/dev-owner of the task goes silent.
 *
 * This endpoint is the bridge: server.mjs POSTs `{taskId, commentId}` here
 * after a Postgres comment_added NOTIFY arrives, and we run the same
 * unified router (and inherit its in-process LRU dedup + self-suppression
 * + system-comment skip + @mention envelope semantics).
 *
 * Idempotent: dedup on (agentId, commentId) is keyed in-process, so
 * duplicate calls produce a single delivery.
 *
 * Auth: requires Bearer ORG_STUDIO_API_KEY (same convention as other
 * mutating routes). Loopback callers from server.mjs include the header.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequestWithContext, requireWriteScope } from '@/lib/auth';
import { getStoreProvider } from '@/lib/store-provider';
import { resolveWorkspaceIdForRequest } from '@/lib/workspace-auth';
import { routeCommentNotifications } from '@/lib/notification-router';
import { resolveTaskComponent, resolveTaskVersion } from '@/lib/notification-context';
import { computeRecipientLastReplies } from '@/lib/notification-recency';
import { shouldRunNotificationListenBridge } from '@/lib/notification-runtime';

export async function POST(request: NextRequest) {
  const bridgeStart = Date.now();
  const authCtx = await authenticateRequestWithContext(request);
  if (authCtx.error) return authCtx.error;
  const scopeFail = requireWriteScope(authCtx.context);
  if (scopeFail) return scopeFail;

  // Defense in depth: server.mjs already avoids calling this endpoint from a
  // store-only LISTEN consumer, but the endpoint itself must never acquire a
  // durable delivery lease unless this process can reach an agent runtime.
  // Otherwise a cloud replica can strand a pending claim and the real local
  // bridge will suppress the human's @mention as duplicate-pg (#1809).
  if (!shouldRunNotificationListenBridge(process.env)) {
    return NextResponse.json(
      { ok: true, deferred: true, reason: 'runtime-bridge-not-owner' },
      { status: 202 },
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const taskId: string | undefined = body?.taskId;
  const commentId: string | undefined = body?.commentId;
  // Optional: scope passed through for non-task comments. Defaults to task.
  const scope = body?.scope || (taskId ? { kind: 'task', taskId } : null);
  if (!scope) {
    return NextResponse.json({ error: 'Missing taskId or scope' }, { status: 400 });
  }

  const workspaceId = await resolveWorkspaceIdForRequest(request);
  const provider = getStoreProvider(workspaceId) as any;
  const store = await provider.read();
  const teammates = store.settings?.teammates || [];

  // Locate the comment + task
  let task: any = null;
  let comment: any = null;
  let taskComments: any[] = [];
  if (scope.kind === 'task' && scope.taskId) {
    task = store.tasks.find((t: any) => t.id === scope.taskId);
    if (!task) {
      return NextResponse.json({ error: 'Task not found', taskId: scope.taskId }, { status: 404 });
    }
    // #1524 — fetch comments from the normalized org_studio_comments table
    // (not the soon-to-be-removed inline task.comments[] blob). We pull the
    // last 50 because we need both the source comment (latest) and enough
    // history for the recency map. Falls back to the inline blob if the
    // provider doesn't expose listComments (legacy file-provider mode).
    if (typeof provider.listComments === 'function') {
      try {
        taskComments = await provider.listComments(
          { kind: 'task', taskId: scope.taskId },
          { limit: 50 },
        );
      } catch (err) {
        console.warn(
          `[notify-bridge] listComments failed for task ${scope.taskId}; ` +
          `falling back to inline blob: ${err}`,
        );
        taskComments = Array.isArray(task.comments) ? task.comments : [];
      }
    } else {
      taskComments = Array.isArray(task.comments) ? task.comments : [];
    }

    if (commentId && taskComments.length > 0) {
      comment = taskComments.find((c: any) => c.id === commentId);
    }
    if (!comment && taskComments.length > 0) {
      // Fallback to most recent — the NOTIFY event may have raced ahead of
      // the comments-table write. The race is bounded by the same
      // transaction in PostgresStoreProvider.addComment(), and LRU dedup
      // will still suppress the duplicate when the correct commentId
      // arrives later.
      comment = taskComments[taskComments.length - 1];
    }
  }

  if (!comment) {
    return NextResponse.json({ error: 'Comment not found', commentId }, { status: 404 });
  }

  // Build router context (parity with addComment in /api/store route)
  const project = task?.projectId
    ? store.projects.find((p: any) => p.id === task.projectId)
    : undefined;
  const routerProject = project
    ? {
        id: project.id,
        name: project.name,
        devOwner: project.devOwner,
        visionOwner: project.visionOwner,
        qaOwner: project.qaOwner,
        owner: project.owner,
        sections: project.sections,
      }
    : undefined;
  const projectTasks = routerProject
    ? store.tasks
        .filter((t: any) => t.projectId === routerProject.id)
        .map((t: any) => ({ assignee: t.assignee }))
    : [];

  const result = await routeCommentNotifications({
    comment: {
      id: comment.id,
      author: comment.author,
      content: comment.content,
      type: comment.type,
      createdAt: typeof comment.createdAt === 'number' ? comment.createdAt : undefined,
    },
    scope: scope as any,
    teammates,
    context: {
      task: task
        ? {
            id: task.id,
            title: task.title,
            projectId: task.projectId,
            assignee: task.assignee,
            status: task.status,
            blockedReason: task.blockedReason,
            blockedReasonType: task.blockedReasonType,
            blockedBy: task.blockedBy,
          }
        : undefined,
      project: routerProject,
      // #1287 — parity with /api/store route: component + version owners
      // drive the per-comment page; project devOwner is now an orphan-only
      // fallback. See notification-router.ts.
      component: task ? resolveTaskComponent(project, task) : undefined,
      version: task ? resolveTaskVersion(project, task) : undefined,
      projectTasks,
      watchers: [],
      // #1513 — recency suppression input. Walk this task's comment
      // history once and record the latest createdAt per author (resolved
      // to agentId via teammates). The router skips recipients whose last
      // reply is newer than the source comment.
      // #1524 — pass the listComments result explicitly; the legacy
      // `task` arg keeps working for file-provider mode via the helper's
      // internal fallback.
      recipientLastReplies: computeRecipientLastReplies(task, teammates, comment, taskComments),
    },
  });

  console.log(
    `[notify-bridge] commentId=${commentId || '<none>'} ` +
    `bridge-latency=${Date.now() - bridgeStart}ms ` +
    `recipients=${result.notified.length} suppressed=${result.skipped.length}`
  );

  return NextResponse.json({ ok: true, ...result });
}
