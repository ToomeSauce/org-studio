/**
 * migrate-vision-docs.js
 * 
 * Migrates existing vision docs from docs/visions/*.md to PostgreSQL.
 * Run this AFTER creating the org_studio_vision_docs table.
 */

const fs = require('fs');
const path = require('path');

(async () => {
  const pg = await import('pg');
  const dbUrl = process.env.DATABASE_URL;

  if (!dbUrl) {
    console.log('⚠️  DATABASE_URL not set — skipping migration.');
    process.exit(0);
  }

  const client = new pg.Client(dbUrl);

  try {
    await client.connect();
    console.log('✓ Connected to Postgres');

    // Check if table exists
    const tableCheck = await client.query(
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='org_studio_vision_docs')`
    );
    if (!tableCheck.rows[0].exists) {
      console.error('❌ org_studio_vision_docs table does not exist. Create it first.');
      process.exit(1);
    }

    // Read all .md files from docs/visions/
    const visionDir = path.join(process.cwd(), 'docs', 'visions');
    if (!fs.existsSync(visionDir)) {
      console.log('ℹ️  docs/visions/ directory does not exist — nothing to migrate.');
      await client.end();
      process.exit(0);
    }

    const files = fs.readdirSync(visionDir).filter(f => f.endsWith('.md'));
    console.log(`Found ${files.length} vision docs to migrate...`);

    let migrated = 0;
    let skipped = 0;

    for (const file of files) {
      const projectId = path.basename(file, '.md');
      const filePath = path.join(visionDir, file);

      try {
        const content = fs.readFileSync(filePath, 'utf-8');

        // Check if already exists
        const existing = await client.query(
          'SELECT project_id FROM org_studio_vision_docs WHERE project_id = $1',
          [projectId]
        );

        if (existing.rows.length > 0) {
          console.log(`  ⏭️  Skipping ${projectId} (already in DB)`);
          skipped++;
          continue;
        }

        // Insert into DB
        await client.query(
          `INSERT INTO org_studio_vision_docs (project_id, content, updated_at)
           VALUES ($1, $2, EXTRACT(EPOCH FROM NOW()) * 1000)`,
          [projectId, content]
        );

        console.log(`  ✓ Migrated ${projectId}`);
        migrated++;
      } catch (e) {
        console.error(`  ❌ Failed to migrate ${projectId}:`, e.message);
      }
    }

    console.log(`\n✓ Migration complete: ${migrated} docs migrated, ${skipped} skipped`);
  } catch (e) {
    console.error('❌ Migration failed:', e.message);
    process.exit(1);
  } finally {
    await client.end();
  }
})();
