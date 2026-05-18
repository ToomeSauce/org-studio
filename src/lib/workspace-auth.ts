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
      const pg = await import('pg');
      const client = new pg.Client(dbUrl);
      await client.connect();
      try {
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
      } finally {
        await client.end();
      }
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

// ── #1387 Slice B: Workspace Role Gate ─────────────────────────────────

/**
 * Workspace role hierarchy. Higher index = more authority.
 * Mirrors the role column on `org_studio_workspace_memberships`.
 *
 * Current schema only has `owner | member`. `admin` is reserved for a future
 * migration that introduces a middle tier between owner and member; it is
 * currently aliased to `owner` for forward-compat gating logic (callers can
 * already write `requireRole: 'admin'` today; it will resolve to owner-only
 * until the schema is expanded).
 */
export const WORKSPACE_ROLE_ORDER = ['member', 'admin', 'owner'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLE_ORDER)[number];

/**
 * Return true if `actualRole` meets or exceeds `minRole` in the
 * WORKSPACE_ROLE_ORDER hierarchy. Unknown roles fail closed (return false).
 */
export function roleAtLeast(
  actualRole: string | null | undefined,
  minRole: WorkspaceRole,
): boolean {
  if (!actualRole) return false;
  const actualIdx = WORKSPACE_ROLE_ORDER.indexOf(actualRole as WorkspaceRole);
  const minIdx = WORKSPACE_ROLE_ORDER.indexOf(minRole);
  if (actualIdx === -1 || minIdx === -1) return false;
  return actualIdx >= minIdx;
}

/**
 * Result of a workspace-role check.
 *
 * - `allowed: true` with `via: 'session' | 'agent-token'` — caller has a real
 *   workspace membership meeting the role threshold.
 * - `allowed: true` with `via: 'break-glass'` — caller authenticated via the
 *   global ORG_STUDIO_API_KEY. The check passes for ops/incident use, but the
 *   caller should record an audit row (slice B.3) before mutating.
 * - `allowed: false` — caller is unauthenticated, has no membership in the
 *   target workspace, or has a membership below the required role. `reason`
 *   carries a short machine-readable code; `response` is a pre-built
 *   NextResponse the handler can return directly.
 */
export type WorkspaceRoleResult =
  | { allowed: true; via: 'session' | 'agent-token' | 'break-glass'; userId: string | null; role?: WorkspaceRole }
  | { allowed: false; reason: 'unauthenticated' | 'not-a-member' | 'insufficient-role'; response: NextResponse };

/**
 * #1387 Slice B — Workspace role gate.
 *
 * Resolve the caller's identity, look up their membership in `workspaceId`,
 * and check that their role meets `minRole`. Three caller identities are
 * supported, in this priority order:
 *
 *   1. **Session cookie** — resolves to a userId; role looked up in the
 *      `org_studio_workspace_memberships` table.
 *   2. **Per-agent API token** (#1383, behind ENABLE_PER_AGENT_TOKENS) —
 *      resolves to the token's owner userId; same membership lookup applies.
 *   3. **Global ORG_STUDIO_API_KEY** — break-glass. Passes the gate so
 *      incident response / Catpilot-internal ops keeps working, but the
 *      caller MUST record an audit-log entry (slice B.3 lands the table +
 *      logging helper). `via: 'break-glass'` makes this trivially detectable
 *      by the call site.
 *
 * Important semantics:
 *   - **No membership row → 403 not-a-member.** Even with a valid session,
 *     callers without a row in the target workspace are rejected.
 *   - **Role below threshold → 403 insufficient-role.** E.g. a `member`
 *     calling an `owner`-only endpoint.
 *   - **OSS mode** (no `org_studio_workspaces` table populated) — the lookup
 *     transparently treats every authenticated caller as `owner` of
 *     `default-workspace`. Identical to the existing `listUserWorkspaceMemberships`
 *     OSS fallback. This preserves zero-config behaviour for the OSS install.
 *
 * This function does NOT wire itself into any endpoint — slice B.2 does
 * that. Landing the helper first means slice B.2 can be a mechanical patch
 * with a clean rollback boundary.
 */
export async function requireWorkspaceRole(
  req: NextRequest,
  workspaceId: string,
  minRole: WorkspaceRole,
): Promise<WorkspaceRoleResult> {
  // Lazy import to avoid a circular dep with src/lib/auth.ts at module load.
  const { authenticateRequestWithContext } = await import('@/lib/auth');
  const authResult = await authenticateRequestWithContext(req);

  // Unauthenticated → 401, regardless of role.
  if (authResult.error || !authResult.context) {
    return {
      allowed: false,
      reason: 'unauthenticated',
      response: NextResponse.json(
        { error: 'unauthorized', message: 'Authentication required.' },
        { status: 401 },
      ),
    };
  }

  const ctx = authResult.context;

  // Break-glass: global API key. Pass, but flag for audit at the call site.
  if (ctx.method === 'apikey') {
    return { allowed: true, via: 'break-glass', userId: ctx.userId };
  }

  // Session or agent-token: look up real membership.
  const userId = ctx.userId;
  if (!userId) {
    // Auth succeeded but produced no userId — treat as unauthenticated.
    // (Currently only happens for method === 'noauth', which we don't want to
    // grant workspace authority to in cloud mode.)
    return {
      allowed: false,
      reason: 'unauthenticated',
      response: NextResponse.json(
        { error: 'unauthorized', message: 'Authentication required.' },
        { status: 401 },
      ),
    };
  }

  const { workspaces, memberships } = await loadWorkspaceData();

  // OSS mode: no workspaces loaded → treat caller as owner of default-workspace.
  // (Matches the existing OSS fallback in listUserWorkspaceMemberships.)
  if (!workspaces.length) {
    if (workspaceId === DEFAULT_WORKSPACE_ID) {
      const via: 'session' | 'agent-token' =
        ctx.method === 'agent-token' ? 'agent-token' : 'session';
      return { allowed: true, via, userId, role: 'owner' };
    }
    return {
      allowed: false,
      reason: 'not-a-member',
      response: NextResponse.json(
        { error: 'forbidden', message: `No membership in workspace '${workspaceId}'.` },
        { status: 403 },
      ),
    };
  }

  const membership = memberships.find(
    (m) => m.userId === userId && m.workspaceId === workspaceId,
  );

  if (!membership) {
    return {
      allowed: false,
      reason: 'not-a-member',
      response: NextResponse.json(
        { error: 'forbidden', message: `No membership in workspace '${workspaceId}'.` },
        { status: 403 },
      ),
    };
  }

  if (!roleAtLeast(membership.role, minRole)) {
    return {
      allowed: false,
      reason: 'insufficient-role',
      response: NextResponse.json(
        {
          error: 'forbidden',
          message: `Role '${membership.role}' is below required '${minRole}' for this action.`,
        },
        { status: 403 },
      ),
    };
  }

  const via: 'session' | 'agent-token' =
    ctx.method === 'agent-token' ? 'agent-token' : 'session';
  return { allowed: true, via, userId, role: membership.role as WorkspaceRole };
}
