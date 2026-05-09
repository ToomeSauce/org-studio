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
import { authenticateRequest } from '@/lib/auth';
import { getStoreProvider } from '@/lib/store-provider';
import { routeCommentNotifications } from '@/lib/notification-router';
import { resolveTaskComponent, resolveTaskVersion } from '@/lib/notification-context';

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request);
  if (authError) return authError;

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

  const store = await getStoreProvider().read();
  const teammates = store.settings?.teammates || [];

  // Locate the comment + task
  let task: any = null;
  let comment: any = null;
  if (scope.kind === 'task' && scope.taskId) {
    task = store.tasks.find((t: any) => t.id === scope.taskId);
    if (!task) {
      return NextResponse.json({ error: 'Task not found', taskId: scope.taskId }, { status: 404 });
    }
    if (commentId && Array.isArray(task.comments)) {
      comment = task.comments.find((c: any) => c.id === commentId);
    }
    if (!comment && Array.isArray(task.comments) && task.comments.length > 0) {
      // Fallback to most recent — the NOTIFY event may have raced ahead of
      // the inline `task.comments[]` write, but that race is bounded by the
      // same transaction in PostgresStoreProvider.addComment(). In that
      // case, the LRU dedup will still suppress the duplicate when the
      // correct commentId arrives later.
      comment = task.comments[task.comments.length - 1];
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
    },
    scope: scope as any,
    teammates,
    context: {
      task: task
        ? { id: task.id, title: task.title, projectId: task.projectId, assignee: task.assignee }
        : undefined,
      project: routerProject,
      // #1287 — parity with /api/store route: component + version owners
      // drive the per-comment page; project devOwner is now an orphan-only
      // fallback. See notification-router.ts.
      component: task ? resolveTaskComponent(project, task) : undefined,
      version: task ? resolveTaskVersion(project, task) : undefined,
      projectTasks,
      watchers: [],
    },
  });

  return NextResponse.json({ ok: true, ...result });
}
