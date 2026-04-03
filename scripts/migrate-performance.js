#!/usr/bin/env node
/**
 * Migration: Create org_studio_kudos table for Agent Performance system
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Read .env.local manually
const envPath = path.join(__dirname, '..', '.env.local');
let DATABASE_URL = '';

if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    if (line.startsWith('DATABASE_URL=')) {
      DATABASE_URL = line.split('=')[1];
      break;
    }
  }
}

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL not set in .env.local. Skipping migration.');
  console.log('   Local fallback: kudos will be stored in data/kudos.json');
  process.exit(0);
}

const pool = new Pool({ connectionString: DATABASE_URL });

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🔄 Creating org_studio_kudos table...');

    await client.query(`
      CREATE TABLE IF NOT EXISTS org_studio_kudos (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        given_by TEXT NOT NULL,
        task_id TEXT,
        project_id TEXT,
        value_tags TEXT NOT NULL DEFAULT '[]',
        note TEXT NOT NULL,
        type TEXT DEFAULT 'kudos' CHECK (type IN ('kudos', 'flag')),
        auto_detected BOOLEAN DEFAULT false,
        confirmed BOOLEAN DEFAULT true,
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
      )
    `);

    console.log('✅ Table created');

    console.log('🔄 Creating indexes...');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_kudos_agent ON org_studio_kudos(agent_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_kudos_type ON org_studio_kudos(type)
    `);
    console.log('✅ Indexes created');

    console.log('\n✅ Migration complete!');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
