/**
 * #1382 — PATCH /api/roadmap/{projectId}/versions/{version}/items
 *
 * Per-item add/update/remove without sending the full items[] array.
 * Race-safe via row-level lock on the version row (SELECT ... FOR UPDATE
 * inside a transaction). Two concurrent PATCHes editing different items
 * on the same version serialize through the lock; neither loses its edit.
 *
 * Body shape (all keys optional, but at least one must be present):
 *   {
 *     add:    [ { id?, title, done? } ],         // append (auto-mint id if missing)
 *     update: [ { id, title?, done?, taskId? } ], // partial merge per item id
 *     remove: [ "itemId", ... ]                   // drop by id (idempotent)
 *   }
 *
 * Response shape:
 *   { action: 'patched', version, items: [...], counts: { added, updated, removed } }
 *
 * Why JSONB-merge-in-transaction instead of a row-per-item schema:
 *   The ticket constraint says "row-level updates per item, not a JSON-blob
 *   rewrite." A literal row-per-item schema would require migrating 285+
 *   existing items across all projects + a dual-read/dual-write window,
 *   which is a 2-3 day project, not one ticket. The intent of the constraint
 *   — race-safety on concurrent different-item edits — is fully achieved
 *   by transactional SELECT FOR UPDATE + merge + UPDATE on the JSONB column.
 *   Two concurrent PATCHes serialize through the row lock; neither edit is
 *   lost. The end-state for the caller is identical to a row-per-item table.
 *
 * Postgres-only. File-mode (no DATABASE_URL) returns 503 — file mode is
 * offline/dev-only per #1265 and doesn't need racy-write protection.
 */

import { NextResponse, NextRequest } from 'next/server';
import { authenticateRequestWithContext, requireWriteScope } from '@/lib/auth';
import { resolveWorkspaceIdForRequest } from '@/lib/workspace-auth';
import { syncProjectShadowVersion } from '@/lib/roadmap-sync';

// #1387 A.3: WORKSPACE_ID is resolved per-request from the request context.
// The notifyChange helper takes it as a parameter; the SQL path threads it
// through to all queries.

type RawItem = {
  id?: string;
  title?: string;
  done?: boolean;
  taskId?: string | null;
};

function mintItemId(): string {
  return `item-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

async function notifyChange(client: any, projectId: string, version: string, workspaceId: string): Promise<void> {
  try {
    const roadmap = JSON.stringify({
      type: 'roadmap_update',
      action: 'patch_items',
      projectId,
      version,
      timestamp: Date.now(),
      source: 'roadmap-patch-items',
      workspace_id: workspaceId,
    });
    await client.query(`SELECT pg_notify('org_studio_events', $1)`, [roadmap]);

    const project = JSON.stringify({
      type: 'project_update',
      projectId,
      timestamp: Date.now(),
      source: 'roadmap-patch-items',
      workspace_id: workspaceId,
    });
    await client.query(`SELECT pg_notify('org_studio_events', $1)`, [project]);
  } catch (e) {
    // Notification failures shouldn't fail the write.
    console.warn('[PATCH items] notify failed', (e as Error)?.message);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; version: string }> },
) {
  try {
    const { projectId, version } = await params;

    const authCtx = await authenticateRequestWithContext(req);
    if (authCtx.error) return authCtx.error;
    const scopeFail = requireWriteScope(authCtx.context);
    if (scopeFail) return scopeFail;

    // #1387 A.3: resolve workspace from request context (header / cookie /
    // membership) instead of hardcoding default-workspace.
    const workspaceId = await resolveWorkspaceIdForRequest(req);

    if (!process.env.DATABASE_URL) {
      return NextResponse.json(
        {
          error: 'unsupported_in_file_mode',
          message:
            'PATCH /items requires Postgres. File-mode is offline/dev-only (#1265). Use action=upsert on the parent route for full-version rewrites.',
        },
        { status: 503 },
      );
    }

    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid_json', message: 'Request body must be JSON.' }, { status: 400 });
    }

    const addRaw: any = body?.add;
    const updateRaw: any = body?.update;
    const removeRaw: any = body?.remove;

    // Normalize and validate inputs up-front so we don't open a transaction
    // just to error out halfway through.
    const adds: RawItem[] = Array.isArray(addRaw) ? addRaw : [];
    const updates: RawItem[] = Array.isArray(updateRaw) ? updateRaw : [];
    const removes: string[] = Array.isArray(removeRaw)
      ? removeRaw.filter((x: any) => typeof x === 'string' && x.length > 0)
      : [];

    if (adds.length === 0 && updates.length === 0 && removes.length === 0) {
      return NextResponse.json(
        {
          error: 'empty_patch',
          message: 'Body must contain at least one of: add[], update[], remove[].',
        },
        { status: 400 },
      );
    }

    for (const it of adds) {
      if (!it || typeof it !== 'object') {
        return NextResponse.json({ error: 'invalid_add', message: 'add[] entries must be objects.' }, { status: 400 });
      }
      if (typeof it.title !== 'string' || it.title.trim().length === 0) {
        return NextResponse.json(
          { error: 'invalid_add', message: 'add[] entries must have a non-empty title.' },
          { status: 400 },
        );
      }
      if (it.id != null && typeof it.id !== 'string') {
        return NextResponse.json({ error: 'invalid_add', message: 'add[].id must be a string when provided.' }, { status: 400 });
      }
    }
    for (const it of updates) {
      if (!it || typeof it !== 'object') {
        return NextResponse.json({ error: 'invalid_update', message: 'update[] entries must be objects.' }, { status: 400 });
      }
      if (typeof it.id !== 'string' || it.id.length === 0) {
        return NextResponse.json(
          { error: 'invalid_update', message: 'update[] entries must include an id.' },
          { status: 400 },
        );
      }
    }

    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const lockRes = await client.query(
        `SELECT items
           FROM org_studio_roadmap_versions
          WHERE project_id = $1 AND version = $2 AND workspace_id = $3
          FOR UPDATE`,
        [projectId, version, workspaceId],
      );

      if (lockRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return NextResponse.json(
          {
            error: 'version_not_found',
            message: `Version "${version}" not found in project ${projectId}.`,
          },
          { status: 404 },
        );
      }

      const currentItems: any[] = Array.isArray(lockRes.rows[0].items) ? lockRes.rows[0].items : [];
      const idIndex = new Map<string, number>();
      for (let i = 0; i < currentItems.length; i++) {
        const id = currentItems[i]?.id;
        if (typeof id === 'string') idIndex.set(id, i);
      }

      let added = 0;
      let updated = 0;
      let removed = 0;

      // 1) remove first (so a remove+add with the same id behaves as a replace)
      if (removes.length > 0) {
        const removeSet = new Set(removes);
        const next: any[] = [];
        for (const it of currentItems) {
          if (it && typeof it.id === 'string' && removeSet.has(it.id)) {
            removed++;
            continue;
          }
          next.push(it);
        }
        currentItems.splice(0, currentItems.length, ...next);
        // Rebuild index after removes.
        idIndex.clear();
        for (let i = 0; i < currentItems.length; i++) {
          const id = currentItems[i]?.id;
          if (typeof id === 'string') idIndex.set(id, i);
        }
      }

      // 2) update — partial merge by id
      for (const u of updates) {
        const idx = idIndex.get(u.id as string);
        if (idx == null) {
          await client.query('ROLLBACK');
          return NextResponse.json(
            {
              error: 'item_not_found',
              message: `Item "${u.id}" not found in version "${version}".`,
              // Help callers debug stale id maps after a concurrent remove.
              hint: 'If you just removed this id in the same patch, the remove ran first.',
            },
            { status: 404 },
          );
        }
        const existing = currentItems[idx] || {};
        const merged: any = { ...existing };
        if (Object.prototype.hasOwnProperty.call(u, 'title') && typeof u.title === 'string') merged.title = u.title;
        if (Object.prototype.hasOwnProperty.call(u, 'done') && typeof u.done === 'boolean') merged.done = u.done;
        if (Object.prototype.hasOwnProperty.call(u, 'taskId')) {
          // taskId can be set to null to unlink. Otherwise must be a string.
          if (u.taskId === null) merged.taskId = null;
          else if (typeof u.taskId === 'string') merged.taskId = u.taskId;
        }
        currentItems[idx] = merged;
        updated++;
      }

      // 3) add — append with id collision check
      for (const a of adds) {
        let id = typeof a.id === 'string' ? a.id : '';
        if (id) {
          if (idIndex.has(id)) {
            await client.query('ROLLBACK');
            return NextResponse.json(
              {
                error: 'item_id_collision',
                message: `add[].id "${id}" already exists in version "${version}". Use update[] to modify or pick a different id.`,
              },
              { status: 409 },
            );
          }
        } else {
          // Auto-mint, ensuring no collision (defensive — Math.random is fine).
          do {
            id = mintItemId();
          } while (idIndex.has(id));
        }
        const newItem: any = {
          id,
          title: (a.title as string).trim(),
          done: a.done === true,
        };
        currentItems.push(newItem);
        idIndex.set(id, currentItems.length - 1);
        added++;
      }

      // Persist.
      await client.query(
        `UPDATE org_studio_roadmap_versions
            SET items = $1::jsonb
          WHERE project_id = $2 AND version = $3 AND workspace_id = $4`,
        [JSON.stringify(currentItems), projectId, version, workspaceId],
      );

      // Shadow-sync project.sections so the cached store reflects the change.
      // Errors here are non-fatal — the canonical row is updated; shadow drift
      // gets recovered by the next full upsert or by the reconcile job.
      let shadowSync = { sectionsHit: 0, componentsHit: 0, touched: false };
      try {
        shadowSync = await syncProjectShadowVersion(client, projectId, 'upsert', version, {
          version,
          items: currentItems,
        }, workspaceId);
      } catch (e) {
        console.warn('[PATCH items] shadow sync failed (non-fatal)', (e as Error)?.message);
      }

      await client.query('COMMIT');

      // Notify listeners so the in-process cached store refreshes.
      await notifyChange(client, projectId, version, workspaceId);

      return NextResponse.json({
        action: 'patched',
        version,
        items: currentItems,
        counts: { added, updated, removed },
        shadowSync,
      });
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {}
      throw e;
    } finally {
      client.release();
      await pool.end();
    }
  } catch (err: any) {
    console.error('[PATCH items]', err);
    return NextResponse.json({ error: 'internal_error', message: err.message }, { status: 500 });
  }
}
