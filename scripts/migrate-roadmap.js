#!/usr/bin/env node

/**
 * Roadmap Migration Script
 * Moves roadmap data from vision_docs markdown to org_studio_roadmap_versions table
 */

const fs = require('fs');
const path = require('path');

// Read .env.local manually
const envPath = path.join(__dirname, '..', '.env.local');
const envContent = fs.readFileSync(envPath, 'utf-8');
const envVars = {};
envContent.split('\n').forEach(line => {
  const [key, value] = line.split('=');
  if (key && value) {
    envVars[key.trim()] = value.trim();
  }
});

const { Pool } = require('pg');

const DATABASE_URL = envVars.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL not set in .env.local');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
});

async function runMigration() {
  const client = await pool.connect();
  try {
    console.log('🚀 Starting roadmap migration...\n');

    // Step 1: Create table
    console.log('📋 Creating org_studio_roadmap_versions table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS org_studio_roadmap_versions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        version TEXT NOT NULL,
        title TEXT,
        status TEXT DEFAULT 'planned' CHECK (status IN ('planned', 'current', 'shipped')),
        shipped_at BIGINT,
        sort_order INTEGER DEFAULT 0,
        items JSONB DEFAULT '[]',
        created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000),
        UNIQUE(project_id, version)
      );
    `);
    console.log('✅ Table created\n');

    // Create indexes
    console.log('📋 Creating indexes...');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_roadmap_project ON org_studio_roadmap_versions(project_id);
      CREATE INDEX IF NOT EXISTS idx_roadmap_status ON org_studio_roadmap_versions(status);
    `);
    console.log('✅ Indexes created\n');

    // Step 2: Fetch all vision docs
    console.log('📖 Fetching vision docs...');
    const visionsResult = await client.query(`
      SELECT id, project_id, content FROM org_studio_vision_docs WHERE content IS NOT NULL;
    `);
    const visions = visionsResult.rows;
    console.log(`✅ Found ${visions.length} vision docs\n`);

    let migratedCount = 0;
    let skippedCount = 0;

    // Step 3: Parse and migrate each vision doc
    for (const vision of visions) {
      const { id: visionId, project_id: projectId, content } = vision;

      // Parse roadmap section
      const roadmapMatch = content.match(/## Roadmap\s*([\s\S]*?)(?=\n## |\Z)/);
      if (!roadmapMatch) {
        console.log(`⏭️  Vision ${visionId}: No roadmap section found`);
        skippedCount++;
        continue;
      }

      const roadmapText = roadmapMatch[1];
      const versions = parseRoadmapVersions(roadmapText);

      if (versions.length === 0) {
        console.log(`⏭️  Vision ${visionId}: No versions parsed`);
        skippedCount++;
        continue;
      }

      // Insert each version
      for (const version of versions) {
        const versionId = `rv-${projectId}-${version.version.replace(/\./g, '-')}`;
        const sortOrder = parseFloat(version.version);

        try {
          await client.query(
            `
            INSERT INTO org_studio_roadmap_versions 
              (id, project_id, version, title, status, shipped_at, sort_order, items, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (project_id, version) DO UPDATE SET
              title = EXCLUDED.title,
              status = EXCLUDED.status,
              shipped_at = EXCLUDED.shipped_at,
              items = EXCLUDED.items
            `,
            [
              versionId,
              projectId,
              version.version,
              version.title,
              version.status,
              version.shippedAt,
              sortOrder,
              JSON.stringify(version.items),
              Date.now(),
            ]
          );
          migratedCount++;
          console.log(`✅ Migrated v${version.version} (${version.status})`);
        } catch (err) {
          console.error(`❌ Error inserting v${version.version}:`, err.message);
        }
      }
    }

    console.log(`\n🎉 Migration complete!`);
    console.log(`   Migrated: ${migratedCount} versions`);
    console.log(`   Skipped: ${skippedCount} docs\n`);

  } catch (err) {
    console.error('Migration error:', err);
    process.exit(1);
  } finally {
    await client.end();
    await pool.end();
  }
}

/**
 * Parse roadmap versions from markdown text
 * Expects format:
 * ### v0.901: Version Title
 * - [x] Item 1
 * - [ ] Item 2
 */
function parseRoadmapVersions(text) {
  const versions = [];
  const versionRegex = /### v([\d.]+)(?:\s*\((.+?)\))?:\s*(.+?)(?=### v|\Z)/gs;

  let match;
  while ((match = versionRegex.exec(text)) !== null) {
    const versionNum = match[1];
    const metadata = match[2] || '';
    const title = match[3].trim();
    const content = match[0];

    // Determine status
    let status = 'planned';
    let shippedAt = null;

    if (metadata.includes('shipped')) {
      status = 'shipped';
      // Try to extract date from metadata
      const dateMatch = metadata.match(/(\d{4}-\d{2}-\d{2})/);
      if (dateMatch) {
        shippedAt = new Date(dateMatch[1]).getTime();
      } else {
        shippedAt = Date.now();
      }
    } else if (metadata.includes('current')) {
      status = 'current';
    }

    // Parse checklist items
    const items = [];
    const itemRegex = /- \[([ xX])\]\s*(.+?)(?:\[task-\d+\])?$/gm;
    let itemMatch;
    while ((itemMatch = itemRegex.exec(content)) !== null) {
      const checked = itemMatch[1].toLowerCase() === 'x';
      const title = itemMatch[2].trim();
      items.push({
        title,
        done: checked,
        taskId: null,
      });
    }

    versions.push({
      version: versionNum,
      title,
      status,
      shippedAt,
      items,
    });
  }

  return versions;
}

runMigration().catch(console.error);
