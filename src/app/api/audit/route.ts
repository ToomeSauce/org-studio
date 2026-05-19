/**
 * /api/audit (#1390)
 *
 * GET — list admin audit rows for the caller's workspace.
 *
 * Gating: owner role on the caller's resolved workspace. Audit logs are
 * privileged data (who did what, when, via which auth path) and members
 * shouldn't see other members' actions. Global ORG_STUDIO_API_KEY passes
 * via break-glass (B.3) and that call itself is audited.
 *
 * Query params:
 *   limit       — default 50, max 200
 *   offset      — default 0 (created_at DESC pagination)
 *   action      — exact match filter (e.g. 'store.addTask')
 *   actionLike  — LIKE filter (e.g. 'store.%')
 *   via         — exact match: 'session' | 'agent-token' | 'break-glass'
 *   since       — ISO8601 timestamp lower bound on created_at
 *
 * Returns:
 *   { rows: AuditRow[], total: number, limit: number, offset: number, workspaceId: string }
 *
 * Silent no-op shape when DATABASE_URL is unset (OSS / file-mode):
 *   { rows: [], total: 0, limit, offset, workspaceId, disabled: 'file-mode' }
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireWorkspaceRole, resolveWorkspaceIdForRequest } from '@/lib/workspace-auth';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

// Per-module pool, lazily initialized. Matches the pattern used by
// admin-audit.ts, bootstrap-pings.ts, dispatch-attempts.ts (each module owns
// its small pool so import graphs stay flat).
let _pool: any = undefined; // undefined = not initialized, null = no DB
async function getPool(): Promise<any> {
  if (_pool !== undefined) return _pool;
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    _pool = null;
    return null;
  }
  try {
    const pg = await import('pg');
    const Pool = (pg as any).default?.Pool || (pg as any).Pool;
    _pool = new Pool({ connectionString: dbUrl, max: 2 });
    return _pool;
  } catch (e: any) {
    console.error('[audit] pg init failed:', e?.message || e);
    _pool = null;
    return null;
  }
}

export async function GET(req: NextRequest) {
  const workspaceId = await resolveWorkspaceIdForRequest(req);

  // Owner-only — audit is privileged.
  const roleCheck = await requireWorkspaceRole(req, workspaceId, 'owner');
  if (!roleCheck.allowed) return roleCheck.response;

  // Note: we do NOT call auditBreakGlassIfNeeded here. This is a READ
  // endpoint; per the B.3 design, only mutations get audited.

  const url = new URL(req.url);
  const limit = Math.min(
    Math.max(1, parseInt(url.searchParams.get('limit') || `${DEFAULT_LIMIT}`, 10) || DEFAULT_LIMIT),
    MAX_LIMIT,
  );
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
  const action = url.searchParams.get('action');
  const actionLike = url.searchParams.get('actionLike');
  const via = url.searchParams.get('via');
  const since = url.searchParams.get('since');

  // No DB → silent no-op (mirrors admin-audit.ts behavior in file-mode).
  const pool = await getPool();
  if (!pool) {
    return NextResponse.json({
      rows: [],
      total: 0,
      limit,
      offset,
      workspaceId,
      disabled: 'file-mode',
    });
  }

  // Build parameterized WHERE clause. workspace_id is always required.
  const where: string[] = ['workspace_id = $1'];
  const params: any[] = [workspaceId];
  let p = 2;
  if (action) {
    where.push(`action = $${p++}`);
    params.push(action);
  }
  if (actionLike) {
    where.push(`action LIKE $${p++}`);
    params.push(actionLike);
  }
  if (via) {
    if (!['session', 'agent-token', 'break-glass'].includes(via)) {
      return NextResponse.json(
        { error: 'invalid_via', message: "via must be 'session', 'agent-token', or 'break-glass'" },
        { status: 400 },
      );
    }
    where.push(`via = $${p++}`);
    params.push(via);
  }
  if (since) {
    const d = new Date(since);
    if (Number.isNaN(d.getTime())) {
      return NextResponse.json(
        { error: 'invalid_since', message: 'since must be a parseable ISO8601 timestamp' },
        { status: 400 },
      );
    }
    where.push(`created_at >= $${p++}`);
    params.push(d.toISOString());
  }

  const whereSql = where.join(' AND ');

  try {
    const countRes = await pool.query(
      `SELECT count(*)::text AS n FROM org_studio_admin_audit WHERE ${whereSql}`,
      params,
    );
    const total = parseInt(countRes.rows[0]?.n || '0', 10);

    const rowsRes = await pool.query(
      `SELECT id, workspace_id, user_id, action, endpoint, method, via, request_meta, created_at
       FROM org_studio_admin_audit
       WHERE ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT $${p++} OFFSET $${p++}`,
      [...params, limit, offset],
    );

    return NextResponse.json({
      rows: rowsRes.rows.map((r: any) => ({
        id: String(r.id),
        workspaceId: r.workspace_id,
        userId: r.user_id,
        action: r.action,
        endpoint: r.endpoint,
        method: r.method,
        via: r.via,
        requestMeta: r.request_meta,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      })),
      total,
      limit,
      offset,
      workspaceId,
    });
  } catch (e: any) {
    console.error('[audit] GET query error:', e?.message || e);
    return NextResponse.json(
      { error: 'query_failed', message: e?.message || 'unknown error' },
      { status: 500 },
    );
  }
}
