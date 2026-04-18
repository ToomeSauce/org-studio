/**
 * Workspace Auth Middleware — v0.16 Multi-Workspace Support
 *
 * Extracts workspace context from requests and validates access.
 * Workspace isolation is enforced at the API layer, not just UI.
 *
 * Resolution order:
 *   1. Session cookie (`workspace_id` field in session record)
 *   2. JWT token claim (workspace_id) — future use
 *   3. Query parameter (?workspace_id=...)
 *   4. X-Workspace-Id header
 *   5. Default: 'default-workspace'
 *
 * For single-workspace instances (no multi-workspace configured),
 * everything transparently uses 'default-workspace' — zero breaking changes.
 */

import { NextRequest, NextResponse } from 'next/server';

// ── Types ──────────────────────────────────────────────────────────────

export interface WorkspaceContext {
  id: string;
  name: string;
  owner?: string;
  createdAt?: number;
}

export interface WorkspaceMembership {
  workspaceId: string;
  userId: string;
  role: 'owner' | 'member';
  joinedAt: number;
}

export interface Workspace {
  id: string;
  name: string;
  owner: string;
  createdAt: number;
}

// ── Constants ──────────────────────────────────────────────────────────

export const DEFAULT_WORKSPACE_ID = 'default-workspace';
export const DEFAULT_WORKSPACE: WorkspaceContext = {
  id: DEFAULT_WORKSPACE_ID,
  name: 'Default Workspace',
  owner: 'system',
  createdAt: 0,
};

export const WORKSPACE_COOKIE_KEY = 'org_studio_workspace_id';

// ── In-memory workspace registry ───────────────────────────────────────
// For v0.16: workspace data lives in settings.workspaces[]
// Production (v1.0+) will move this to its own Postgres table

let _workspacesCache: Workspace[] | null = null;
let _membershipCache: WorkspaceMembership[] | null = null;
let _cacheTs = 0;
const CACHE_TTL = 30_000; // 30s cache

function isCacheFresh(): boolean {
  return _workspacesCache !== null && Date.now() - _cacheTs < CACHE_TTL;
}

/**
 * Load workspaces and memberships from the store.
 * Lazy-loaded and cached to avoid reading the store on every request.
 */
async function loadWorkspaceData(): Promise<{
  workspaces: Workspace[];
  memberships: WorkspaceMembership[];
}> {
  if (isCacheFresh()) {
    return { workspaces: _workspacesCache!, memberships: _membershipCache! };
  }

  try {
    const { getStoreProvider } = await import('@/lib/store-provider');
    const store = await getStoreProvider().read();
    const settings = store.settings || {};

    _workspacesCache = (settings.workspaces as Workspace[]) || [
      {
        id: DEFAULT_WORKSPACE_ID,
        name: 'Default Workspace',
        owner: 'system',
        createdAt: 0,
      },
    ];
    _membershipCache = (settings.workspaceMemberships as WorkspaceMembership[]) || [];
    _cacheTs = Date.now();
  } catch {
    // On error, use defaults
    _workspacesCache = [
      {
        id: DEFAULT_WORKSPACE_ID,
        name: 'Default Workspace',
        owner: 'system',
        createdAt: 0,
      },
    ];
    _membershipCache = [];
    _cacheTs = Date.now();
  }

  return { workspaces: _workspacesCache!, memberships: _membershipCache! };
}

/** Bust workspace cache (call after workspace settings change) */
export function invalidateWorkspaceCache(): void {
  _workspacesCache = null;
  _membershipCache = null;
  _cacheTs = 0;
}

// ── Workspace Resolution ───────────────────────────────────────────────

/**
 * Extract workspace_id from the request using the resolution chain.
 * Returns the workspace context or null if the workspace is invalid.
 */
export async function resolveWorkspaceContext(
  req: NextRequest,
  userId?: string,
): Promise<{ context: WorkspaceContext; error?: never } | { context?: never; error: NextResponse }> {
  const { workspaces, memberships } = await loadWorkspaceData();

  // 1. Check X-Workspace-Id header (API clients)
  let workspaceId = req.headers.get('x-workspace-id');

  // 2. Check query parameter
  if (!workspaceId) {
    const url = new URL(req.url);
    workspaceId = url.searchParams.get('workspace_id');
  }

  // 3. Check session cookie
  if (!workspaceId) {
    const cookieHeader = req.headers.get('cookie') || '';
    const match = cookieHeader.match(new RegExp(`${WORKSPACE_COOKIE_KEY}=([^;]+)`));
    workspaceId = match ? decodeURIComponent(match[1]) : null;
  }

  // 4. Default
  if (!workspaceId) {
    workspaceId = DEFAULT_WORKSPACE_ID;
  }

  // Look up workspace
  const workspace = workspaces.find((w) => w.id === workspaceId);

  // If workspace not found and it's the default, use the default context
  if (!workspace && workspaceId === DEFAULT_WORKSPACE_ID) {
    return { context: { ...DEFAULT_WORKSPACE } };
  }

  if (!workspace) {
    return {
      error: NextResponse.json(
        { error: 'Workspace not found', workspaceId },
        { status: 404 },
      ),
    };
  }

  // Check membership (if userId provided and workspace is not default)
  if (userId && workspaceId !== DEFAULT_WORKSPACE_ID) {
    const isMember =
      workspace.owner === userId ||
      memberships.some(
        (m) => m.workspaceId === workspaceId && m.userId === userId,
      );

    if (!isMember) {
      return {
        error: NextResponse.json(
          { error: 'Forbidden — not a member of this workspace' },
          { status: 403 },
        ),
      };
    }
  }

  return {
    context: {
      id: workspace.id,
      name: workspace.name,
      owner: workspace.owner,
      createdAt: workspace.createdAt,
    },
  };
}

// ── Data Filtering ─────────────────────────────────────────────────────

/**
 * Filter an array of records by workspace_id.
 * Records without workspace_id are treated as belonging to 'default-workspace'
 * (backward compat for single-workspace instances).
 */
export function filterByWorkspace<T extends Record<string, any>>(
  records: T[],
  workspaceId: string,
): T[] {
  return records.filter((r) => {
    const rws = r.workspace_id || DEFAULT_WORKSPACE_ID;
    return rws === workspaceId;
  });
}

/**
 * Stamp workspace_id onto a record before mutation (create/update).
 * No-ops if workspace_id already set and matches context.
 * Throws if workspace_id is set but doesn't match (cross-workspace write attempt).
 */
export function stampWorkspace<T extends Record<string, any>>(
  record: T,
  workspaceId: string,
): T & { workspace_id: string } {
  if (record.workspace_id && record.workspace_id !== workspaceId) {
    throw new Error(
      `Cross-workspace write rejected: record belongs to ${record.workspace_id}, request context is ${workspaceId}`,
    );
  }
  return { ...record, workspace_id: workspaceId };
}

/**
 * Check if a specific record belongs to the given workspace.
 * Returns true if access is allowed.
 */
export function belongsToWorkspace(
  record: Record<string, any>,
  workspaceId: string,
): boolean {
  const rws = record.workspace_id || DEFAULT_WORKSPACE_ID;
  return rws === workspaceId;
}

// ── User Workspace Listing ─────────────────────────────────────────────

/**
 * Get all workspaces a user has access to.
 * Always includes 'default-workspace'.
 */
export async function getUserWorkspaces(
  userId: string,
): Promise<WorkspaceContext[]> {
  const { workspaces, memberships } = await loadWorkspaceData();

  const accessibleIds = new Set<string>([DEFAULT_WORKSPACE_ID]);

  // Add workspaces where user is owner
  for (const ws of workspaces) {
    if (ws.owner === userId) {
      accessibleIds.add(ws.id);
    }
  }

  // Add workspaces where user is member
  for (const m of memberships) {
    if (m.userId === userId) {
      accessibleIds.add(m.workspaceId);
    }
  }

  return workspaces
    .filter((ws) => accessibleIds.has(ws.id))
    .map((ws) => ({
      id: ws.id,
      name: ws.name,
      owner: ws.owner,
      createdAt: ws.createdAt,
    }));
}

// ── Cookie Helpers ─────────────────────────────────────────────────────

/**
 * Create a Set-Cookie header to persist active workspace.
 */
export function createWorkspaceCookie(workspaceId: string): string {
  return `${WORKSPACE_COOKIE_KEY}=${encodeURIComponent(workspaceId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}`;
}

/**
 * Create response with workspace cookie set.
 */
export function withWorkspaceCookie(
  response: NextResponse,
  workspaceId: string,
): NextResponse {
  response.headers.set('Set-Cookie', createWorkspaceCookie(workspaceId));
  return response;
}
