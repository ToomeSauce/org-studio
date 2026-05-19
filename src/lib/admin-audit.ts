/**
 * admin-audit.ts — append-only audit log for break-glass admin actions.
 *
 * Called from B.2-gated endpoints (and any future privileged endpoint) when
 * the request is being allowed via the break-glass path (global
 * ORG_STUDIO_API_KEY) instead of a real user session or per-agent token.
 *
 * Design notes (B.3, #1387):
 *  - Never throws. Audit failures must not break the endpoint. Failure to
 *    write an audit row is logged to stderr and swallowed.
 *  - Silent no-op when DATABASE_URL is not set (OSS/file-mode). File-mode
 *    has no multi-user surface to audit against.
 *  - Append-only. No update/delete API exposed from this module.
 *  - Best effort. Fire-and-forget from the request handler.
 *
 * Reversibility: this module is purely additive. The migration that
 * creates the table is reversible (DROP TABLE). Removing call sites is
 * a one-line revert per endpoint.
 *
 * Future work (out of B.3 scope):
 *  - Periodic export to S3/append-only sink.
 *  - UI surface in Settings for owners to browse their workspace's audit.
 *  - Rate-limited per-action retention pruning if the table grows.
 */

import type { NextRequest } from 'next/server';

let _pool: any = undefined; // undefined = not yet initialized, null = no DB

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
    _pool = new Pool({ connectionString: dbUrl, max: 3 });
    return _pool;
  } catch (e: any) {
    console.error('[AdminAudit] Failed to create pool:', e?.message);
    _pool = null;
    return null;
  }
}

export type AdminAuditVia = 'session' | 'agent-token' | 'break-glass';

export interface AdminAuditEntry {
  workspaceId: string;
  userId: string | null; // null is valid for break-glass with no underlying user
  action: string; // e.g. 'backups.restore', 'vision.doc.put'
  endpoint: string; // URL pathname
  method: string; // HTTP method
  via: AdminAuditVia;
  requestMeta?: Record<string, unknown>;
}

/**
 * Append an audit row. Best-effort, never throws.
 * Returns true if a row was written, false otherwise (no DB, or write failed).
 */
export async function writeAdminAudit(entry: AdminAuditEntry): Promise<boolean> {
  try {
    const pool = await getPool();
    if (!pool) return false;
    await pool.query(
      `INSERT INTO org_studio_admin_audit
         (workspace_id, user_id, action, endpoint, method, via, request_meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.workspaceId,
        entry.userId,
        entry.action,
        entry.endpoint,
        entry.method,
        entry.via,
        entry.requestMeta ? JSON.stringify(entry.requestMeta) : null,
      ],
    );
    return true;
  } catch (e: any) {
    // Failure must not break the calling endpoint — caller can't recover anyway.
    console.error('[AdminAudit] write failed:', e?.message, 'entry=', {
      action: entry.action,
      via: entry.via,
      workspaceId: entry.workspaceId,
    });
    return false;
  }
}

/**
 * Convenience wrapper for B.2 endpoints — called after requireWorkspaceRole
 * returns allowed=true. Records the action ONLY when via='break-glass'; the
 * session and agent-token paths are recorded by their respective auth layers
 * (session tracking + per-agent token usage rows).
 *
 * Pass the NextRequest so we can capture URL/method/IP/UA without each call
 * site having to thread them.
 */
export async function auditBreakGlassIfNeeded(opts: {
  req: NextRequest;
  workspaceId: string;
  via: AdminAuditVia;
  userId: string | null;
  action: string;
}): Promise<void> {
  if (opts.via !== 'break-glass') return;
  const url = new URL(opts.req.url);
  await writeAdminAudit({
    workspaceId: opts.workspaceId,
    userId: opts.userId,
    action: opts.action,
    endpoint: url.pathname,
    method: opts.req.method,
    via: opts.via,
    requestMeta: {
      userAgent: opts.req.headers.get('user-agent') || undefined,
      // x-forwarded-for is the standard proxy header on Azure Container Apps.
      // Falls back to undefined for direct local calls.
      ip: opts.req.headers.get('x-forwarded-for') || undefined,
    },
  });
}
