import { NextRequest, NextResponse } from 'next/server';
import { getStoreProvider } from '@/lib/store-provider';
import { authenticateRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

interface RoadmapItem {
  title: string;
  done: boolean;
  taskId?: string | null;
}

interface RoadmapVersion {
  id: string;
  version: string;
  title: string;
  status: 'planned' | 'current' | 'shipped';
  items: RoadmapItem[];
  progress?: { done: number; total: number };
  shipped_at?: number | null;
  sort_order?: number;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await params;

    const storeProvider = getStoreProvider();

    // Check if using Postgres
    if (process.env.DATABASE_URL) {
      // Query from Postgres table
      const { Pool } = await import('pg');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      const client = await pool.connect();

      try {
        const result = await client.query(
          `SELECT id, version, title, status, items, shipped_at, sort_order
           FROM org_studio_roadmap_versions
           WHERE project_id = $1
           ORDER BY sort_order ASC, version ASC`,
          [projectId]
        );

        const versions: RoadmapVersion[] = result.rows.map((row: any) => ({
          id: row.id,
          version: row.version,
          title: row.title,
          status: row.status,
          items: row.items || [],
          shipped_at: row.shipped_at,
          sort_order: row.sort_order,
          progress: calculateProgress(row.items || []),
        }));

        return NextResponse.json({ versions });
      } finally {
        client.release();
        await pool.end();
      }
    } else {
      // Fallback: read from JSON file
      const versions = readRoadmapsFromFile(projectId);
      return NextResponse.json({ versions });
    }
  } catch (err: any) {
    console.error('[Roadmap GET]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await params;
    const body = await req.json();
    const { action, version, title, status, items, order } = body;

    // Authenticate request (supports both session cookies and API keys)
    const authError = await authenticateRequest(req);
    if (authError) {
      return authError;
    }

    if (process.env.DATABASE_URL) {
      // Use Postgres
      const { Pool } = await import('pg');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      const client = await pool.connect();

      try {
        if (action === 'upsert') {
          const versionId = `rv-${projectId}-${version.replace(/\./g, '-')}`;
          const sortOrder = parseFloat(version);

          await client.query(
            `INSERT INTO org_studio_roadmap_versions 
              (id, project_id, version, title, status, items, sort_order, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (project_id, version) DO UPDATE SET
              title = EXCLUDED.title,
              status = EXCLUDED.status,
              items = EXCLUDED.items,
              sort_order = EXCLUDED.sort_order`,
            [
              versionId,
              projectId,
              version,
              title,
              status,
              JSON.stringify(items || []),
              sortOrder,
              Date.now(),
            ]
          );

          // Auto-sync: if this version is set to "current", update the project's currentVersion
          if (status === 'current') {
            try {
              // Update via store API internally
              const storeRes = await fetch(`http://localhost:${process.env.PORT || 4501}/api/store`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(process.env.ORG_STUDIO_API_KEY ? { 'Authorization': `Bearer ${process.env.ORG_STUDIO_API_KEY}` } : {}),
                },
                body: JSON.stringify({
                  action: 'updateProject',
                  id: projectId,
                  updates: { currentVersion: version },
                }),
              });
              if (!storeRes.ok) console.warn(`[Roadmap] Failed to sync currentVersion to project: ${storeRes.status}`);
            } catch (e) {
              console.warn('[Roadmap] Failed to sync currentVersion to project:', e);
            }
          }

          return NextResponse.json({
            action: 'upserted',
            version,
            id: versionId,
          });
        } else if (action === 'delete') {
          await client.query(
            'DELETE FROM org_studio_roadmap_versions WHERE project_id = $1 AND version = $2',
            [projectId, version]
          );

          return NextResponse.json({ action: 'deleted', version });
        } else if (action === 'reorder') {
          // Update sort_order for each version in the order array
          for (let i = 0; i < order.length; i++) {
            await client.query(
              'UPDATE org_studio_roadmap_versions SET sort_order = $1 WHERE project_id = $2 AND version = $3',
              [order.length - i, projectId, order[i]]
            );
          }

          return NextResponse.json({ action: 'reordered', order });
        }

        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
      } finally {
        client.release();
        await pool.end();
      }
    } else {
      // Fallback: use JSON file
      return handleFileBasedRoadmap(projectId, action, { version, title, status, items, order });
    }
  } catch (err: any) {
    console.error('[Roadmap POST]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

function calculateProgress(items: RoadmapItem[]): { done: number; total: number } {
  const done = items.filter((i) => i.done).length;
  return { done, total: items.length };
}

function readRoadmapsFromFile(projectId: string): RoadmapVersion[] {
  try {
    const fs = require('fs');
    const path = require('path');
    const roadmapPath = path.join(process.cwd(), 'data', 'roadmaps', `${projectId}.json`);

    if (fs.existsSync(roadmapPath)) {
      const content = fs.readFileSync(roadmapPath, 'utf-8');
      const data = JSON.parse(content);
      const versions = data.versions || [];
      // Sort ascending by sort_order then version
      versions.sort((a: RoadmapVersion, b: RoadmapVersion) => {
        const aOrder = a.sort_order ?? parseFloat(a.version);
        const bOrder = b.sort_order ?? parseFloat(b.version);
        return aOrder - bOrder;
      });
      return versions;
    }

    return [];
  } catch (err) {
    console.error('Error reading roadmaps file:', err);
    return [];
  }
}

function handleFileBasedRoadmap(
  projectId: string,
  action: string,
  payload: any
): NextResponse {
  try {
    const fs = require('fs');
    const path = require('path');
    const roadmapDir = path.join(process.cwd(), 'data', 'roadmaps');
    const roadmapPath = path.join(roadmapDir, `${projectId}.json`);

    // Ensure directory exists
    if (!fs.existsSync(roadmapDir)) {
      fs.mkdirSync(roadmapDir, { recursive: true });
    }

    let data: any = { versions: [] };
    if (fs.existsSync(roadmapPath)) {
      data = JSON.parse(fs.readFileSync(roadmapPath, 'utf-8'));
    }

    if (action === 'upsert') {
      const { version, title, status, items } = payload;
      const idx = data.versions.findIndex((v: any) => v.version === version);

      const newVersion = {
        id: `rv-${projectId}-${version.replace(/\./g, '-')}`,
        version,
        title,
        status,
        items,
        sort_order: parseFloat(version),
      };

      if (idx >= 0) {
        data.versions[idx] = newVersion;
      } else {
        data.versions.push(newVersion);
      }

      data.versions.sort((a: any, b: any) => b.sort_order - a.sort_order);
      fs.writeFileSync(roadmapPath, JSON.stringify(data, null, 2));

      return NextResponse.json({ action: 'upserted', version });
    } else if (action === 'delete') {
      const { version } = payload;
      data.versions = data.versions.filter((v: any) => v.version !== version);
      fs.writeFileSync(roadmapPath, JSON.stringify(data, null, 2));

      return NextResponse.json({ action: 'deleted', version });
    } else if (action === 'reorder') {
      const { order } = payload;
      const versionMap = new Map(data.versions.map((v: any) => [v.version, v]));
      data.versions = order.map((v: string) => versionMap.get(v)).filter(Boolean);

      fs.writeFileSync(roadmapPath, JSON.stringify(data, null, 2));

      return NextResponse.json({ action: 'reordered', order });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err: any) {
    console.error('Error handling file-based roadmap:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
