#!/usr/bin/env node
/**
 * Creates the org_studio_agent_metrics table for daily agent performance snapshots.
 * Safe to run multiple times (IF NOT EXISTS).
 *
 * Usage: DATABASE_URL=... node scripts/migrate-metrics.js
 */
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
});

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Creating org_studio_agent_metrics table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS org_studio_agent_metrics (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        date DATE NOT NULL,
        tasks_completed INTEGER DEFAULT 0,
        tasks_started INTEGER DEFAULT 0,
        avg_duration_min FLOAT,
        median_duration_min FLOAT,
        avg_gap_min FLOAT,
        chain_rate FLOAT,
        throughput FLOAT,
        first_pass_rate FLOAT,
        bounce_count INTEGER DEFAULT 0,
        stall_count INTEGER DEFAULT 0,
        comments_posted INTEGER DEFAULT 0,
        mentions_received INTEGER DEFAULT 0,
        mentions_sent INTEGER DEFAULT 0,
        mention_response_min FLOAT,
        kudos_count INTEGER DEFAULT 0,
        flag_count INTEGER DEFAULT 0,
        review_notes_rate FLOAT,
        test_plan_rate FLOAT,
        active_minutes INTEGER DEFAULT 0,
        versions_completed INTEGER DEFAULT 0,
        data JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(agent_id, date)
      )
    `);

    // Index for fast agent + date range queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_agent_metrics_agent_date
        ON org_studio_agent_metrics(agent_id, date DESC)
    `);

    // Index for team-wide queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_agent_metrics_date
        ON org_studio_agent_metrics(date DESC)
    `);

    console.log('✅ org_studio_agent_metrics table created');

    // Check if table has rows
    const count = await client.query('SELECT COUNT(*) FROM org_studio_agent_metrics');
    console.log(`Current rows: ${count.rows[0].count}`);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(e => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});
