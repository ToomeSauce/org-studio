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
import type { AuthContext } from '@/lib/auth';
import { withPgClient } from '@/lib/pg-pool';

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
// Workspaces + memberships now live in Postgres tables:
//   org_studio_workspaces, org_studio_workspace_memberships

let _workspacesCache: Workspace[] | null = null;
let _membershipCache: WorkspaceMembership[] | null = null;
let _cacheTs = 0;
const CACHE_TTL = 30_000; // 30s cache

function isCacheFresh(): boolean {
  return _workspacesCache !== null && Date.now() - _cacheTs < CACHE_TTL;
}

/**
 * Load workspaces and memberships from Postgres (primary) or settings (fallback).
 */
async function loadWorkspaceData(): Promise<{
  workspaces: Workspace[];
  memberships: WorkspaceMembership[];
}> {
  if (isCacheFresh()) {
    return { workspaces: _workspacesCache!, memberships: _membershipCache! };
  }

  // Try Postgres first
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    try {
      return await withPgClient(async (client) => {
        const wsResult = await client.query(
          'SELECT id, name, owner, created_at FROM org_studio_workspaces ORDER BY id',
        );
        const memResult = await client.query(
          'SELECT workspace_id, user_id, role, joined_at FROM org_studio_workspace_memberships ORDER BY workspace_id, user_id',
        );
        _workspacesCache = wsResult.rows.map((r: any) => ({
          id: r.id,
          name: r.name,
          owner: r.owner,
          createdAt: typeof r.created_at === 'string' ? parseInt(r.created_at, 10) : (r.created_at || 0),
        }));
        _membershipCache = memResult.rows.map((r: any) => ({
          workspaceId: r.workspace_id,
          userId: r.user_id,
          role: r.role as 'owner' | 'member',
          joinedAt: typeof r.joined_at === 'string' ? parseInt(r.joined_at, 10) : (r.joined_at || 0),
        }));
        _cacheTs = Date.now();
        return { workspaces: _workspacesCache!, memberships: _membershipCache! };
      }, { max: 5 });
    } catch (e: any) {
      console.warn('[workspace-auth] Postgres load failed, falling back to settings:', e.message);
    }
  }

  // Fallback: read from store settings
  try {
    // Loading the workspace registry itself — use the cross-workspace escape
    // hatch since by construction this code has no workspace context yet.
    const { getStoreProviderAllWorkspaces } = await import('@/lib/store-provider');
    const store = await getStoreProviderAllWorkspaces().read();
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

/**
 * #1387 A.3 — Enumerate every workspace_id known to the system.
 *
 * For background workers / crons that fundamentally have no request context
 * (outbox, vision-cron, heartbeat housekeeping). Callers should iterate the
 * returned ids and pass each one through a per-workspace `getStoreProvider`
 * or scoped SQL.
 *
 * OSS mode (no DATABASE_URL): always returns `['default-workspace']`.
 * Postgres mode: reads `org_studio_workspaces` via the shared cache.
 */
export async function listAllWorkspaceIds(): Promise<string[]> {
  const { workspaces } = await loadWorkspaceData();
  if (!workspaces.length) return [DEFAULT_WORKSPACE_ID];
  return workspaces.map((w) => w.id);
}

// ── WORKSPACE_ENFORCE feature flag ─────────────────────────────────────

/**
 * Read WORKSPACE_ENFORCE at request time (not import time!).
 * This allows flipping the flag via env var update without a redeploy.
 *
 * Values:
 *   'strict'     — return 403 on cross-workspace access
 *   'permissive' — log but allow, fall back to default-workspace (DEFAULT)
 */
function getEnforceMode(): 'strict' | 'permissive' {
  const val = process.env.WORKSPACE_ENFORCE;
  if (val === 'strict') return 'strict';
  return 'permissive'; // default
}

/**
 * Lookup a user's primary workspace via membership.
 * Priority: owner role first, then first match.
 * Returns DEFAULT_WORKSPACE_ID if no membership found.
 */
export async function lookupUserWorkspace(userId: string): Promise<string> {
  const { memberships } = await loadWorkspaceData();
  // Prefer owner role
  const ownerMembership = memberships.find(
    (m) => m.userId === userId && m.role === 'owner',
  );
  if (ownerMembership) return ownerMembership.workspaceId;
  // Fallback: first membership
  const anyMembership = memberships.find((m) => m.userId === userId);
  if (anyMembership) return anyMembership.workspaceId;
  return DEFAULT_WORKSPACE_ID;
}

/**
 * Check if a user has membership in a specific workspace.
 */
export async function hasWorkspaceMembership(
  userId: string,
  workspaceId: string,
): Promise<boolean> {
  const { memberships } = await loadWorkspaceData();
  return memberships.some(
    (m) => m.userId === userId && m.workspaceId === workspaceId,
  );
}

/**
 * #1387 A.4 — strict membership list for the login selector.
 *
 * Returns ONLY the workspaces where the user has an actual row in
 * `org_studio_workspace_memberships` (or, in OSS mode, the single
 * default workspace as a back-compat affordance because OSS has no
 * memberships table populated).
 *
 * Unlike `getUserWorkspaces`, this does NOT force-include
 * 'default-workspace' on top of real memberships — cloud users with
 * memberships in ws-a / ws-b should see exactly ws-a and ws-b in the
 * selector, not a phantom default.
 *
 * Shape: `{ id, name, role }[]` — login UI renders `name`, sends `id`.
 */
export async function listUserWorkspaceMemberships(
  userId: string,
): Promise<Array<{ id: string; name: string; role: string }>> {
  const { workspaces, memberships } = await loadWorkspaceData();

  // OSS mode: no workspaces table loaded -> single default.
  if (!workspaces.length) {
    return [{ id: DEFAULT_WORKSPACE_ID, name: 'Default Workspace', role: 'owner' }];
  }

  const userMemberships = memberships.filter((m) => m.userId === userId);
  const wsById = new Map(workspaces.map((w) => [w.id, w]));
  const out: Array<{ id: string; name: string; role: string }> = [];
  const seen = new Set<string>();
  for (const m of userMemberships) {
    if (seen.has(m.workspaceId)) continue;
    seen.add(m.workspaceId);
    const ws = wsById.get(m.workspaceId);
    if (!ws) continue; // stale membership row pointing at a deleted workspace — skip
    out.push({ id: ws.id, name: ws.name, role: m.role });
  }
  return out;
}

// ── Workspace Resolution ───────────────────────────────────────────────

/**
 * Extract workspace_id from the request using the resolution chain.
 * Enforces workspace membership based on WORKSPACE_ENFORCE env var.
 *
 * Resolution order:
 *   1. X-Workspace-Id header
 *   2. Query parameter ?workspace_id=
 *   3. workspace_id cookie (org_studio_workspace_id)
 *   4. Default: 'default-workspace'
 *
 * @param req - The incoming request
 * @param userId - The authenticated user's ID (from AuthContext)
 */
export async function resolveWorkspaceContext(
  req: NextRequest,
  userId?: string,
): Promise<{ context: WorkspaceContext; error?: never } | { context?: never; error: NextResponse }> {
  // Read enforce mode at REQUEST TIME — not import time
  const enforceMode = getEnforceMode();
  const { workspaces, memberships } = await loadWorkspaceData();

  // 1. Check X-Workspace-Id header (API clients)
  let workspaceId = req.headers.get('x-workspace-id');

  // 2. Check query parameter
  if (!workspaceId) {
    const url = new URL(req.url);
    workspaceId = url.searchParams.get('workspace_id');
  }

  // 3. Check workspace cookie
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
    // Unknown workspace — in permissive mode, fall back to default
    if (enforceMode === 'permissive') {
      console.warn(
        `[workspace-auth][permissive] Unknown workspace '${workspaceId}' for user '${userId ?? 'anonymous'}' — falling back to default-workspace`,
      );
      return { context: { ...DEFAULT_WORKSPACE } };
    }
    return {
      error: NextResponse.json(
        { error: 'Workspace not found', workspaceId },
        { status: 404 },
      ),
    };
  }

  // ── Membership enforcement ───────────────────────────────────────
  if (userId && workspaceId !== DEFAULT_WORKSPACE_ID) {
    const isMember =
      workspace.owner === userId ||
      memberships.some(
        (m) => m.workspaceId === workspaceId && m.userId === userId,
      );

    if (!isMember) {
      if (enforceMode === 'strict') {
        console.warn(
          `[workspace-auth][strict] 403: user '${userId}' not a member of workspace '${workspaceId}'`,
        );
        return {
          error: NextResponse.json(
            { error: 'Forbidden — not a member of this workspace' },
            { status: 403 },
          ),
        };
      }
      // Permissive: log and fall back to default
      console.warn(
        `[workspace-auth][permissive] Cross-workspace access: user '${userId}' requested workspace '${workspaceId}' but has no membership — falling back to default-workspace`,
      );
      return { context: { ...DEFAULT_WORKSPACE } };
    }
  }

  // For default-workspace, also verify membership if we're in strict mode
  if (userId && workspaceId === DEFAULT_WORKSPACE_ID && enforceMode === 'strict') {
    const isMember = memberships.some(
      (m) => m.workspaceId === DEFAULT_WORKSPACE_ID && m.userId === userId,
    );
    if (!isMember) {
      console.warn(
        `[workspace-auth][strict] 403: user '${userId}' not a member of default-workspace`,
      );
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

/**
 * Convenience: resolve a workspaceId for a request, with bootstrap fallback.
 *
 * Added for #1387 slice A.1. Use this when a handler only needs the
 * workspaceId string (e.g. to pass to `getStoreProvider(workspaceId)`) and
 * doesn't need the full WorkspaceContext or error response handling.
 *
 * Falls back to 'default-workspace' on any error (matches the
 * resolveRequestWorkspace pattern in src/app/api/store/route.ts).
 *
 * For request handlers that need to surface NotFound/Forbidden errors to
 * the client, use `resolveWorkspaceContext` directly instead.
 */
export async function resolveWorkspaceIdForRequest(req: NextRequest): Promise<string> {
  try {
    const { authenticateRequestWithContext } = await import('@/lib/auth');
    const authResult = await authenticateRequestWithContext(req);
    const userId = authResult.context?.userId ?? 'basil';
    const wsResult = await resolveWorkspaceContext(req, userId);
    if (wsResult.context) return wsResult.context.id;
  } catch {}
  return 'default-workspace';
}
