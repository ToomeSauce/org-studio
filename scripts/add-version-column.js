#!/usr/bin/env node
/**
 * add-version-column.js
 * 
 * Adds the `version` column to org_studio_tasks table if it doesn't exist.
 * Safe to run multiple times.
 */

const { Pool } = require('pg');

const CONNECTION_STRING = process.env.DATABASE_URL || 'your-database-url-here';

const pool = new Pool({
  connectionString: CONNECTION_STRING,
  max: 5,
});

async function addVersionColumn() {
  const client = await pool.connect();
  try {
    console.log('Checking if version column exists...');

    // Check if column exists
    const result = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name='org_studio_tasks' AND column_name='version'
    `);

    if (result.rows.length > 0) {
      console.log('✓ version column already exists');
      return;
    }

    // Add the column if it doesn't exist
    console.log('Adding version column to org_studio_tasks...');
    await client.query(`
      ALTER TABLE org_studio_tasks ADD COLUMN version TEXT
    `);

    console.log('✓ version column added successfully');
  } catch (e) {
    console.error('Error adding version column:', e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

addVersionColumn();
