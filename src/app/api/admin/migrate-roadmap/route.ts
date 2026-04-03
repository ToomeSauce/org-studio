import { NextRequest, NextResponse } from 'next/server';
import { getStoreProvider } from '@/lib/store-provider';

export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/migrate-roadmap
 *
 * Migrates roadmap data from vision doc markdown to org_studio_roadmap_versions table.
 * Only runs on Postgres (checks DATABASE_URL).
 */
export async function POST(req: NextRequest) {
  try {
    const apiKey = req.headers.get('x-api-key');
    const expectedKey = process.env.ORG_STUDIO_API_KEY;

    if (!apiKey || apiKey !== expectedKey) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!process.env.DATABASE_URL) {
      return NextResponse.json(
        { error: 'DATABASE_URL not configured' },
        { status: 400 }
      );
    }

    const storeProvider = getStoreProvider();

    // We need direct pool access, which isn't exposed by storeProvider
    // So we'll create a separate connection
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const client = await pool.connect();

    try {
      console.log('🚀 Starting roadmap migration...\n');

      // Step 1: Create table
      console.log('📋 Creating org_studio_roadmap_versions table...');
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS org_studio_roadmap_versions (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            version TEXT NOT NULL,
            title TEXT,
            status TEXT DEFAULT 'planned' CHECK (status IN ('planned', 'current', 'shipped')),
            shipped_at BIGINT,
            sort_order FLOAT DEFAULT 0,
            items JSONB DEFAULT '[]',
            created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000),
            UNIQUE(project_id, version)
          );
        `);
        console.log('✅ Table created\n');
      } catch (err: any) {
        if (err.code === '42P07') {
          // Table already exists
          console.log('✅ Table already exists\n');
        } else {
          throw err;
        }
      }

      // Create indexes
      console.log('📋 Creating indexes...');
      try {
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_roadmap_project ON org_studio_roadmap_versions(project_id);
          CREATE INDEX IF NOT EXISTS idx_roadmap_status ON org_studio_roadmap_versions(status);
        `);
      } catch (err: any) {
        console.log('Indexes may already exist:', err.message);
      }
      console.log('✅ Indexes ready\n');

      // Step 2: Fetch all vision docs
      console.log('📖 Fetching vision docs...');
      
      // First, check if vision docs table exists and what columns it has
      const tableCheckResult = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'org_studio_vision_docs'
      `);
      
      if (tableCheckResult.rows.length === 0) {
        console.log('⚠️  org_studio_vision_docs table does not exist');
        return;
      }
      
      const columns = tableCheckResult.rows.map((r: any) => r.column_name);
      console.log('Available columns:', columns);
      
      // Use whatever columns are available
      const hasId = columns.includes('id');
      const hasProjectId = columns.includes('project_id');
      const hasContent = columns.includes('content');
      
      if (!hasContent) {
        console.log('⚠️  No content column found in vision docs table');
        return;
      }
      
      const visionsResult = await client.query(
        `SELECT ${hasId ? 'id' : "'unknown' as id"}, ${hasProjectId ? 'project_id' : 'NULL as project_id'}, content FROM org_studio_vision_docs WHERE content IS NOT NULL`
      );
      const visions = visionsResult.rows;
      console.log(`✅ Found ${visions.length} vision docs\n`);

      let migratedCount = 0;
      let skippedCount = 0;

      // Step 3: Parse and migrate each vision doc
      for (const vision of visions) {
        const { id: visionId, project_id: projectId, content } = vision;

        console.log(`\n📄 Processing project ${projectId}...`);
        console.log(`   Content length: ${content?.length || 0}`);

        // Parse roadmap section
        const roadmapMatch = content?.match(/## Roadmap\s*([\s\S]*?)(?=\n## |\Z)/);
        if (!roadmapMatch) {
          console.log(`⏭️  No roadmap section found`);
          skippedCount++;
          continue;
        }

        const roadmapText = roadmapMatch[1];
        console.log(`   Roadmap text length: ${roadmapText.length}`);
        console.log(`   First 200 chars: ${roadmapText.substring(0, 200)}`);
        
        const versions = parseRoadmapVersions(roadmapText);
        console.log(`   Parsed ${versions.length} versions`);

        if (versions.length === 0) {
          console.log(`⏭️  No versions parsed`);
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
            console.log(`   ✅ Migrated v${version.version} (${version.status})`);
          } catch (err: any) {
            console.error(`   ❌ Error inserting v${version.version}:`, err.message);
          }
        }
      }

      const result = {
        status: 'complete',
        migrated: migratedCount,
        skipped: skippedCount,
      };

      console.log(`\n🎉 Migration complete!`);
      console.log(`   Migrated: ${migratedCount} versions`);
      console.log(`   Skipped: ${skippedCount} docs\n`);

      return NextResponse.json(result);
    } finally {
      client.release();
      await pool.end();
    }
  } catch (err: any) {
    console.error('Migration error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/**
 * Parse roadmap versions from markdown text
 * Expects format:
 * ### v0.901: Version Title
 * - [x] Item 1
 * - [ ] Item 2
 */
function parseRoadmapVersions(text: string): any[] {
  const versions: any[] = [];
  
  // Split on ### v pattern, capturing version headers
  const parts = text.split(/(?=### v[\d.]+)/);
  
  for (const part of parts) {
    if (!part.trim()) continue;
    
    // Extract version info from header
    const headerMatch = part.match(/^### v([\d.]+)(?:\s*\(([^)]*)\))?[:\s—]*(.*?)$/m);
    if (!headerMatch) continue;
    
    const versionNum = headerMatch[1];
    const metadata = headerMatch[2] || '';
    const headerTitle = headerMatch[3]?.trim() || '';
    
    // Determine status
    let status = 'planned';
    let shippedAt = null;
    
    if (metadata.toLowerCase().includes('shipped')) {
      status = 'shipped';
      const dateMatch = metadata.match(/(\d{4}-\d{2}-\d{2})/);
      if (dateMatch) {
        shippedAt = new Date(dateMatch[1]).getTime();
      } else {
        shippedAt = Date.now();
      }
    } else if (metadata.toLowerCase().includes('current') || metadata.toLowerCase().includes('next')) {
      status = 'current';
    }
    
    // Clean up title
    const title = headerTitle.replace(/✅|✓|—|–|-/g, '').trim() || `v${versionNum}`;
    
    // Parse checklist items from entire section
    const items: any[] = [];
    const itemRegex = /^- \[([ xX])\]\s*(.+?)(?:\s*\[task-[\w]+\])?$/gm;
    let itemMatch;
    while ((itemMatch = itemRegex.exec(part)) !== null) {
      const checked = itemMatch[1].toLowerCase() === 'x';
      const itemTitle = itemMatch[2].trim();
      items.push({
        title: itemTitle,
        done: checked,
        taskId: null,
      });
    }
    
    // Only add if we found items
    if (items.length > 0) {
      versions.push({
        version: versionNum,
        title,
        status,
        shippedAt,
        items,
      });
    }
  }
  
  return versions;
}
