/**
 * outbox.mjs — Outbox + retries for gateway sends (server-side, ESM)
 *
 * Provides:
 *   ensureOutboxSchema()  — creates org_studio_outbox table + indexes
 *   startOutboxWorker()   — acquires advisory lock, drains outbox, prunes sent rows
 *
 * Called from server.mjs at startup. Postgres-only; silently no-ops in file mode.
 *
 * Architecture: The worker picks pending rows and POSTs to an internal
 * /api/outbox/drain endpoint (Next.js TS) that has access to sendToAgent.
 * This avoids mjs→ts runtime import complexity.
 */

import crypto from 'node:crypto';

const TAG = '[Outbox]';

// --- Pool management (same pattern as heartbeats.mjs) ---
let _pool = undefined; // undefined = not yet initialized, null = no DB

async function getPool() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return null;
  try {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: dbUrl, max: 3 });
    return pool;
  } catch (e) {
    console.error(`${TAG} Failed to create pool:`, e.message);
    return null;
  }
}

async function pool() {
  if (_pool === undefined) {
    _pool = await getPool();
  }
  return _pool;
}

/**
 * Create outbox table + indexes if they don't exist.
 */
export async function ensureOutboxSchema() {
  const p = await pool();
  if (!p) {
    console.log(`${TAG} Disabled (file mode — Postgres required)`);
    return;
  }

  const client = await p.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS org_studio_outbox (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE NOT NULL,
        agent_id TEXT NOT NULL,
        payload JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INT NOT NULL DEFAULT 0,
        last_error TEXT,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        sent_at TIMESTAMPTZ
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_outbox_status_next
        ON org_studio_outbox(status, next_attempt_at)
        WHERE status IN ('pending', 'sending');
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_outbox_sent_at
        ON org_studio_outbox(sent_at)
        WHERE status = 'sent';
    `);

    console.log(`${TAG} Schema ensured (outbox table + indexes)`);
  } finally {
    client.release();
  }
}

/**
 * Log an incident to org_studio_incidents (same table used by heartbeats).
 */
async function logIncident({ type, agentId, message, context }) {
  const p = await pool();
  if (!p) return;

  try {
    await p.query(
      `INSERT INTO org_studio_incidents (id, timestamp, type, agent_id, message, context)
       VALUES ($1, NOW(), $2, $3, $4, $5)`,
      [crypto.randomUUID(), type, agentId, message, context ? JSON.stringify(context) : null]
    );
  } catch (e) {
    console.error(`${TAG} Failed to log incident:`, e.message);
  }
}

/**
 * Reclaim rows stuck in 'sending' state (e.g. after worker crash mid-send).
 * Safe because idempotency keys prevent double-delivery.
 */
async function reclaimStuckSending() {
  const p = await pool();
  if (!p) return;

  try {
    const { rowCount } = await p.query(`
      UPDATE org_studio_outbox
      SET status = 'pending', updated_at = NOW()
      WHERE status = 'sending'
    `);
    if (rowCount > 0) {
      console.log(`${TAG} Reclaimed ${rowCount} stuck 'sending' row(s) → pending`);
    }
  } catch (e) {
    console.error(`${TAG} Reclaim failed:`, e.message);
  }
}

// Backoff delays in ms: attempt 1 → 1s, attempt 2 → 2s, attempt 3 → 4s (then dead-letter)
const BACKOFF_DELAYS = [1000, 2000, 4000, 8000];
const MAX_ATTEMPTS = 3;

/**
 * Drain one batch of pending outbox rows.
 * For each row: mark sending → call internal drain endpoint → mark sent or increment failure.
 */
async function drainBatch(baseUrl, apiKey) {
  const p = await pool();
  if (!p) return;

  try {
    // Pick up to 10 pending rows ready to be sent
    const { rows } = await p.query(`
      SELECT id, idempotency_key, agent_id, payload, attempts, status
      FROM org_studio_outbox
      WHERE status = 'pending' AND next_attempt_at <= NOW()
      ORDER BY next_attempt_at ASC
      LIMIT 10
    `);

    if (rows.length === 0) return;

    for (const row of rows) {
      // Mark as sending (atomic — prevents other workers from picking it up)
      const { rowCount } = await p.query(
        `UPDATE org_studio_outbox SET status = 'sending', updated_at = NOW() WHERE id = $1 AND status = 'pending'`,
        [row.id]
      );
      if (rowCount === 0) continue; // another worker grabbed it

      try {
        // Call the internal drain endpoint (Next.js TS side)
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

        const resp = await fetch(`${baseUrl}/api/outbox/drain`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            outboxId: row.id,
            agentId: row.agent_id,
            idempotencyKey: row.idempotency_key,
            payload: row.payload,
          }),
        });

        if (!resp.ok) {
          const errText = await resp.text().catch(() => 'unknown');
          throw new Error(`HTTP ${resp.status}: ${errText}`);
        }

        // Success — mark as sent
        await p.query(
          `UPDATE org_studio_outbox SET status = 'sent', sent_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [row.id]
        );
      } catch (sendErr) {
        // Failure — increment attempts, compute next delay or dead-letter
        const newAttempts = row.attempts + 1;
        const errorMsg = sendErr?.message || String(sendErr);

        if (newAttempts >= MAX_ATTEMPTS) {
          // Dead letter
          await p.query(
            `UPDATE org_studio_outbox SET status = 'dead_letter', attempts = $2, last_error = $3, updated_at = NOW() WHERE id = $1`,
            [row.id, newAttempts, errorMsg]
          );

          // Log incident
          await logIncident({
            type: 'outbox_dead_letter',
            agentId: row.agent_id,
            message: `Outbox send failed after ${newAttempts} attempts: ${errorMsg}`,
            context: {
              outboxId: row.id,
              idempotencyKey: row.idempotency_key,
              payload: row.payload,
              lastError: errorMsg,
              attempts: newAttempts,
            },
          });

          console.error(`${TAG} Dead letter: ${row.agent_id} (${row.id}) after ${newAttempts} attempts — ${errorMsg}`);
        } else {
          // Schedule retry with exponential backoff
          const delayMs = BACKOFF_DELAYS[newAttempts - 1] || BACKOFF_DELAYS[BACKOFF_DELAYS.length - 1];
          await p.query(
            `UPDATE org_studio_outbox SET status = 'pending', attempts = $2, last_error = $3, next_attempt_at = NOW() + INTERVAL '1 millisecond' * $4, updated_at = NOW() WHERE id = $1`,
            [row.id, newAttempts, errorMsg, delayMs]
          );

          console.warn(`${TAG} Send failed for ${row.agent_id} (attempt ${newAttempts}/${MAX_ATTEMPTS}), retry in ${delayMs}ms — ${errorMsg}`);
        }
      }
    }
  } catch (e) {
    console.error(`${TAG} Drain batch error:`, e.message);
  }
}

/**
 * Prune sent rows older than 24 hours.
 */
async function pruneSent() {
  const p = await pool();
  if (!p) return;

  try {
    const { rowCount } = await p.query(`
      DELETE FROM org_studio_outbox
      WHERE status = 'sent' AND sent_at < NOW() - INTERVAL '24 hours'
    `);
    if (rowCount > 0) {
      console.log(`${TAG} Pruned ${rowCount} sent row(s) older than 24h`);
    }
  } catch (e) {
    console.error(`${TAG} Prune error:`, e.message);
  }
}

/**
 * Start the outbox worker. Acquires a Postgres advisory lock to ensure
 * only one worker instance runs.
 *
 * @param {Object} opts
 * @param {number} opts.tickMs - Drain interval (default 500ms)
 * @param {number} opts.pruneMs - Prune interval (default 1 hour)
 */
export function startOutboxWorker({ tickMs = 500, pruneMs = 60 * 60 * 1000 } = {}) {
  const p_check = pool(); // warm pool

  const apiKey = process.env.ORG_STUDIO_API_KEY || '';
  const baseUrl = `http://127.0.0.1:${process.env.PORT || '4501'}`;

  let drainHandle = null;
  let pruneHandle = null;
  let lockCheckHandle = null;
  let hasLock = false;

  async function tryAcquireLock() {
    const p = await pool();
    if (!p) {
      console.log(`${TAG} Disabled (file mode — Postgres required)`);
      return false;
    }

    try {
      // Use hashtext('org_studio_outbox_worker') for a stable advisory lock key
      const { rows } = await p.query(`SELECT pg_try_advisory_lock(hashtext('org_studio_outbox_worker')) AS acquired`);
      return rows[0]?.acquired === true;
    } catch (e) {
      console.error(`${TAG} Advisory lock check failed:`, e.message);
      return false;
    }
  }

  async function start() {
    const acquired = await tryAcquireLock();
    if (!acquired) {
      console.log(`${TAG} Another worker holds the lock — standby mode`);
      // Recheck every 30s
      lockCheckHandle = setInterval(async () => {
        const got = await tryAcquireLock();
        if (got) {
          console.log(`${TAG} Lock acquired (was in standby) — starting worker`);
          clearInterval(lockCheckHandle);
          lockCheckHandle = null;
          await beginWorker();
        }
      }, 30_000);
      return;
    }

    await beginWorker();
  }

  async function beginWorker() {
    hasLock = true;

    // Reclaim stuck rows on startup
    await reclaimStuckSending();

    // Start drain interval
    drainHandle = setInterval(() => drainBatch(baseUrl, apiKey), tickMs);

    // Start prune interval
    pruneHandle = setInterval(pruneSent, pruneMs);

    // Run first drain immediately
    drainBatch(baseUrl, apiKey);

    console.log(`${TAG} Started (tick: ${tickMs}ms, prune: ${pruneMs / (60 * 60 * 1000)}h, backoff: 1s/2s/4s/8s, max attempts: ${MAX_ATTEMPTS})`);
  }

  start().catch(e => {
    console.error(`${TAG} Start failed:`, e.message);
  });

  return {
    stop: () => {
      if (drainHandle) clearInterval(drainHandle);
      if (pruneHandle) clearInterval(pruneHandle);
      if (lockCheckHandle) clearInterval(lockCheckHandle);
    },
  };
}
