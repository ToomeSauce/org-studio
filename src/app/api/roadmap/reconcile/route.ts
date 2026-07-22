import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequestWithContext, requireWriteScope } from '@/lib/auth';
import { reconcileRoadmapItemDone } from '@/lib/roadmap-sync';
import { resolveWorkspaceIdForRequest } from '@/lib/workspace-auth';

/**
 * POST /api/roadmap/reconcile
 *
 * Body: { projectId?: string }
 *
 * Cross-checks every `current` roadmap version's item-done flags against
 * underlying task statuses, flips drifted items, ships versions whose
 * items are all done, and auto-advances (respecting pause + horizon).
 *
 * Bearer-token auth via standard ORG_STUDIO_API_KEY flow.
 */
export async function POST(req: NextRequest) {
  const authCtx = await authenticateRequestWithContext(req);
  if (authCtx.error) return authCtx.error;
  const scopeFail = requireWriteScope(authCtx.context);
  if (scopeFail) return scopeFail;
  const workspaceId = await resolveWorkspaceIdForRequest(req);

  let projectId: string | undefined;
  try {
    const body = await req.json().catch(() => ({}));
    if (body && typeof body.projectId === 'string' && body.projectId.trim()) {
      projectId = body.projectId.trim();
    }
  } catch {
    /* empty body is fine */
  }

  try {
    const summary = await reconcileRoadmapItemDone(projectId, workspaceId);
    return NextResponse.json({ ok: true, projectId: projectId || null, ...summary });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
