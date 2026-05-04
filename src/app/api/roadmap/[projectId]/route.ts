import { NextRequest, NextResponse } from 'next/server';
import { getStoreProvider } from '@/lib/store-provider';
import { authenticateRequest } from '@/lib/auth';
import { checkArchivedProject } from '@/lib/archived-project-compat';
import { versionSortKey, compareVersions, isValidVersion } from '@/lib/version-utils';

export const dynamic = 'force-dynamic';

interface RoadmapItem {
  id?: string;       // stable item identifier for roadmap-task linking
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
  version_type?: 'outcome' | 'foundation' | 'chore';
  owner?: string | null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await params;

    // 410 compat: archived qa-fold projects
    const store = await getStoreProvider().read();
    const archCheck = checkArchivedProject(store.projects, projectId);
    if (archCheck.migrated) {
      return NextResponse.json(
        { error: 'Project moved', migratedTo: archCheck.migratedTo },
        { status: 410 }
      );
    }

    const storeProvider = getStoreProvider();

    // Check if using Postgres
    if (process.env.DATABASE_URL) {
      // Query from Postgres table
      const { Pool } = await import('pg');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      const client = await pool.connect();

      try {
        const result = await client.query(
          `SELECT id, version, title, status, items, shipped_at, sort_order, version_type, owner
           FROM org_studio_roadmap_versions
           WHERE project_id = $1 AND workspace_id = $2
           ORDER BY sort_order ASC, version ASC`,
          [projectId, 'default-workspace'] // TODO(v0.17-multi-workspace): resolve from request context
        );

        const versions: RoadmapVersion[] = result.rows.map((row: any) => ({
          id: row.id,
          version: row.version,
          title: row.title,
          status: row.status,
          items: row.items || [],
          shipped_at: row.shipped_at,
          sort_order: row.sort_order,
          version_type: row.version_type || 'outcome',
          owner: row.owner ?? null,
          progress: calculateProgress(row.items || []),
        }));

        // Derive item.done from linked task status (don't trust stored done flag)
        let allTasks: any[] = [];
        try {
          const storeRes = await fetch(`http://127.0.0.1:${process.env.PORT || 4501}/api/store`);
          if (storeRes.ok) {
            const storeData = await storeRes.json();
            allTasks = storeData.tasks || [];
          }
        } catch {}
        const taskStatusById = new Map(allTasks.map((t: any) => [t.id, t.status]));

        // Now override done on each item based on linked task
        for (const ver of versions) {
          for (const item of ver.items || []) {
            if (item.taskId) {
              const taskStatus = taskStatusById.get(item.taskId);
              item.done = taskStatus === 'done';
            }
            // If no taskId, keep whatever done value was stored (backward compat)
          }
          ver.progress = calculateProgress(ver.items || []);
        }

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
    const { action, version, title, status, items, order, versionType } = body;
    // #1214: owner is OPTIONAL on the wire. When omitted, we preserve the
    // existing row's owner (COALESCE on update) and persist NULL on insert.
    const ownerProvided = Object.prototype.hasOwnProperty.call(body, 'owner');
    const ownerValue: string | null = ownerProvided
      ? (typeof body.owner === 'string' && body.owner.trim().length > 0 ? body.owner : null)
      : null;

    // Validate version on any action that takes one (upsert/delete).
    // Accepts CalVer (YYYY.MM.DD or YYYY.MM.DD.N) and SemVer (MAJOR.MINOR.PATCH).
    // No `v` prefix, no 2-part shortcuts. Callers must send canonical form.
    if ((action === 'upsert' || action === 'delete') && version !== undefined) {
      const isValid =
        typeof version === 'string' &&
        !version.startsWith('v') &&
        isValidVersion(version);
      if (!isValid) {
        return NextResponse.json(
          {
            error: 'invalid_version',
            message: `Version "${version}" is not a valid version. Use CalVer (e.g. 2026.04.22) or SemVer (e.g. 0.15.0). No "v" prefix.`,
          },
          { status: 400 },
        );
      }
    }

    // Authenticate request (supports both session cookies and API keys)
    const authError = await authenticateRequest(req);
    if (authError) {
      return authError;
    }

    // 410 compat: archived qa-fold projects
    const storeForArchiveCheck = await getStoreProvider().read();
    const archPostCheck = checkArchivedProject(storeForArchiveCheck.projects, projectId);
    if (archPostCheck.migrated) {
      return NextResponse.json(
        { error: 'Project moved', migratedTo: archPostCheck.migratedTo },
        { status: 410 }
      );
    }

    if (process.env.DATABASE_URL) {
      // Use Postgres
      const { Pool } = await import('pg');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      const client = await pool.connect();

      try {
        if (action === 'upsert') {
          const versionId = `rv-${projectId}-${version.replace(/\./g, '-')}`;
          const sortOrder = versionSortKey(version);

          // Ensure every item has an id. Older items were stored as {title, done, taskId}
          // with no id field; agents hitting the API couldn't create versioned tasks against
          // them (403 roadmapItemId required). Auto-mint here is safe: the UI's lazy-mint
          // flow uses the same id shape, and ids are only added, never changed.
          const itemsWithIds = (items || []).map((it: any) => {
            if (it && typeof it === 'object' && !it.id) {
              const newId = `item-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
              return { ...it, id: newId };
            }
            return it;
          });

          const resolvedVersionType = versionType || 'outcome';
          await client.query(
            `INSERT INTO org_studio_roadmap_versions 
              (id, project_id, version, title, status, items, sort_order, created_at, version_type, workspace_id, owner)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (project_id, version) DO UPDATE SET
              title = EXCLUDED.title,
              status = EXCLUDED.status,
              items = EXCLUDED.items,
              sort_order = EXCLUDED.sort_order,
              version_type = EXCLUDED.version_type,
              -- #1214: only overwrite owner when caller explicitly provided it.
              -- COALESCE(EXCLUDED.owner, existing) preserves owner across
              -- partial updates that omit the field.
              owner = COALESCE(EXCLUDED.owner, org_studio_roadmap_versions.owner)`,
            [
              versionId,
              projectId,
              version,
              title,
              status,
              JSON.stringify(itemsWithIds),
              sortOrder,
              Date.now(),
              resolvedVersionType,
              'default-workspace', // TODO(v0.17-multi-workspace): resolve from request context
              // EXCLUDED.owner becomes this value; it's NULL when omitted so
              // COALESCE falls through to the existing column.
              ownerProvided ? ownerValue : null,
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

          await notifyRoadmapChange(client, projectId, action, version);
          return NextResponse.json({
            action: 'upserted',
            version,
            id: versionId,
            version_type: resolvedVersionType,
            owner: ownerProvided ? ownerValue : undefined,
          });
        } else if (action === 'delete') {
          await client.query(
            'DELETE FROM org_studio_roadmap_versions WHERE project_id = $1 AND version = $2 AND workspace_id = $3',
            [projectId, version, 'default-workspace']
          );

          await notifyRoadmapChange(client, projectId, action, version);
          return NextResponse.json({ action: 'deleted', version });
        } else if (action === 'reorder') {
          // Update sort_order for each version in the order array
          // sort_order ASC = first in array appears first
          for (let i = 0; i < order.length; i++) {
            await client.query(
              'UPDATE org_studio_roadmap_versions SET sort_order = $1 WHERE project_id = $2 AND version = $3 AND workspace_id = $4',
              [i + 1, projectId, order[i], 'default-workspace']
            );
          }

          await notifyRoadmapChange(client, projectId, action);
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

/**
 * Best-effort NOTIFY so subscribed clients (server.mjs LISTEN handler in
 * particular) refresh their cached store after a roadmap mutation. Without
 * this, `component.versions[]` (hydrated from rv-table on store read in
 * #1125) stays stale on the dashboard until the next unrelated store write
 * triggers a NOTIFY. Symptom: edit/save a version title, refresh, see old
 * title from the cached store — even though Postgres has the new value.
 */
async function notifyRoadmapChange(
  client: any,
  projectId: string,
  action: string,
  version?: string,
): Promise<void> {
  try {
    const payload = JSON.stringify({
      type: 'roadmap_update',
      action,
      projectId,
      ...(version ? { version } : {}),
      timestamp: Date.now(),
      source: 'roadmap-route',
      workspace_id: 'default-workspace',
    });
    await client.query(
      `NOTIFY org_studio_change, '${payload.replace(/'/g, "''")}'`,
    );
  } catch {
    // best-effort — don't fail the user-facing write on a NOTIFY hiccup
  }
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
      // Sort ascending by explicit sort_order when present, else by semver
      versions.sort((a: RoadmapVersion, b: RoadmapVersion) => {
        if (a.sort_order != null && b.sort_order != null) return a.sort_order - b.sort_order;
        if (a.sort_order != null) return -1;
        if (b.sort_order != null) return 1;
        return compareVersions(a.version, b.version);
      });
      return versions.map((v: any) => ({
        ...v,
        version_type: v.version_type || 'outcome',
      }));
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
      const { version, title, status, items, versionType } = payload;
      const idx = data.versions.findIndex((v: any) => v.version === version);

      // Mirror the Postgres path: auto-mint ids for items that don't have one.
      const itemsWithIds = (items || []).map((it: any) => {
        if (it && typeof it === 'object' && !it.id) {
          const newId = `item-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
          return { ...it, id: newId };
        }
        return it;
      });

      // #1216: mirror Postgres COALESCE-on-update semantics for owner so the
      // fs fallback path also preserves owner across partial updates.
      const ownerProvidedFs = Object.prototype.hasOwnProperty.call(payload, 'owner');
      const ownerValueFs: string | null = ownerProvidedFs
        ? (typeof payload.owner === 'string' && payload.owner.trim().length > 0 ? payload.owner : null)
        : null;
      const existingOwner = idx >= 0 ? (data.versions[idx]?.owner ?? null) : null;
      const resolvedOwner = ownerProvidedFs ? ownerValueFs : existingOwner;

      const newVersion = {
        id: `rv-${projectId}-${version.replace(/\./g, '-')}`,
        version,
        title,
        status,
        items: itemsWithIds,
        sort_order: versionSortKey(version),
        version_type: versionType || 'outcome',
        owner: resolvedOwner,
      };

      if (idx >= 0) {
        data.versions[idx] = newVersion;
      } else {
        data.versions.push(newVersion);
      }

      data.versions.sort((a: any, b: any) => {
        if (a.sort_order != null && b.sort_order != null) return a.sort_order - b.sort_order;
        if (a.sort_order != null) return -1;
        if (b.sort_order != null) return 1;
        return compareVersions(a.version, b.version);
      });
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
      data.versions = order.map((v: string, i: number) => {
        const ver: any = versionMap.get(v);
        if (ver) ver.sort_order = i + 1;
        return ver;
      }).filter(Boolean);

      fs.writeFileSync(roadmapPath, JSON.stringify(data, null, 2));

      return NextResponse.json({ action: 'reordered', order });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err: any) {
    console.error('Error handling file-based roadmap:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
