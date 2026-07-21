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
 * Fix: persist (idempotency_key) delivery leases to Postgres. One process
 * owns a short pending lease; successful runtime handoff completes it as a
 * durable delivered row, while failure releases it and process crashes expire.
 * Survives restarts, LRU resets, multi-process emits, and runtime outages.
 *
 * Schema:
 *   CREATE TABLE org_studio_notification_dedup (
 *     idempotency_key TEXT PRIMARY KEY,
 *     agent_id        TEXT NOT NULL,
 *     comment_id      TEXT NOT NULL,
 *     scope_kind      TEXT NOT NULL,
 *     delivered_at    TIMESTAMPTZ NULL,
 *     claim_state     TEXT NOT NULL DEFAULT 'delivered',
 *     claim_token     TEXT NULL,
 *     claim_expires_at TIMESTAMPTZ NULL
 *   );
 *
 * Pruned hourly: rows older than 7 days are deleted (the LRU's TTL was
 * 10 minutes — 7 days is generous and gives us a forensic trail for
 * "did this comment ever get notified?" questions Billy was asking).
 *
 * Audit table — sibling concern, lives in the same module to share the
 * pool. See ensureSchema() for its DDL.
 */

import { randomUUID } from 'node:crypto';

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
          delivered_at    TIMESTAMPTZ NULL,
          claim_state     TEXT NOT NULL DEFAULT 'delivered',
          claim_token     TEXT NULL,
          claim_expires_at TIMESTAMPTZ NULL
        );
      `);
      // Existing rows predate delivery leases and already represent completed
      // notifications. Additive migration keeps them delivered while allowing
      // new rows to stay pending until runtime handoff succeeds.
      await client.query(`
        ALTER TABLE org_studio_notification_dedup
          ADD COLUMN IF NOT EXISTS claim_state TEXT NOT NULL DEFAULT 'delivered',
          ADD COLUMN IF NOT EXISTS claim_token TEXT NULL,
          ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ NULL;
      `);
      await client.query(`
        ALTER TABLE org_studio_notification_dedup
          ALTER COLUMN delivered_at DROP NOT NULL,
          ALTER COLUMN delivered_at DROP DEFAULT;
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS org_studio_notification_dedup_delivered_at_idx
          ON org_studio_notification_dedup (delivered_at);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS org_studio_notification_dedup_claim_expires_at_idx
          ON org_studio_notification_dedup (claim_expires_at)
          WHERE claim_state = 'pending';
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

const CLAIM_LEASE_MS = 2 * 60 * 1000;

export interface NotificationClaim {
  acquired: boolean;
  token: string | null;
}

/**
 * Acquire a short delivery lease for an idempotency key. A pending lease is
 * not a delivered notification: only completeClaim() records delivered_at.
 * Expired leases may be taken over after a process crash.
 *
 * On Postgres unavailable / error this fails open with an ephemeral token.
 * The runtime's own idempotency key and the process-local LRU remain the
 * fallback; occasional duplicates are preferable to silently losing a human
 * comment.
 */
export async function acquireClaim(
  idempotencyKey: string,
  agentId: string,
  commentId: string,
  scopeKind: string,
): Promise<NotificationClaim> {
  const token = randomUUID();
  const pool = getPool();
  if (!pool) return { acquired: true, token };
  try {
    await ensureSchema();
    const client = await pool.connect();
    try {
      const res = await client.query(
        `INSERT INTO org_studio_notification_dedup
           (idempotency_key, agent_id, comment_id, scope_kind, delivered_at,
            claim_state, claim_token, claim_expires_at)
         VALUES ($1, $2, $3, $4, NULL, 'pending', $5,
                 NOW() + ($6 * INTERVAL '1 millisecond'))
         ON CONFLICT (idempotency_key) DO UPDATE
           SET agent_id = EXCLUDED.agent_id,
               comment_id = EXCLUDED.comment_id,
               scope_kind = EXCLUDED.scope_kind,
               delivered_at = NULL,
               claim_state = 'pending',
               claim_token = EXCLUDED.claim_token,
               claim_expires_at = EXCLUDED.claim_expires_at
         WHERE org_studio_notification_dedup.claim_state = 'pending'
           AND org_studio_notification_dedup.claim_expires_at < NOW()
         RETURNING claim_token`,
        [idempotencyKey, agentId, commentId, scopeKind, token, CLAIM_LEASE_MS],
      );
      return { acquired: res.rowCount === 1, token: res.rowCount === 1 ? token : null };
    } finally {
      client.release();
    }
  } catch (e) {
    console.warn('[notify-dedup] acquireClaim failed; failing open:', (e as Error)?.message);
    return { acquired: true, token };
  }
}

/** Mark the caller's pending lease delivered after runtime handoff succeeds. */
export async function completeClaim(idempotencyKey: string, token: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return true;
  try {
    await ensureSchema();
    const res = await pool.query(
      `UPDATE org_studio_notification_dedup
          SET claim_state = 'delivered',
              delivered_at = NOW(),
              claim_token = NULL,
              claim_expires_at = NULL
        WHERE idempotency_key = $1
          AND claim_state = 'pending'
          AND claim_token = $2
        RETURNING 1`,
      [idempotencyKey, token],
    );
    return res.rowCount === 1;
  } catch (e) {
    console.warn('[notify-dedup] completeClaim failed:', (e as Error)?.message);
    return false;
  }
}

/**
 * Release only the caller's pending lease after both runtime delivery paths
 * fail. A replay may then acquire and retry; a stale caller cannot delete a
 * newer lease because the random token must still match.
 */
export async function releaseClaim(idempotencyKey: string, token: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return true;
  try {
    await ensureSchema();
    const res = await pool.query(
      `DELETE FROM org_studio_notification_dedup
        WHERE idempotency_key = $1
          AND claim_state = 'pending'
          AND claim_token = $2
        RETURNING 1`,
      [idempotencyKey, token],
    );
    return res.rowCount === 1;
  } catch (e) {
    console.warn('[notify-dedup] releaseClaim failed:', (e as Error)?.message);
    return false;
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
         WHERE (claim_state = 'delivered' AND delivered_at < NOW() - INTERVAL '7 days')
            OR (claim_state = 'pending' AND claim_expires_at < NOW() - INTERVAL '1 day')`,
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

/** Test-only: inject a fake pool after schema setup. */
export function _setPoolForTests(pool: any): void {
  _pool = pool;
  _schemaReady = true;
  _schemaPromise = null;
}

/** Test-only: reset module state. */
export function _resetForTests(): void {
  _pool = null;
  _schemaReady = false;
  _schemaPromise = null;
  _pgWarned = false;
}
