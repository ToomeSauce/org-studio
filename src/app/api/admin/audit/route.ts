/**
 * GET /api/admin/audit — query the comment audit log (#1508).
 *
 * Followup to #1506. #1506 began persisting `data.audit` JSONB on every
 * comment write (auth method, userId, token id, 16-hex apiKey hash,
 * requestIp, userAgent, *requestedAuthor* before canonicalization, capturedAt).
 * That metadata is stripped from all client read paths — there was no way to
 * inspect it without `psql`. This endpoint is that admin-only read window.
 *
 * Auth: admin-only (see isAdminRequest). Sensitive data (IPs, UAs, key
 * hashes) — global ORG_STUDIO_API_KEY is NOT enough, agent-tokens and
 * loopback noauth are NOT enough. Either:
 *   1. Bearer === ORG_STUDIO_ADMIN_API_KEY  (dedicated admin key), OR
 *   2. session whose userId is in ORG_STUDIO_ADMIN_USER_IDS allowlist.
 *
 * Workspace scope: comment rows have no workspace_id column. For task-scoped
 * comments we resolve workspace via JOIN to org_studio_tasks. Non-task scopes
 * pass through (those scopes — section/board/dmThread — are not yet
 * workspace-partitioned in this schema; expand here if/when they are).
 *
 * Filters (all optional, combinable): commentId, author, requestedAuthor,
 * apiKeyHash, taskId, since, until, limit (default 200, max 500), cursor.
 *
 * Cursor is base64(JSON([created_at, id])). Stable pagination via
 * (created_at, id) lex-compare, matching the ORDER BY.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequestWithContext, type AuthContext } from '@/lib/auth';
import { resolveWorkspaceIdForRequest } from '@/lib/workspace-auth';

export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

/**
 * Admin gate. Kept endpoint-local (not in src/lib/auth.ts) until a second
 * caller appears — premature centralization tends to bake in the wrong shape.
 *
 * Rejects: global apikey (shared infra, not human), agent-token, noauth.
 * Accepts: dedicated admin Bearer (ORG_STUDIO_ADMIN_API_KEY), or session
 * cookie whose userId is in ORG_STUDIO_ADMIN_USER_IDS.
 */
function isAdminRequest(req: NextRequest, authCtx: AuthContext): boolean {
  // Path 1: dedicated admin Bearer. Disabled (skipped, not errored) when env
  // var unset — operator may prefer the session-allowlist path only.
  const adminKey = process.env.ORG_STUDIO_ADMIN_API_KEY;
  if (adminKey && adminKey.length > 0) {
    const authHeader = req.headers.get('authorization') || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (bearer && bearer === adminKey) return true;
  }

  // Path 2: session cookie with allowlisted userId. agent-token, apikey, and
  // noauth are intentionally excluded even if the userId would match —
  // attribution through those paths is not strong enough for admin gating.
  if (authCtx.method === 'session' && authCtx.userId) {
    const allowlist = (process.env.ORG_STUDIO_ADMIN_USER_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (allowlist.includes(authCtx.userId)) return true;
  }

  return false;
}

interface AuditCursor {
  ts: number;
  id: string;
}

function encodeCursor(createdAt: number, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id])).toString('base64');
}

function decodeCursor(raw: string): AuditCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf-8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [ts, id] = parsed;
    const tsNum = typeof ts === 'string' ? parseInt(ts, 10) : ts;
    if (typeof tsNum !== 'number' || !Number.isFinite(tsNum)) return null;
    if (typeof id !== 'string' || id.length === 0) return null;
    return { ts: tsNum, id };
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  // Auth
  const authResult = await authenticateRequestWithContext(req);
  if (authResult.error) return authResult.error;
  if (!isAdminRequest(req, authResult.context)) {
    return NextResponse.json(
      {
        error: 'admin_required',
        message:
          'This endpoint requires admin auth. Set ORG_STUDIO_ADMIN_API_KEY or log in as an allowlisted admin user.',
      },
      { status: 403 },
    );
  }

  // DB required
  if (!process.env.DATABASE_URL) {
    return NextResponse.json(
      { error: 'database_required', message: 'admin audit requires DATABASE_URL.' },
      { status: 400 },
    );
  }

  // Parse query params
  const url = new URL(req.url);
  const q = url.searchParams;
  const commentId = q.get('commentId') || undefined;
  const author = q.get('author') || undefined;
  const requestedAuthor = q.get('requestedAuthor') || undefined;
  const apiKeyHash = q.get('apiKeyHash') || undefined;
  const taskId = q.get('taskId') || undefined;
  const sinceRaw = q.get('since');
  const untilRaw = q.get('until');
  const limitRaw = q.get('limit');
  const cursorRaw = q.get('cursor');

  let limit = DEFAULT_LIMIT;
  if (limitRaw !== null) {
    const parsed = parseInt(limitRaw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return NextResponse.json(
        { error: 'invalid_limit', message: `limit must be a positive integer (1..${MAX_LIMIT})` },
        { status: 400 },
      );
    }
    if (parsed > MAX_LIMIT) {
      return NextResponse.json(
        { error: 'invalid_limit', message: `limit exceeds hard maximum of ${MAX_LIMIT}` },
        { status: 400 },
      );
    }
    limit = parsed;
  }

  let cursor: AuditCursor | null = null;
  if (cursorRaw) {
    cursor = decodeCursor(cursorRaw);
    if (!cursor) {
      return NextResponse.json(
        { error: 'invalid_cursor', message: 'cursor is malformed (expected base64 of JSON [createdAt, id])' },
        { status: 400 },
      );
    }
  }

  const since = sinceRaw !== null ? parseInt(sinceRaw, 10) : null;
  const until = untilRaw !== null ? parseInt(untilRaw, 10) : null;
  if (sinceRaw !== null && (!Number.isFinite(since) || since === null)) {
    return NextResponse.json(
      { error: 'invalid_since', message: 'since must be unix ms (integer)' },
      { status: 400 },
    );
  }
  if (untilRaw !== null && (!Number.isFinite(until) || until === null)) {
    return NextResponse.json(
      { error: 'invalid_until', message: 'until must be unix ms (integer)' },
      { status: 400 },
    );
  }

  const workspaceId = await resolveWorkspaceIdForRequest(req);

  // Build parameterized WHERE.
  // We LEFT JOIN org_studio_tasks so we can scope task-scoped comments by
  // workspace. Non-task comments (no task_id) bypass the workspace filter —
  // their parents aren't workspace-partitioned in the current schema.
  const where: string[] = [];
  const params: any[] = [];
  const p = (v: any) => {
    params.push(v);
    return `$${params.length}`;
  };

  where.push(`(c.task_id IS NULL OR t.workspace_id = ${p(workspaceId)})`);

  if (commentId) where.push(`c.id = ${p(commentId)}`);
  if (author) where.push(`c.author = ${p(author)}`);
  if (requestedAuthor) where.push(`c.data->'audit'->>'requestedAuthor' = ${p(requestedAuthor)}`);
  if (apiKeyHash) where.push(`c.data->'audit'->>'apiKeyHash' = ${p(apiKeyHash)}`);
  if (taskId) where.push(`c.task_id = ${p(taskId)}`);
  if (since !== null) where.push(`c.created_at >= ${p(since)}`);
  if (until !== null) where.push(`c.created_at <= ${p(until)}`);
  if (cursor) {
    // (created_at, id) < (cursor.ts, cursor.id) — row-wise comparison for
    // strictly-after-the-cursor pagination under ORDER BY created_at DESC, id DESC.
    where.push(`(c.created_at, c.id) < (${p(cursor.ts)}, ${p(cursor.id)})`);
  }

  // Over-fetch by one to detect truncation cheaply.
  const fetchLimit = limit + 1;
  const sql = `
    SELECT c.id, c.scope_kind, c.task_id, c.section_id, c.board_project_id, c.dm_thread_id,
           c.author, c.content, c.created_at, c.data
      FROM org_studio_comments c
      LEFT JOIN org_studio_tasks t ON t.id = c.task_id
     WHERE ${where.join(' AND ')}
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT ${p(fetchLimit)}
  `;

  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    const rows: any[] = result.rows;
    const truncated = rows.length > limit;
    const pageRows = truncated ? rows.slice(0, limit) : rows;

    const comments = pageRows.map((row) => {
      const data = row.data && typeof row.data === 'object' ? row.data : {};
      const audit = data.audit && typeof data.audit === 'object' ? data.audit : null;
      const createdAt = typeof row.created_at === 'string' ? parseInt(row.created_at, 10) : row.created_at;
      return {
        id: row.id,
        scope: {
          kind: row.scope_kind,
          taskId: row.task_id || undefined,
          sectionId: row.section_id || undefined,
          boardProjectId: row.board_project_id || undefined,
          dmThreadId: row.dm_thread_id || undefined,
        },
        author: row.author,
        requestedAuthor: audit?.requestedAuthor ?? null,
        content: row.content,
        createdAt,
        audit,
      };
    });

    const last = pageRows[pageRows.length - 1];
    const nextCursor = truncated && last
      ? encodeCursor(typeof last.created_at === 'string' ? parseInt(last.created_at, 10) : last.created_at, last.id)
      : null;

    return NextResponse.json({
      comments,
      count: comments.length,
      truncated,
      nextCursor,
    });
  } catch (err: any) {
    if (err?.code === '42P01') {
      // Table doesn't exist — return empty rather than 500.
      return NextResponse.json({ comments: [], count: 0, truncated: false, nextCursor: null });
    }
    console.error('[admin/audit #1508]', err);
    return NextResponse.json({ error: 'query_failed', message: err?.message ?? 'unknown error' }, { status: 500 });
  } finally {
    client.release();
    await pool.end();
  }
}
