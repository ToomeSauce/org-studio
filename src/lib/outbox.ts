/**
 * outbox.ts — TS helper for enqueuing outbox rows from the scheduler route.
 *
 * If DATABASE_URL is unset (file mode), falls back to calling sendToAgent directly
 * for backward compatibility.
 */

import crypto from 'crypto';

// Lazy pool — only created when DATABASE_URL is present
let _pool: any = null;
let _poolChecked = false;

async function getPool() {
  if (_poolChecked) return _pool;
  _poolChecked = true;

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return null;

  try {
    const { Pool } = require('pg');
    _pool = new Pool({ connectionString: dbUrl, max: 3 });
    return _pool;
  } catch {
    return null;
  }
}

export interface EnqueueOutboxParams {
  agentId: string;
  message: string;
  sessionKey: string;
  idempotencyKey: string;
  onCompleteKind?: string; // 'redispatch' — stored in payload for worker to re-hydrate
}

/**
 * Enqueue an outbox row for the outbox worker to drain.
 *
 * If Postgres is unavailable, falls back to direct sendToAgent call.
 * Returns the outbox row ID (or undefined for fallback path).
 */
export async function enqueueOutbox(params: EnqueueOutboxParams): Promise<string | undefined> {
  const pool = await getPool();

  if (!pool) {
    // File mode fallback — call sendToAgent directly
    const { sendToAgent } = await import('@/lib/runtimes/registry');
    await sendToAgent(params.agentId, params.message, {
      sessionKey: params.sessionKey,
      idempotencyKey: params.idempotencyKey,
    });
    return undefined;
  }

  const id = crypto.randomUUID();
  const payload = {
    message: params.message,
    sessionKey: params.sessionKey,
    ...(params.onCompleteKind ? { onCompleteKind: params.onCompleteKind } : {}),
  };

  await pool.query(
    `INSERT INTO org_studio_outbox (id, idempotency_key, agent_id, payload, status, attempts, next_attempt_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'pending', 0, NOW(), NOW(), NOW())
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [id, params.idempotencyKey, params.agentId, JSON.stringify(payload)]
  );

  return id;
}
