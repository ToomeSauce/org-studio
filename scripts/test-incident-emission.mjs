#!/usr/bin/env node
/**
 * scripts/test-incident-emission.mjs — Manually fire the 3 new incident types
 * and verify they appear in org_studio_incidents.
 */

import pg from 'pg';
import crypto from 'crypto';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });

async function logIncident({ type, agentId, message, context }) {
  await pool.query(
    `INSERT INTO org_studio_incidents (id, timestamp, type, agent_id, message, context)
     VALUES ($1, NOW(), $2, $3, $4, $5)`,
    [crypto.randomUUID(), type, agentId, message, context ? JSON.stringify(context) : null]
  );
}

async function main() {
  console.log('=== Emitting 3 new incident types ===\n');

  // 1. gateway_disconnect
  await logIncident({
    type: 'gateway_disconnect',
    agentId: null,
    message: 'Gateway disconnected for 3m (test)',
    context: { downSince: new Date().toISOString(), downMinutes: 3 },
  });
  console.log('✓ gateway_disconnect incident emitted');

  // 2. listen_stale
  await logIncident({
    type: 'listen_stale',
    agentId: null,
    message: 'LISTEN connection stale for 6m (test)',
    context: { downSince: new Date().toISOString(), downMinutes: 6 },
  });
  console.log('✓ listen_stale incident emitted');

  // 3. dead_letter_backlog
  await logIncident({
    type: 'dead_letter_backlog',
    agentId: null,
    message: 'Dead-letter backlog: 12 messages (test)',
    context: { count: 12 },
  });
  console.log('✓ dead_letter_backlog incident emitted');

  // Verify: query back
  console.log('\n=== Verifying incidents in DB ===\n');
  const { rows } = await pool.query(
    `SELECT id, timestamp, type, message FROM org_studio_incidents 
     WHERE type IN ('gateway_disconnect', 'listen_stale', 'dead_letter_backlog')
     ORDER BY timestamp DESC LIMIT 10`
  );

  for (const row of rows) {
    console.log(`  ${row.type} | ${row.timestamp} | ${row.message}`);
  }
  console.log(`\nTotal rows for new types: ${rows.length}`);

  // Clean up test dead_letter rows
  const { rowCount } = await pool.query("DELETE FROM org_studio_outbox WHERE agent_id = 'test-health-alert'");
  console.log(`\nCleaned up ${rowCount} test dead_letter rows`);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
