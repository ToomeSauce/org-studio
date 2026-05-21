/**
 * GET /api/admin/notification-health — observability dashboard for the
 * comment-notification dispatch path (#1513-followup-2 / #1516).
 *
 * Aggregates over `org_studio_notification_audit` (table created by
 * src/lib/notification-dedup.ts — written by routeCommentNotifications on
 * every dispatch decision, delivered or skipped).
 *
 * Response shape (JSON):
 *   {
 *     ok: true,
 *     window: { hours: 24, from: iso, to: iso },
 *     latency: {
 *       delivered: { p50_ms, p95_ms, count },
 *       skipped:   { p50_ms, p95_ms, count }       // only rows with non-null source_age_ms
 *     },
 *     hourly: [{ hour: iso, delivered, skipped }]  // last 24 hours, bucketed
 *     skipReasons: [{ reason, count }]             // last 24h, descending
 *     recent: [{ ...audit_row }]                   // last 50 rows, newest first
 *   }
 *
 * Auth: admin-only (mirrors /api/admin/audit gate from #1508). Two paths:
 *   1. Bearer === ORG_STUDIO_ADMIN_API_KEY (dedicated admin Bearer)
 *   2. session whose userId is in ORG_STUDIO_ADMIN_USER_IDS allowlist
 * Global ORG_STUDIO_API_KEY and agent-tokens are not accepted (this surfaces
 * recipient_agent_id activity — agent tokens shouldn't see other agents'
 * dispatch patterns).
 *
 * Read-only. No mutations. Pure SQL aggregates over an existing audit table.
 *
 * Gate centralization (note for #1517 TBD): this is the 2nd copy of the
 * admin-gate helper — first lives in /api/admin/audit. When a 3rd caller
 * appears, factor into src/lib/admin-auth.ts. Premature centralization risks
 * baking in a 2-caller shape that's wrong for the 3rd; keep duplicated.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequestWithContext, type AuthContext } from '@/lib/auth';

export const dynamic = 'force-dynamic';

let _pool: any = null;
let _pgWarned = false;

function getPool(): any | null {
  if (_pool) return _pool;
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    if (!_pgWarned) {
      console.warn('[notification-health #1516] DATABASE_URL not set');
      _pgWarned = true;
    }
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Pool } = require('pg');
    _pool = new Pool({ connectionString: dbUrl, max: 2 });
    return _pool;
  } catch (e) {
    if (!_pgWarned) {
      console.warn('[notification-health #1516] pg unavailable:', (e as Error)?.message);
      _pgWarned = true;
    }
    return null;
  }
}

async function loadAuthContextForAdminGate(req: NextRequest): Promise<AuthContext> {
  const r = await authenticateRequestWithContext(req);
  if (r.error) return { userId: null, method: 'noauth' };
  return r.context;
}

function isAdminRequest(req: NextRequest, authCtx: AuthContext): boolean {
  const adminKey = process.env.ORG_STUDIO_ADMIN_API_KEY;
  if (adminKey && adminKey.length > 0) {
    const authHeader = req.headers.get('authorization') || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (bearer && bearer === adminKey) return true;
  }
  if (authCtx.method === 'session' && authCtx.userId) {
    const allowlist = (process.env.ORG_STUDIO_ADMIN_USER_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (allowlist.includes(authCtx.userId)) return true;
  }
  return false;
}

export async function GET(req: NextRequest) {
  const authCtx = await loadAuthContextForAdminGate(req);
  if (!isAdminRequest(req, authCtx)) {
    return NextResponse.json(
      {
        error: 'admin_required',
        message:
          'This endpoint requires admin auth. Set ORG_STUDIO_ADMIN_API_KEY or log in as an allowlisted admin user.',
      },
      { status: 403 },
    );
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json(
      { error: 'database_required', message: 'notification-health requires DATABASE_URL.' },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  // Window override — default 24h, max 168h (1 week). Bounded to prevent
  // accidental full-table scans on a growing audit log.
  const hoursRaw = parseInt(url.searchParams.get('hours') || '24', 10);
  const hours = Number.isFinite(hoursRaw) && hoursRaw > 0 ? Math.min(hoursRaw, 168) : 24;

  const client = await pool.connect();
  try {
    // (1) Latency p50/p95 split by outcome. Only rows with non-null
    // source_age_ms — older audit rows (pre-#1513) may lack it.
    const latencySql = `
      SELECT
        outcome,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY source_age_ms) AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY source_age_ms) AS p95,
        COUNT(*)::bigint AS n
      FROM org_studio_notification_audit
      WHERE occurred_at >= NOW() - ($1 || ' hours')::interval
        AND source_age_ms IS NOT NULL
      GROUP BY outcome
    `;
    const latencyRows = (await client.query(latencySql, [String(hours)])).rows;

    const latency: Record<string, any> = {
      delivered: { p50_ms: null, p95_ms: null, count: 0 },
      skipped: { p50_ms: null, p95_ms: null, count: 0 },
    };
    for (const r of latencyRows) {
      const key = r.outcome === 'delivered' ? 'delivered' : r.outcome === 'skipped' ? 'skipped' : null;
      if (!key) continue;
      latency[key] = {
        p50_ms: r.p50 !== null ? Number(r.p50) : null,
        p95_ms: r.p95 !== null ? Number(r.p95) : null,
        count: Number(r.n),
      };
    }

    // (2) Hourly delivered-vs-skipped, last N hours, ascending. Uses
    // generate_series to fill gaps (hours with zero traffic still appear).
    const hourlySql = `
      WITH hours AS (
        SELECT generate_series(
          date_trunc('hour', NOW() - ($1 || ' hours')::interval),
          date_trunc('hour', NOW()),
          interval '1 hour'
        ) AS hour
      ),
      agg AS (
        SELECT
          date_trunc('hour', occurred_at) AS hour,
          SUM(CASE WHEN outcome = 'delivered' THEN 1 ELSE 0 END)::bigint AS delivered,
          SUM(CASE WHEN outcome = 'skipped' THEN 1 ELSE 0 END)::bigint AS skipped
        FROM org_studio_notification_audit
        WHERE occurred_at >= NOW() - ($1 || ' hours')::interval
        GROUP BY 1
      )
      SELECT
        hours.hour,
        COALESCE(agg.delivered, 0)::bigint AS delivered,
        COALESCE(agg.skipped, 0)::bigint AS skipped
      FROM hours
      LEFT JOIN agg ON agg.hour = hours.hour
      ORDER BY hours.hour ASC
    `;
    const hourlyRows = (await client.query(hourlySql, [String(hours)])).rows.map((r: any) => ({
      hour: r.hour instanceof Date ? r.hour.toISOString() : String(r.hour),
      delivered: Number(r.delivered),
      skipped: Number(r.skipped),
    }));

    // (3) Skip-reason breakdown
    const skipSql = `
      SELECT skip_reason AS reason, COUNT(*)::bigint AS count
      FROM org_studio_notification_audit
      WHERE occurred_at >= NOW() - ($1 || ' hours')::interval
        AND outcome = 'skipped'
        AND skip_reason IS NOT NULL
      GROUP BY skip_reason
      ORDER BY count DESC
    `;
    const skipRows = (await client.query(skipSql, [String(hours)])).rows.map((r: any) => ({
      reason: r.reason,
      count: Number(r.count),
    }));

    // (4) Recent 50 rows, newest first
    const recentSql = `
      SELECT id, occurred_at, comment_id, source_comment_created_at,
             recipient_agent_id, scope_kind, reason, outcome, skip_reason,
             source_age_ms
      FROM org_studio_notification_audit
      ORDER BY occurred_at DESC, id DESC
      LIMIT 50
    `;
    const recentRows = (await client.query(recentSql)).rows.map((r: any) => ({
      id: String(r.id),
      occurred_at: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : String(r.occurred_at),
      comment_id: r.comment_id,
      source_comment_created_at:
        r.source_comment_created_at instanceof Date
          ? r.source_comment_created_at.toISOString()
          : r.source_comment_created_at,
      recipient_agent_id: r.recipient_agent_id,
      scope_kind: r.scope_kind,
      reason: r.reason,
      outcome: r.outcome,
      skip_reason: r.skip_reason,
      source_age_ms: r.source_age_ms !== null ? Number(r.source_age_ms) : null,
    }));

    const now = new Date();
    const from = new Date(now.getTime() - hours * 3600 * 1000);

    return NextResponse.json({
      ok: true,
      window: { hours, from: from.toISOString(), to: now.toISOString() },
      latency,
      hourly: hourlyRows,
      skipReasons: skipRows,
      recent: recentRows,
    });
  } catch (err: any) {
    console.error('[notification-health #1516] query failed:', err?.message || err);
    return NextResponse.json(
      { error: 'query_failed', message: err?.message || 'Unknown error' },
      { status: 500 },
    );
  } finally {
    client.release();
  }
}
