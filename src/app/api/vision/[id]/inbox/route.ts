import { NextRequest, NextResponse } from 'next/server';
import {
  getSession,
  getSessionTokenFromCookie,
} from '@/lib/auth';
import { getStoreProviderAllWorkspaces } from '@/lib/store-provider';
import {
  buildVisionInbox,
  validateReplyRoute,
  type InboxProject,
  type InboxTask,
} from '@/lib/vision-inbox';

/**
 * Vision Inbox API — P0.
 *
 *   GET  /api/vision/[id]/inbox   → aggregated comment feed for the vision
 *   POST /api/vision/[id]/inbox   → reply, routed to a ticket in the vision
 *                                   body: { taskId, content, author?, type? }
 *
 * Read-only feed + reply-routing. Telegram mirror was cut. Vision-notes lane,
 * roles, and version-kind are P1 (not here).
 *
 * Reply-routing deliberately DELEGATES the actual write to the existing
 * /api/store `addComment` action rather than re-implementing author
 * resolution, canonicalization, audit metadata, lease extension, and
 * notification routing (all of which live in that handler). This route's job
 * is the *new* guarantee: the ticket being replied to actually belongs to
 * this vision (cross-vision leak guard). Once validated, it forwards.
 */

/** Cloud-mode read gate — mirrors /api/store GET (session cookie OR Bearer). */
async function readAllowed(req: NextRequest): Promise<boolean> {
  if (!process.env.DATABASE_URL || process.env.ALLOW_ANONYMOUS_READS === 'true') {
    return true;
  }
  const cookieHeader = req.headers.get('cookie');
  const sessionToken = getSessionTokenFromCookie(cookieHeader);
  if (sessionToken) {
    const session = await getSession(sessionToken);
    if (session) return true;
  }
  const authHeader = req.headers.get('authorization') || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (bearer) {
    if (process.env.ORG_STUDIO_API_KEY && bearer === process.env.ORG_STUDIO_API_KEY) return true;
    try {
      const { perAgentTokensEnabled, verifyApiToken } = await import('@/lib/api-tokens');
      if (perAgentTokensEnabled()) {
        const record = await verifyApiToken(bearer);
        if (record) return true;
      }
    } catch {
      /* fall through */
    }
  }
  return false;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!(await readAllowed(req))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const provider = getStoreProviderAllWorkspaces();
    const store = await provider.read();
    const url = new URL(req.url);
    const includeSystem = url.searchParams.get('includeSystem') !== 'false';
    const limitParam = url.searchParams.get('limit');
    const parsedLimit = limitParam ? parseInt(limitParam, 10) : NaN;

    // #1520/#1524: read() returns tasks WITHOUT the inline comments blob.
    // Comments live in the normalized org_studio_comments table; bulk-fetch
    // them for this vision's tasks and attach before aggregating.
    const visionTasks = (store.tasks || []).filter((t: any) => t && t.id && t.projectId === id);
    const taskIds = visionTasks.map((t: any) => t.id);
    let commentsByTask = new Map<string, any[]>();
    if (taskIds.length && typeof provider.listCommentsForTasks === 'function') {
      try {
        commentsByTask = await provider.listCommentsForTasks(taskIds, { limit: 200 });
      } catch {
        // Fall back to whatever inline comments exist (likely none).
      }
    }
    const tasksWithComments = visionTasks.map((t: any) => ({
      ...t,
      comments: commentsByTask.get(t.id) || (Array.isArray(t.comments) ? t.comments : []),
    }));

    const result = buildVisionInbox(
      id,
      (store.projects || []) as InboxProject[],
      tasksWithComments as InboxTask[],
      { includeSystem, limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined },
    );

    if (result.visionName === null && result.totalTickets === 0) {
      const exists = (store.projects || []).some((p: any) => p && p.id === id);
      if (!exists) {
        return NextResponse.json({ error: 'vision not found', visionId: id }, { status: 404 });
      }
    }

    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    return NextResponse.json(
      { error: 'failed to build vision inbox', detail: String(err?.message || err) },
      { status: 500 },
    );
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json body' }, { status: 400 });
  }

  const taskId: string | undefined = body?.taskId;
  const content: string | undefined = body?.content;

  // The NEW guarantee this route adds: the ticket belongs to this vision.
  // (Auth + author resolution + audit are enforced by /api/store downstream.)
  let store;
  try {
    store = await getStoreProviderAllWorkspaces().read();
  } catch (err: any) {
    return NextResponse.json(
      { error: 'failed to read store', detail: String(err?.message || err) },
      { status: 500 },
    );
  }
  const check = validateReplyRoute(id, taskId, content, (store.tasks || []) as InboxTask[]);
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: 400 });
  }

  // Forward to the canonical addComment action, preserving the caller's auth
  // headers (cookie / Bearer) so author resolution + audit attribution stay
  // exactly as the store route computes them.
  const origin = new URL(req.url).origin;
  const forwardHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  const cookie = req.headers.get('cookie');
  const authz = req.headers.get('authorization');
  if (cookie) forwardHeaders['cookie'] = cookie;
  if (authz) forwardHeaders['authorization'] = authz;

  try {
    const res = await fetch(`${origin}/api/store`, {
      method: 'POST',
      headers: forwardHeaders,
      body: JSON.stringify({
        action: 'addComment',
        taskId: check.taskId,
        comment: {
          author: body?.author,
          content: content!.trim(),
          type: body?.type === 'system' ? 'system' : 'comment',
        },
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { error: 'reply failed at store layer', status: res.status, detail: data },
        { status: res.status },
      );
    }
    return NextResponse.json({ ok: true, taskId: check.taskId, result: data }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json(
      { error: 'failed to post reply', detail: String(err?.message || err) },
      { status: 500 },
    );
  }
}
