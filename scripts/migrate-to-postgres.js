#!/usr/bin/env node
/**
 * migrate-to-postgres.js
 * 
 * Migrates Org Studio data from store.json to PostgreSQL
 * 
 * Steps:
 * 1. Connect to the database
 * 2. Create schema (tables with IF NOT EXISTS)
 * 3. Read store.json
 * 4. Insert all projects, tasks, and settings
 * 5. Verify counts match
 * 6. Report results
 */

const { Pool } = require('pg');
const { readFileSync } = require('fs');
const { join } = require('path');

const CONNECTION_STRING = 'your-database-url-here';

const pool = new Pool({
  connectionString: CONNECTION_STRING,
  max: 5,
});

async function createSchema(client) {
  console.log('Creating schema...');

  // Projects table
  await client.query(`
    CREATE TABLE IF NOT EXISTS org_studio_projects (
      id TEXT PRIMARY KEY,
      name TEXT,
      description TEXT,
      phase TEXT DEFAULT 'active',
      owner TEXT,
      priority TEXT,
      sort_order INT DEFAULT 5000,
      created_at BIGINT,
      created_by TEXT,
      data JSONB DEFAULT '{}',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Tasks table (WITHOUT foreign key constraint initially)
  await client.query(`
    CREATE TABLE IF NOT EXISTS org_studio_tasks (
      id TEXT PRIMARY KEY,
      ticket_number INT,
      title TEXT,
      status TEXT DEFAULT 'backlog',
      project_id TEXT,
      assignee TEXT,
      priority TEXT,
      test_type TEXT,
      test_assignee TEXT,
      initiated_by TEXT,
      description TEXT,
      done_when TEXT,
      constraints TEXT,
      test_plan TEXT,
      review_notes TEXT,
      loop_count INT DEFAULT 0,
      loop_paused_at BIGINT,
      loop_pause_reason TEXT,
      last_activity_at BIGINT,
      created_at BIGINT,
      version TEXT,
      status_history JSONB DEFAULT '[]',
      comments JSONB DEFAULT '[]',
      data JSONB DEFAULT '{}',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Settings table
  await client.query(`
    CREATE TABLE IF NOT EXISTS org_studio_settings (
      id TEXT PRIMARY KEY DEFAULT 'default',
      data JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Create indexes for common queries
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON org_studio_tasks(status)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON org_studio_tasks(project_id)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON org_studio_tasks(assignee)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_tasks_priority ON org_studio_tasks(priority)
  `);

  console.log('✓ Schema created');
}

async function readStore(storePath) {
  console.log(`Reading store from ${storePath}...`);
  const content = readFileSync(storePath, 'utf-8');
  const data = JSON.parse(content);
  console.log(`✓ Read ${data.projects.length} projects, ${data.tasks.length} tasks`);
  return data;
}

async function insertProjects(client, projects) {
  console.log(`Inserting ${projects.length} projects...`);

  // Truncate existing data
  await client.query('TRUNCATE org_studio_projects CASCADE');

  for (const project of projects) {
    // Extract typed columns
    const {
      id,
      name,
      description,
      phase,
      owner,
      priority,
      sortOrder,
      createdAt,
      createdBy,
      ...overflow
    } = project;

    await client.query(
      `INSERT INTO org_studio_projects
       (id, name, description, phase, owner, priority, sort_order, created_at, created_by, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        name || null,
        description || null,
        phase || 'active',
        owner || null,
        priority || null,
        sortOrder || 5000,
        createdAt || null,
        createdBy || null,
        JSON.stringify(overflow),
      ]
    );
  }

  console.log(`✓ Inserted ${projects.length} projects`);
}

async function insertTasks(client, tasks) {
  console.log(`Inserting ${tasks.length} tasks...`);

  // Truncate existing data
  await client.query('TRUNCATE org_studio_tasks CASCADE');

  for (const task of tasks) {
    // Extract typed columns
    const {
      id,
      ticketNumber,
      title,
      status,
      projectId,
      assignee,
      priority,
      testType,
      testAssignee,
      initiatedBy,
      description,
      doneWhen,
      constraints,
      testPlan,
      reviewNotes,
      loopCount,
      loopPausedAt,
      loopPauseReason,
      lastActivityAt,
      createdAt,
      statusHistory,
      comments,
      ...overflow
    } = task;

    await client.query(
      `INSERT INTO org_studio_tasks
       (id, ticket_number, title, status, project_id, assignee, priority, test_type, test_assignee, 
        initiated_by, description, done_when, constraints, test_plan, review_notes, loop_count, 
        loop_paused_at, loop_pause_reason, last_activity_at, created_at, status_history, comments, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
      [
        id,
        ticketNumber || null,
        title || null,
        status || 'backlog',
        projectId || null,
        assignee || null,
        priority || null,
        testType || null,
        testAssignee || null,
        initiatedBy || null,
        description || null,
        doneWhen || null,
        constraints || null,
        testPlan || null,
        reviewNotes || null,
        loopCount || 0,
        loopPausedAt || null,
        loopPauseReason || null,
        lastActivityAt || null,
        createdAt || null,
        JSON.stringify(statusHistory || []),
        JSON.stringify(comments || []),
        JSON.stringify(overflow),
      ]
    );
  }

  console.log(`✓ Inserted ${tasks.length} tasks`);
}

async function insertSettings(client, settings) {
  console.log('Inserting settings...');

  // Ensure default settings record exists
  await client.query(
    `INSERT INTO org_studio_settings (id, data)
     VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET data = $2`,
    ['default', JSON.stringify(settings || {})]
  );

  console.log('✓ Inserted settings');
}

async function verifyCounts(client, expectedProjects, expectedTasks) {
  console.log('\nVerifying counts...');

  const projectsResult = await client.query('SELECT COUNT(*) as count FROM org_studio_projects');
  const tasksResult = await client.query('SELECT COUNT(*) as count FROM org_studio_tasks');

  const actualProjects = parseInt(projectsResult.rows[0].count, 10);
  const actualTasks = parseInt(tasksResult.rows[0].count, 10);

  console.log(`Expected: ${expectedProjects} projects, ${expectedTasks} tasks`);
  console.log(`Actual:   ${actualProjects} projects, ${actualTasks} tasks`);

  if (actualProjects === expectedProjects && actualTasks === expectedTasks) {
    console.log('✓ Counts match!');
    return true;
  } else {
    console.error('✗ Count mismatch!');
    return false;
  }
}

async function main() {
  const client = await pool.connect();

  try {
    console.log('🚀 Starting migration...\n');

    // Step 1: Create schema
    await createSchema(client);

    // Step 2: Read store.json
    const storePath = join(process.cwd(), 'data', 'store.json');
    const store = await readStore(storePath);

    // Step 3: Insert data (in transaction)
    await client.query('BEGIN');
    try {
      await insertProjects(client, store.projects);
      await insertTasks(client, store.tasks);
      await insertSettings(client, store.settings || {});
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }

    // Step 4: Verify counts
    const success = await verifyCounts(client, store.projects.length, store.tasks.length);

    if (success) {
      console.log('\n✅ Migration completed successfully!');
      process.exit(0);
    } else {
      console.error('\n❌ Migration completed with errors');
      process.exit(1);
    }
  } catch (e) {
    console.error('❌ Migration failed:', e);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
