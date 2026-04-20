import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, authenticateRequestWithContext, getSession, getSessionTokenFromCookie } from '@/lib/auth';
import {
  getUserWorkspaces,
  resolveWorkspaceContext,
  createWorkspaceCookie,
  DEFAULT_WORKSPACE_ID,
  invalidateWorkspaceCache,
} from '@/lib/workspace-auth';

/**
 * GET /api/workspaces
 *
 * Returns the current user's accessible workspaces and the active workspace context.
 */
export async function GET(req: NextRequest) {
  const authError = await authenticateRequest(req);
  if (authError) return authError;

  // Resolve the current user (supports session + Bearer + noauth)
  const authResult = await authenticateRequestWithContext(req);
  const userId = authResult.context?.userId || 'anonymous';

  // Get current workspace context
  const wsResult = await resolveWorkspaceContext(req, userId);
  const currentWorkspace = wsResult.context || {
    id: DEFAULT_WORKSPACE_ID,
    name: 'Default Workspace',
    owner: 'system',
  };

  // Get all workspaces this user can access
  const workspaces = await getUserWorkspaces(userId);

  return NextResponse.json({
    ok: true,
    current: currentWorkspace,
    workspaces,
    multiWorkspace: workspaces.length > 1,
  });
}

/**
 * POST /api/workspaces
 *
 * Switch workspace: { action: 'switch', workspaceId: '...' }
 * Invalidate cache: { action: 'invalidate-cache' }
 */
export async function POST(req: NextRequest) {
  const authError = await authenticateRequest(req);
  if (authError) return authError;

  const body = await req.json();
  const { action } = body;

  switch (action) {
    case 'switch': {
      const { workspaceId } = body;
      if (!workspaceId) {
        return NextResponse.json({ error: 'Missing workspaceId' }, { status: 400 });
      }

      // Resolve the current user
      const authResult2 = await authenticateRequestWithContext(req);
      const userId = authResult2.context?.userId || 'anonymous';

      // Validate the user has access to this workspace
      const wsResult = await resolveWorkspaceContext(
        new NextRequest(new URL(`${req.url}?workspace_id=${encodeURIComponent(workspaceId)}`), {
          headers: req.headers,
        }),
        userId,
      );

      if (wsResult.error) return wsResult.error;

      // Set the workspace cookie and return the context
      const response = NextResponse.json({
        ok: true,
        workspace: wsResult.context,
      });
      response.headers.set('Set-Cookie', createWorkspaceCookie(workspaceId));
      return response;
    }

    case 'invalidate-cache': {
      invalidateWorkspaceCache();
      return NextResponse.json({ ok: true });
    }

    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
}
