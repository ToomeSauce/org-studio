import { NextRequest, NextResponse } from 'next/server';
import { getStoreProvider } from '@/lib/store-provider';
import { authenticateRequest } from '@/lib/auth';
import { checkArchivedProject } from '@/lib/archived-project-compat';
import { versionSortKey, compareVersions, isValidVersion } from '@/lib/version-utils';
import { renameVersionInProjectData, rvDerivedId } from '@/lib/roadmap-rename';
import { syncProjectShadowVersion } from '@/lib/roadmap-sync';

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
  // #1263 — outcome-bound fields lifted from `meta` jsonb on read.
  successCriteria?: string;
  metricCurrent?: number;
  metricTarget?: number;
  metricComparator?: 'gte' | 'lte' | 'eq';
  loopPaused?: boolean;
  systemComments?: Array<{ at: number; text: string }>;
  metricNotMetCommentedAt?: number;
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
          `SELECT id, version, title, status, items, shipped_at, sort_order, version_type, owner, meta
           FROM org_studio_roadmap_versions
           WHERE project_id = $1 AND workspace_id = $2
           ORDER BY sort_order ASC, version ASC`,
          [projectId, 'default-workspace'] // TODO(v0.17-multi-workspace): resolve from request context
        );

        const versions: RoadmapVersion[] = result.rows.map((row: any) => {
          const meta = (row.meta && typeof row.meta === 'object') ? row.meta : {};
          return {
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
            // #1263 — lift outcome-bound fields from meta jsonb so callers
            // (UI + auto-advance code paths that read the GET response) see
            // them on the version object directly.
            ...(meta.successCriteria !== undefined ? { successCriteria: meta.successCriteria } : {}),
            ...(meta.metricCurrent !== undefined ? { metricCurrent: meta.metricCurrent } : {}),
            ...(meta.metricTarget !== undefined ? { metricTarget: meta.metricTarget } : {}),
            ...(meta.metricComparator !== undefined ? { metricComparator: meta.metricComparator } : {}),
            ...(meta.loopPaused !== undefined ? { loopPaused: meta.loopPaused } : {}),
            ...(Array.isArray(meta.systemComments) ? { systemComments: meta.systemComments } : {}),
          };
        });

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
        // #1381 — also map taskId → ticketNumber so we can render (#NNN) server-side.
        const taskNumberById = new Map(allTasks.map((t: any) => [t.id, t.ticketNumber]));

        // Now override done on each item based on linked task
        for (const ver of versions) {
          for (const item of ver.items || []) {
            if (item.taskId) {
              const taskStatus = taskStatusById.get(item.taskId);
              item.done = taskStatus === 'done';
              // #1381 — surface taskTicketNumber + a server-rendered displayTitle
              // so UI sites no longer need to keep (#NNN) baked into the stored
              // title string. We also strip any already-baked (#NNN) suffix from
              // the rendered string to avoid double-rendering during the
              // transition window (some legacy items have "Foo (#577)" in
              // their stored title from the old manual workflow).
              const tn = taskNumberById.get(item.taskId);
              if (typeof tn === 'number') {
                (item as any).taskTicketNumber = tn;
                const baseTitle = typeof item.title === 'string'
                  ? item.title.replace(/\s*\(#\d+\)\s*$/, '')
                  : '';
                (item as any).displayTitle = baseTitle ? `${baseTitle} (#${tn})` : `(#${tn})`;
              }
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
    const { action, version, title, status, items, order, versionType, originalVersion } = body;
    // #1214: owner is OPTIONAL on the wire. When omitted, we preserve the
    // existing row's owner (COALESCE on update) and persist NULL on insert.
    const ownerProvided = Object.prototype.hasOwnProperty.call(body, 'owner');
    const ownerValue: string | null = ownerProvided
      ? (typeof body.owner === 'string' && body.owner.trim().length > 0 ? body.owner : null)
      : null;

    // #1263 — outcome-bound version fields. All optional; validated when
    // present so bad payloads return 400 instead of corrupting `meta` jsonb.
    // We track which keys the caller actually sent so we can do a partial
    // merge (preserving existing meta keys the caller didn't touch).
    const META_KEYS = ['successCriteria', 'metricCurrent', 'metricTarget', 'metricComparator', 'loopPaused'] as const;
    const metaProvided: Record<string, boolean> = {};
    const metaInput: Record<string, any> = {};
    for (const k of META_KEYS) {
      if (Object.prototype.hasOwnProperty.call(body, k)) {
        metaProvided[k] = true;
        metaInput[k] = (body as any)[k];
      }
    }
    if (action === 'upsert') {
      if (metaProvided.successCriteria && metaInput.successCriteria != null && typeof metaInput.successCriteria !== 'string') {
        return NextResponse.json({ error: 'successCriteria must be a string' }, { status: 400 });
      }
      for (const numKey of ['metricCurrent', 'metricTarget'] as const) {
        if (metaProvided[numKey] && metaInput[numKey] != null && (typeof metaInput[numKey] !== 'number' || !Number.isFinite(metaInput[numKey]))) {
          return NextResponse.json({ error: `${numKey} must be a finite number` }, { status: 400 });
        }
      }
      if (metaProvided.metricComparator && metaInput.metricComparator != null && !['gte', 'lte', 'eq'].includes(metaInput.metricComparator)) {
        return NextResponse.json({ error: "metricComparator must be one of 'gte','lte','eq'" }, { status: 400 });
      }
      if (metaProvided.loopPaused && metaInput.loopPaused != null && typeof metaInput.loopPaused !== 'boolean') {
        return NextResponse.json({ error: 'loopPaused must be a boolean' }, { status: 400 });
      }
    }

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
          // #1267: rename path — a version-string change should rename
          // the existing rv-row + retag tasks + rewrite the project's
          // shadow refs, NOT insert a new row alongside the old one.
          const isRename =
            typeof originalVersion === 'string' &&
            originalVersion.length > 0 &&
            originalVersion !== version;
          if (isRename) {
            const ws = 'default-workspace';
            const oldId = rvDerivedId(projectId, originalVersion);
            const newId = rvDerivedId(projectId, version);
            const newSortOrder = versionSortKey(version);

            try {
              await client.query('BEGIN');

              // Source must exist.
              const srcRes = await client.query(
                `SELECT id, title, status, items, version_type, owner
                   FROM org_studio_roadmap_versions
                  WHERE project_id = $1 AND version = $2 AND workspace_id = $3
                  FOR UPDATE`,
                [projectId, originalVersion, ws],
              );
              if (srcRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return NextResponse.json(
                  {
                    error: 'rename_source_missing',
                    message: `Version "${originalVersion}" not found for project ${projectId}.`,
                  },
                  { status: 404 },
                );
              }

              // Target must NOT exist.
              const tgtRes = await client.query(
                `SELECT 1 FROM org_studio_roadmap_versions
                  WHERE project_id = $1 AND version = $2 AND workspace_id = $3`,
                [projectId, version, ws],
              );
              if (tgtRes.rows.length > 0) {
                await client.query('ROLLBACK');
                return NextResponse.json(
                  {
                    error: 'rename_target_exists',
                    message: `Version "${version}" already exists. Cannot rename onto an existing version.`,
                  },
                  { status: 409 },
                );
              }

              // Auto-mint item ids — same convention as the upsert path.
              const itemsWithIds = (items || []).map((it: any) => {
                if (it && typeof it === 'object' && !it.id) {
                  const newItemId = `item-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
                  return { ...it, id: newItemId };
                }
                return it;
              });

              const resolvedVersionType = versionType || 'outcome';

              // Rewrite the rv row (id + version + content). We key on the
              // OLD id so we update the existing row in place.
              await client.query(
                `UPDATE org_studio_roadmap_versions
                    SET id = $1,
                        version = $2,
                        title = $3,
                        status = $4,
                        items = $5,
                        sort_order = $6,
                        version_type = $7,
                        owner = COALESCE($8, owner)
                  WHERE id = $9 AND workspace_id = $10`,
                [
                  newId,
                  version,
                  title,
                  status,
                  JSON.stringify(itemsWithIds),
                  newSortOrder,
                  resolvedVersionType,
                  ownerProvided ? ownerValue : null,
                  oldId,
                  ws,
                ],
              );

              // Retag tasks.
              const tasksRes = await client.query(
                `UPDATE org_studio_tasks
                    SET version = $1
                  WHERE project_id = $2 AND version = $3 AND workspace_id = $4`,
                [version, projectId, originalVersion, ws],
              );
              const tasksMigrated = tasksRes.rowCount ?? 0;

              // Rewrite the project jsonb (components/sections/etc).
              const projRes = await client.query(
                `SELECT data FROM org_studio_projects
                  WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
                [projectId, ws],
              );
              let projectFieldsRewritten = {
                components: 0,
                sections: 0,
                approvedVersionsHits: 0,
                autonomyApprovedThrough: false,
                currentVersion: false,
              };
              if (projRes.rows.length > 0) {
                const raw = projRes.rows[0].data;
                const dataObj =
                  raw == null
                    ? {}
                    : typeof raw === 'string'
                      ? JSON.parse(raw)
                      : raw;
                const result = renameVersionInProjectData(
                  dataObj,
                  projectId,
                  originalVersion,
                  version,
                );
                await client.query(
                  `UPDATE org_studio_projects SET data = $1 WHERE id = $2 AND workspace_id = $3`,
                  [JSON.stringify(result.data), projectId, ws],
                );
                projectFieldsRewritten = {
                  components: result.componentsHits,
                  sections: result.sectionsHits,
                  approvedVersionsHits: result.approvedVersionsHits,
                  autonomyApprovedThrough: result.autonomyApprovedThrough,
                  currentVersion: result.currentVersion,
                };
              }

              await client.query('COMMIT');

              // Sync currentVersion AFTER the rename so the new string is
              // what gets written to the project record.
              if (status === 'current') {
                try {
                  const storeRes = await fetch(
                    `http://localhost:${process.env.PORT || 4501}/api/store`,
                    {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        ...(process.env.ORG_STUDIO_API_KEY
                          ? { Authorization: `Bearer ${process.env.ORG_STUDIO_API_KEY}` }
                          : {}),
                      },
                      body: JSON.stringify({
                        action: 'updateProject',
                        id: projectId,
                        updates: { currentVersion: version },
                      }),
                    },
                  );
                  if (!storeRes.ok)
                    console.warn(
                      `[Roadmap] Failed to sync currentVersion to project after rename: ${storeRes.status}`,
                    );
                } catch (e) {
                  console.warn(
                    '[Roadmap] Failed to sync currentVersion to project after rename:',
                    e,
                  );
                }
              }

              // NOTIFY: roadmap_update with action:'rename' (extra
              // originalVersion field for listeners that care) plus a
              // project_update so cached store refreshes pick up the
              // jsonb rewrite.
              await notifyRoadmapChange(
                client,
                projectId,
                'rename',
                version,
                originalVersion,
              );
              await notifyProjectChange(client, projectId);

              return NextResponse.json({
                action: 'renamed',
                originalVersion,
                version,
                id: newId,
                // #1379 — echo items (with auto-minted ids) so callers don't have
                // to GET the roadmap afterwards just to learn what ids the server
                // assigned. Same shape as GET .versions[].items.
                items: itemsWithIds,
                tasksMigrated,
                projectFieldsRewritten,
              });
            } catch (e) {
              try {
                await client.query('ROLLBACK');
              } catch {}
              throw e;
            }
          }

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

          // #1263: read existing meta so we can do a partial merge AND emit
          // a measurement-update system comment when only metricCurrent changed.
          const existingMetaRes = await client.query(
            `SELECT meta FROM org_studio_roadmap_versions WHERE project_id = $1 AND version = $2 AND workspace_id = $3 LIMIT 1`,
            [projectId, version, 'default-workspace'],
          );
          const existingMeta: any = (existingMetaRes.rows[0]?.meta && typeof existingMetaRes.rows[0].meta === 'object')
            ? existingMetaRes.rows[0].meta
            : {};
          const mergedMeta: any = { ...existingMeta };
          for (const k of META_KEYS) {
            if (metaProvided[k]) {
              if (metaInput[k] === null || metaInput[k] === undefined) {
                delete mergedMeta[k];
              } else {
                mergedMeta[k] = metaInput[k];
              }
            }
          }

          // Auto system comment when metricCurrent was the only thing
          // updated (or when it was updated alongside criteria fields). The
          // "only metricCurrent changed" detection is best-effort: if the
          // caller sent a different value for metricCurrent than what was
          // stored, we log a system comment.
          const prevCurrent = existingMeta.metricCurrent;
          const newCurrent = mergedMeta.metricCurrent;
          if (
            metaProvided.metricCurrent &&
            typeof newCurrent === 'number' &&
            prevCurrent !== newCurrent
          ) {
            const target = mergedMeta.metricTarget;
            const comp = mergedMeta.metricComparator || 'gte';
            // Inline metric check (avoid importing test-only helpers).
            let met = false;
            if (typeof target === 'number') {
              met = comp === 'lte' ? newCurrent <= target
                  : comp === 'eq' ? newCurrent === target
                  : newCurrent >= target;
            }
            const txt = `Measurement updated: ${newCurrent}` +
              (typeof prevCurrent === 'number' ? ` (was ${prevCurrent})` : '') +
              (typeof target === 'number' ? ` — metric ${met ? 'met' : 'not met'} (target ${comp} ${target})` : '');
            const list = Array.isArray(mergedMeta.systemComments) ? mergedMeta.systemComments : [];
            list.push({ at: Date.now(), text: txt });
            mergedMeta.systemComments = list;
          }

          // Whether to write the meta column at all. If caller didn't touch
          // any meta keys AND no existing meta exists, leave the column NULL
          // so we don't churn the row. Otherwise pass the merged value.
          const anyProvided = META_KEYS.some((k) => metaProvided[k]);
          const writeMeta = anyProvided || existingMetaRes.rows.length > 0;
          const metaJson = writeMeta && Object.keys(mergedMeta).length > 0 ? JSON.stringify(mergedMeta) : null;

          await client.query(
            `INSERT INTO org_studio_roadmap_versions 
              (id, project_id, version, title, status, items, sort_order, created_at, version_type, workspace_id, owner, meta)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
             ON CONFLICT (project_id, version) DO UPDATE SET
              title = EXCLUDED.title,
              status = EXCLUDED.status,
              items = EXCLUDED.items,
              sort_order = EXCLUDED.sort_order,
              version_type = EXCLUDED.version_type,
              owner = COALESCE(EXCLUDED.owner, org_studio_roadmap_versions.owner),
              -- #1263: meta is replaced with the (already-merged) value when
              -- any meta key was sent, otherwise left as-is. Sentinel: NULL
              -- here means "don't change".
              meta = COALESCE(EXCLUDED.meta, org_studio_roadmap_versions.meta)`,
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
              'default-workspace',
              ownerProvided ? ownerValue : null,
              anyProvided ? metaJson : null,
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

          // #1314: keep project.sections[].versions and components[].versions
          // in lock-step with the canonical row we just wrote. Without this,
          // the API returns 200 but the dashboard renders stale roadmaps
          // until the 15-min reconcile cron runs (and that cron only fixes
          // item.done flags, not new version rows). Trevor caught this on
          // Thrivor 2026-05-12 — 6 versions sat invisible for hours.
          let shadowSync: { sectionsHit: number; componentsHit: number; touched: boolean } = {
            sectionsHit: 0, componentsHit: 0, touched: false,
          };
          try {
            shadowSync = await syncProjectShadowVersion(client, projectId, 'upsert', version, {
              id: versionId,
              version,
              title,
              status,
              items: itemsWithIds,
              sort_order: sortOrder,
              version_type: resolvedVersionType,
              owner: ownerProvided ? ownerValue : null,
            });
          } catch (e) {
            console.warn('[Roadmap] Shadow sync failed (non-fatal, reconcile cron will heal):', (e as any)?.message || e);
          }

          await notifyRoadmapChange(client, projectId, action, version);
          // #1314: emit project_update too so the cached store refreshes the
          // shadow we just rewrote (roadmap_update alone doesn't reload
          // project.sections jsonb on the server-side cache).
          if (shadowSync.touched) {
            await notifyProjectChange(client, projectId);
          }
          // #1382 — nudge callers using upsert as a poor man's per-item
          // editor toward the new PATCH endpoint. Heuristic: items provided
          // and no version-level field was touched. Warn, don't break.
          const looksLikeItemLevelEdit =
            Array.isArray(items) &&
            items.length > 0 &&
            title == null &&
            status == null &&
            versionType == null &&
            !ownerProvided &&
            !META_KEYS.some((k) => metaProvided[k]);
          const warning = looksLikeItemLevelEdit
            ? 'Upsert was used for item-level edits (no version-level fields touched). Prefer PATCH /api/roadmap/{projectId}/versions/{version}/items — race-safe per-item add/update/remove instead of replace-all. (#1382)'
            : undefined;
          return NextResponse.json({
            action: 'upserted',
            version,
            id: versionId,
            version_type: resolvedVersionType,
            owner: ownerProvided ? ownerValue : undefined,
            // #1379 — echo items (with auto-minted ids) so callers can pick them
            // up directly instead of GETting the roadmap afterwards. The skill text
            // ("A server-side auto-mint on upsert is planned") was out of date;
            // mint has been live for a while, the response just didn't surface it.
            items: itemsWithIds,
            shadowSync,
            ...(warning ? { warning } : {}),
          });
        } else if (action === 'delete') {
          await client.query(
            'DELETE FROM org_studio_roadmap_versions WHERE project_id = $1 AND version = $2 AND workspace_id = $3',
            [projectId, version, 'default-workspace']
          );

          // #1314: also strip the version from project shadows so the UI
          // doesn't keep showing a deleted version until the next reconcile.
          let shadowSync: { sectionsHit: number; componentsHit: number; touched: boolean } = {
            sectionsHit: 0, componentsHit: 0, touched: false,
          };
          try {
            shadowSync = await syncProjectShadowVersion(client, projectId, 'delete', version);
          } catch (e) {
            console.warn('[Roadmap] Shadow sync (delete) failed (non-fatal):', (e as any)?.message || e);
          }

          await notifyRoadmapChange(client, projectId, action, version);
          if (shadowSync.touched) {
            await notifyProjectChange(client, projectId);
          }
          return NextResponse.json({ action: 'deleted', version, shadowSync });
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
      return handleFileBasedRoadmap(projectId, action, { version, title, status, items, order, originalVersion, versionType, owner: ownerProvided ? ownerValue : undefined });
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
  originalVersion?: string,
): Promise<void> {
  try {
    const payload = JSON.stringify({
      type: 'roadmap_update',
      action,
      projectId,
      ...(version ? { version } : {}),
      // #1267: rename listeners can compare original→new without breaking
      // existing consumers that ignore unknown fields.
      ...(originalVersion ? { originalVersion } : {}),
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

/**
 * #1267: ping listeners that the project jsonb changed (rename rewrites
 * components/sections/approvedVersions). Mirrors the roadmap_update
 * payload shape.
 */
async function notifyProjectChange(
  client: any,
  projectId: string,
): Promise<void> {
  try {
    const payload = JSON.stringify({
      type: 'project_update',
      projectId,
      timestamp: Date.now(),
      source: 'roadmap-route',
      workspace_id: 'default-workspace',
    });
    await client.query(
      `NOTIFY org_studio_change, '${payload.replace(/'/g, "''")}'`,
    );
  } catch {
    // best-effort
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
      const { version, title, status, items, versionType, originalVersion } = payload;

      // #1267: file-mode rename support. Tasks are Postgres-only in
      // practice, so tasksMigrated is always 0 here.
      const isRename =
        typeof originalVersion === 'string' &&
        originalVersion.length > 0 &&
        originalVersion !== version;
      if (isRename) {
        const tgtIdx = data.versions.findIndex((v: any) => v.version === version);
        if (tgtIdx >= 0) {
          return NextResponse.json(
            {
              error: 'rename_target_exists',
              message: `Version "${version}" already exists. Cannot rename onto an existing version.`,
            },
            { status: 409 },
          );
        }
        const srcIdx = data.versions.findIndex((v: any) => v.version === originalVersion);
        if (srcIdx < 0) {
          return NextResponse.json(
            {
              error: 'rename_source_missing',
              message: `Version "${originalVersion}" not found for project ${projectId}.`,
            },
            { status: 404 },
          );
        }
        const itemsWithIds = (items || []).map((it: any) => {
          if (it && typeof it === 'object' && !it.id) {
            const newItemId = `item-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
            return { ...it, id: newItemId };
          }
          return it;
        });
        const ownerProvidedFs2 = Object.prototype.hasOwnProperty.call(payload, 'owner') && payload.owner !== undefined;
        const existing = data.versions[srcIdx] || {};
        data.versions[srcIdx] = {
          ...existing,
          id: `rv-${projectId}-${version.replace(/\./g, '-')}`,
          version,
          title,
          status,
          items: itemsWithIds,
          sort_order: versionSortKey(version),
          version_type: versionType || existing.version_type || 'outcome',
          owner: ownerProvidedFs2 ? payload.owner : (existing.owner ?? null),
        };
        data.versions.sort((a: any, b: any) => {
          if (a.sort_order != null && b.sort_order != null) return a.sort_order - b.sort_order;
          if (a.sort_order != null) return -1;
          if (b.sort_order != null) return 1;
          return compareVersions(a.version, b.version);
        });
        fs.writeFileSync(roadmapPath, JSON.stringify(data, null, 2));
        return NextResponse.json({
          action: 'renamed',
          originalVersion,
          version,
          id: `rv-${projectId}-${version.replace(/\./g, '-')}`,
          // #1379 — echo items (with auto-minted ids) so callers can pick them
          // up directly. Mirrors the Postgres path.
          items: itemsWithIds,
          tasksMigrated: 0,
          projectFieldsRewritten: {
            components: 0,
            sections: 0,
            approvedVersionsHits: 0,
            autonomyApprovedThrough: false,
            currentVersion: false,
          },
        });
      }

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

      return NextResponse.json({ action: 'upserted', version, items: itemsWithIds });
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
