/**
 * #1513 — Postgres-backed durable dedup for comment notifications.
 *
 * Background: the in-process LRU in notification-router.ts (10-min TTL,
 * single-process map) was too fragile. Billy reproduced a duplicate fire
 * of source comment `cwfykbpwmpfshboi` arriving 10 min apart — landing
 * right at the LRU boundary. A service restart, a LISTEN reconnect, or
 * any second emit path zeroes the LRU and the same recipient gets paged
 * twice for the same comment.
 *
 * Fix: persist (idempotency_key) claims to Postgres with INSERT ... ON
 * CONFLICT DO NOTHING. First inserter wins; everyone else sees a no-op.
 * Survives restarts. Survives LRU resets. Survives multi-process emits.
 *
 * Schema:
 *   CREATE TABLE org_studio_notification_dedup (
 *     idempotency_key TEXT PRIMARY KEY,
 *     agent_id        TEXT NOT NULL,
 *     comment_id      TEXT NOT NULL,
 *     scope_kind      TEXT NOT NULL,
 *     delivered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
 *   );
 *
 * Pruned hourly: rows older than 7 days are deleted (the LRU's TTL was
 * 10 minutes — 7 days is generous and gives us a forensic trail for
 * "did this comment ever get notified?" questions Billy was asking).
 *
 * Audit table — sibling concern, lives in the same module to share the
 * pool. See ensureSchema() for its DDL.
 */

let _pool: any = null;
let _schemaReady = false;
let _schemaPromise: Promise<void> | null = null;
let _pgWarned = false;

function getPool(): any | null {
  if (_pool) return _pool;
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    if (!_pgWarned) {
      console.warn('[notify-dedup] DATABASE_URL not set; durable dedup disabled, in-process LRU only.');
      _pgWarned = true;
    }
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Pool } = require('pg');
    _pool = new Pool({ connectionString: dbUrl, max: 4 });
    return _pool;
  } catch (e) {
    if (!_pgWarned) {
      console.warn('[notify-dedup] pg module unavailable:', (e as Error)?.message);
      _pgWarned = true;
    }
    return null;
  }
}

async function ensureSchema(): Promise<void> {
  if (_schemaReady) return;
  if (_schemaPromise) return _schemaPromise;
  const pool = getPool();
  if (!pool) return;
  _schemaPromise = (async () => {
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS org_studio_notification_dedup (
          idempotency_key TEXT PRIMARY KEY,
          agent_id        TEXT NOT NULL,
          comment_id      TEXT NOT NULL,
          scope_kind      TEXT NOT NULL,
          delivered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS org_studio_notification_dedup_delivered_at_idx
          ON org_studio_notification_dedup (delivered_at);
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS org_studio_notification_audit (
          id                         BIGSERIAL PRIMARY KEY,
          occurred_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          comment_id                 TEXT NOT NULL,
          source_comment_created_at  TIMESTAMPTZ NULL,
          recipient_agent_id         TEXT NOT NULL,
          scope_kind                 TEXT NOT NULL,
          reason                     TEXT NOT NULL,
          outcome                    TEXT NOT NULL,
          skip_reason                TEXT NULL,
          source_age_ms              BIGINT NULL
        );
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS org_studio_notification_audit_occurred_at_idx
          ON org_studio_notification_audit (occurred_at);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS org_studio_notification_audit_comment_recipient_idx
          ON org_studio_notification_audit (comment_id, recipient_agent_id);
      `);
      _schemaReady = true;
    } finally {
      client.release();
    }
  })().catch((e) => {
    console.warn('[notify-dedup] schema ensure failed:', (e as Error)?.message);
    _schemaPromise = null;
  });
  return _schemaPromise;
}

/**
 * Try to claim an idempotency key. Returns true on FIRST claim, false on
 * any subsequent attempt for the same key. INSERT ... ON CONFLICT DO
 * NOTHING RETURNING is the atomic primitive.
 *
 * On Postgres unavailable / error: returns true (fail-open). The caller's
 * in-process LRU still suppresses the burst-duplicate case; we prefer
 * occasional duplicate notification over silent suppression.
 */
export async function tryClaim(
  idempotencyKey: string,
  agentId: string,
  commentId: string,
  scopeKind: string,
): Promise<boolean> {
  const pool = getPool();
  if (!pool) return true; // fail-open: no DB, no dedup
  try {
    await ensureSchema();
    const client = await pool.connect();
    try {
      const res = await client.query(
        `INSERT INTO org_studio_notification_dedup
           (idempotency_key, agent_id, comment_id, scope_kind)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING 1`,
        [idempotencyKey, agentId, commentId, scopeKind],
      );
      return res.rowCount === 1;
    } finally {
      client.release();
    }
  } catch (e) {
    console.warn('[notify-dedup] tryClaim failed; failing open:', (e as Error)?.message);
    return true;
  }
}

/**
 * Write one row to the audit log per dispatch decision (delivered or
 * skipped). Best-effort: never throws, never blocks delivery on failure.
 */
export interface AuditEntry {
  commentId: string;
  sourceCommentCreatedAt?: number | null;
  recipientAgentId: string;
  scopeKind: string;
  reason: string;
  outcome: 'delivered' | 'failed' | 'skipped';
  skipReason?: string | null;
  sourceAgeMs?: number | null;
}

export async function writeAudit(entry: AuditEntry): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  try {
    await ensureSchema();
    const client = await pool.connect();
    try {
      const createdAtIso =
        entry.sourceCommentCreatedAt && entry.sourceCommentCreatedAt > 0
          ? new Date(entry.sourceCommentCreatedAt).toISOString()
          : null;
      await client.query(
        `INSERT INTO org_studio_notification_audit
           (comment_id, source_comment_created_at, recipient_agent_id,
            scope_kind, reason, outcome, skip_reason, source_age_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          entry.commentId,
          createdAtIso,
          entry.recipientAgentId,
          entry.scopeKind,
          entry.reason,
          entry.outcome,
          entry.skipReason ?? null,
          entry.sourceAgeMs ?? null,
        ],
      );
    } finally {
      client.release();
    }
  } catch (e) {
    console.warn('[notify-audit] write failed:', (e as Error)?.message);
  }
}

/**
 * Hourly housekeeping. Removes dedup rows >7 days old and audit rows
 * >30 days old. Caller schedules with setInterval; see server.mjs.
 */
export async function prune(): Promise<{ dedupDeleted: number; auditDeleted: number }> {
  const pool = getPool();
  if (!pool) return { dedupDeleted: 0, auditDeleted: 0 };
  try {
    await ensureSchema();
    const client = await pool.connect();
    try {
      const d = await client.query(
        `DELETE FROM org_studio_notification_dedup
         WHERE delivered_at < NOW() - INTERVAL '7 days'`,
      );
      const a = await client.query(
        `DELETE FROM org_studio_notification_audit
         WHERE occurred_at < NOW() - INTERVAL '30 days'`,
      );
      return { dedupDeleted: d.rowCount || 0, auditDeleted: a.rowCount || 0 };
    } finally {
      client.release();
    }
  } catch (e) {
    console.warn('[notify-dedup] prune failed:', (e as Error)?.message);
    return { dedupDeleted: 0, auditDeleted: 0 };
  }
}

/** Test-only: reset module state. */
export function _resetForTests(): void {
  _pool = null;
  _schemaReady = false;
  _schemaPromise = null;
  _pgWarned = false;
}
