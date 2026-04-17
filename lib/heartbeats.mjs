/**
 * heartbeats.mjs — Agent loop heartbeat watchdog (server-side, ESM)
 *
 * Provides:
 *   ensureHeartbeatSchema() — creates org_studio_heartbeats + org_studio_incidents tables
 *   startLoopWatchdog()     — periodic checker that restarts stale loops
 *
 * Called from server.mjs at startup. Postgres-only; silently no-ops in file mode.
 */

import crypto from 'node:crypto';

const TAG = '[HeartbeatWatchdog]';

/**
 * Returns a pg Pool connected to DATABASE_URL, or null if unavailable.
 */
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

// Module-level pool (lazy singleton)
let _pool = undefined; // undefined = not yet initialized, null = no DB

async function pool() {
  if (_pool === undefined) {
    _pool = await getPool();
  }
  return _pool;
}

/**
 * Create heartbeat + incidents tables if they don't exist.
 */
export async function ensureHeartbeatSchema() {
  const p = await pool();
  if (!p) {
    console.log(`${TAG} Disabled (file mode — Postgres required)`);
    return;
  }

  const client = await p.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS org_studio_heartbeats (
        agent_id TEXT PRIMARY KEY,
        loop_id TEXT,
        last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_status TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS org_studio_incidents (
        id TEXT PRIMARY KEY,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        type TEXT NOT NULL,
        agent_id TEXT,
        message TEXT NOT NULL,
        context JSONB
      );
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_incidents_timestamp ON org_studio_incidents(timestamp DESC);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_incidents_agent_id ON org_studio_incidents(agent_id);`);

    console.log(`${TAG} Schema ensured (heartbeats + incidents tables)`);
  } finally {
    client.release();
  }
}

/**
 * Log an incident to org_studio_incidents.
 */
export async function logIncident({ type, agentId, message, context }) {
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
 * Start the periodic heartbeat watchdog.
 *
 * On each tick:
 *   1. Query heartbeats where now() - last_heartbeat > thresholdMs
 *   2. For each stale agent, POST /api/scheduler { action: 'trigger', agentId }
 *   3. Log an incident row for each restart
 *   4. Respect restart cooldown per agent
 */
export function startLoopWatchdog({
  intervalMs = 60_000,
  thresholdMs = 5 * 60_000,
  restartCooldownMs = 2 * 60_000,
} = {}) {
  // In-memory cooldown map
  const lastRestart = new Map(); // agentId -> timestamp ms

  const apiKey = process.env.ORG_STUDIO_API_KEY || '';
  const baseUrl = `http://127.0.0.1:${process.env.PORT || '4501'}`;

  const tick = async () => {
    const p = await pool();
    if (!p) return;

    try {
      // Find agents whose heartbeat is older than threshold
      const { rows } = await p.query(
        `SELECT agent_id, loop_id, last_heartbeat, last_status
         FROM org_studio_heartbeats
         WHERE last_heartbeat < NOW() - INTERVAL '1 millisecond' * $1`,
        [thresholdMs]
      );

      if (rows.length === 0) return;

      const now = Date.now();

      for (const row of rows) {
        const agentId = row.agent_id;

        // Check cooldown
        const lastMs = lastRestart.get(agentId) || 0;
        if (now - lastMs < restartCooldownMs) {
          continue; // skip — restarted too recently
        }

        console.log(`${TAG} Stale heartbeat for ${agentId} (last: ${row.last_heartbeat}) — triggering restart`);

        // Trigger restart via scheduler API
        try {
          const resp = await fetch(`${baseUrl}/api/scheduler`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify({ action: 'trigger', agentId }),
          });

          const result = await resp.json().catch(() => ({}));
          lastRestart.set(agentId, Date.now());

          // Log incident
          await logIncident({
            type: 'watchdog_restart',
            agentId,
            message: `Heartbeat watchdog restarted loop for ${agentId} (last heartbeat: ${row.last_heartbeat})`,
            context: {
              lastHeartbeat: row.last_heartbeat,
              lastStatus: row.last_status,
              loopId: row.loop_id,
              triggerResult: result,
            },
          });

          console.log(`${TAG} Restart triggered for ${agentId}:`, result.ok ? 'ok' : JSON.stringify(result));
        } catch (e) {
          console.error(`${TAG} Failed to trigger restart for ${agentId}:`, e.message);
        }
      }
    } catch (e) {
      console.error(`${TAG} Tick error:`, e.message);
    }
  };

  // Run on interval
  const handle = setInterval(tick, intervalMs);

  // Run first tick after a short delay (let server fully start)
  setTimeout(tick, 10_000);

  console.log(`${TAG} Started (interval: ${intervalMs / 1000}s, threshold: ${thresholdMs / 60_000}min, restart cooldown: ${restartCooldownMs / 60_000}min)`);

  return handle;
}
