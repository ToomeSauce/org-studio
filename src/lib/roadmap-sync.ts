/**
 * roadmap-sync.ts
 *
 * Keeps roadmap-version item `done` flags in sync with task statuses.
 *
 * When the current version's items are all done:
 *   1. Mark it shipped.
 *   2. If the next planned version is still within the approval horizon
 *      (`autonomy.approvedThrough`), promote it to `current` and move its
 *      linked planning tasks into backlog. The horizon itself is never
 *      modified here — only humans move it.
 *   3. If the next planned version is ABOVE the horizon, stop. Agent's
 *      work is done until a human bumps `approvedThrough`.
 *
 * Per docs/decisions/2026-04-19-version-numbering-convention.md:
 *   "Horizon = permission ceiling. Auto-advance within the horizon is safe;
 *    crossing the horizon is never automatic."
 *
 * Non-fatal: every public function wraps in try/catch so it never
 * breaks the task-update path.  Gracefully no-ops when DATABASE_URL
 * is unset (file-store mode with no Postgres pool).
 */

import { isVersionGreater } from './version-utils';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Get a Postgres pool, or null if DATABASE_URL is not set.
 * Re-uses the same pool instance across calls.
 */
let _pool: any = null;
function getPool(): any | null {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return null;
  if (!_pool) {
    const { Pool } = require('pg');
    _pool = new Pool({ connectionString: dbUrl, max: 5 });
  }
  return _pool;
}

/* ------------------------------------------------------------------ */
/*  syncRoadmapItemForTask                                             */
/* ------------------------------------------------------------------ */

/**
 * After a task update, flip the matching roadmap-item `done` flag.
 *
 * @param projectId - the task's projectId
 * @param taskId    - the task id
 * @param isDone    - true when the task is in `done` status
 */
export async function syncRoadmapItemForTask(
  projectId: string,
  taskId: string,
  isDone: boolean,
): Promise<void> {
  try {
    const pool = getPool();
    if (!pool) return; // file-store mode — no-op for now (file-based roadmaps rare)

    const client = await pool.connect();
    let changed = false;
    let shouldCheckAdvance = false;
    try {
      // Transaction + row-level locks to eliminate the read-modify-write race.
      // Multiple tasks on the same version completing concurrently used to
      // overwrite each other's item-done flips. SELECT ... FOR UPDATE serializes
      // concurrent syncs on the affected version rows.
      await client.query('BEGIN');

      const result = await client.query(
        `SELECT id, version, status, items, sort_order
         FROM org_studio_roadmap_versions
         WHERE project_id = $1 AND workspace_id = $2
         ORDER BY sort_order ASC
         FOR UPDATE`,
        [projectId, 'default-workspace'], // TODO(v0.17-multi-workspace): resolve from caller context
      );

      for (const row of result.rows) {
        const items: any[] = row.items || [];
        let rowChanged = false;

        for (const item of items) {
          if (item.taskId === taskId && item.done !== isDone) {
            item.done = isDone;
            rowChanged = true;
          }
        }

        if (rowChanged) {
          await client.query(
            `UPDATE org_studio_roadmap_versions SET items = $1 WHERE id = $2`,
            [JSON.stringify(items), row.id],
          );
          changed = true;
          console.log(
            `[RoadmapSync] ${projectId} ${row.version}: item ${taskId} → done=${isDone}`,
          );
        }
      }

      await client.query('COMMIT');

      // If we flipped an item to done, check whether the entire version completed.
      // Run AFTER commit so checkAndAutoAdvance observes the flushed state and can
      // take its own row locks cleanly.
      if (changed && isDone) shouldCheckAdvance = true;
    } catch (txErr: any) {
      try { await client.query('ROLLBACK'); } catch { /* best-effort */ }
      throw txErr;
    } finally {
      client.release();
    }

    if (shouldCheckAdvance) {
      await checkAndAutoAdvance(projectId);
    }
  } catch (err: any) {
    console.error('[RoadmapSync] syncRoadmapItemForTask error (non-fatal):', err?.message || err);
  }
}

/* ------------------------------------------------------------------ */
/*  checkAndAutoAdvance                                                */
/* ------------------------------------------------------------------ */

/**
 * If the current version has all items done:
 *   • Mark it shipped.
 *   • If the next planned version is ≤ horizon, promote it to `current`
 *     and move its planning tasks to backlog.
 *   • Otherwise stop — horizon is the hard ceiling.
 *
 * The horizon (`autonomy.approvedThrough`) is NEVER written by this
 * function. Only humans move the horizon.
 *
 * @param projectId - the project to check
 * @param existingClient - optional pg client to reuse (avoids extra checkout)
 */
export async function checkAndAutoAdvance(
  projectId: string,
  existingClient?: any,
): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  const client = existingClient || await pool.connect();
  const ownClient = !existingClient;

  try {
    // 1. Find the current version
    const versionResult = await client.query(
      `SELECT id, version, status, items, sort_order
       FROM org_studio_roadmap_versions
       WHERE project_id = $1 AND status = 'current' AND workspace_id = $2
       ORDER BY sort_order ASC
       LIMIT 1`,
      [projectId, 'default-workspace'], // TODO(v0.17-multi-workspace): resolve from caller context
    );

    if (versionResult.rows.length === 0) return; // no current version

    const current = versionResult.rows[0];
    const items: any[] = current.items || [];

    // All items must be done (and there must be at least one item)
    if (items.length === 0) return;
    if (!items.every((i: any) => i.done === true)) return;

    // 2. Ship the current version
    const shippedAt = Date.now();
    await client.query(
      `UPDATE org_studio_roadmap_versions SET status = 'shipped', shipped_at = $1
       WHERE id = $2 AND workspace_id = $3`,
      [String(shippedAt), current.id, 'default-workspace'],
    );
    console.log(`[VersionShip] ${projectId}: ${current.version} shipped`);

    // 3. Read project autonomy to check horizon
    const projResult = await client.query(
      `SELECT data FROM org_studio_projects WHERE id = $1 AND workspace_id = $2`,
      [projectId, 'default-workspace'],
    );
    if (projResult.rows.length === 0) return;

    const projData =
      typeof projResult.rows[0].data === 'string'
        ? JSON.parse(projResult.rows[0].data)
        : projResult.rows[0].data || {};

    const approvedThrough: string | undefined = projData.autonomy?.approvedThrough;

    // 3b. Paused-project gate: if currentVersion is explicitly null, the human has
    // paused auto-advance. Reconcile still ships the completed version (done flags
    // + status='shipped' are factual), but we do NOT promote a next version.
    if (projData.currentVersion === null || projData.currentVersion === undefined) {
      console.log(
        `[AutoAdvance] ${projectId}: project paused (currentVersion=null) — shipped ${current.version} but skipping auto-advance`,
      );
      (checkAndAutoAdvance as any)._lastSkipReason = 'paused';
      return;
    }

    // 4. No horizon = nothing is approved. Stop.
    if (!approvedThrough) {
      console.log(
        `[AutoAdvance] ${projectId}: no approvedThrough set — stopping after ${current.version}`,
      );
      return;
    }

    // 5. Find next planned version (next by sort_order)
    const nextResult = await client.query(
      `SELECT id, version, status, items, sort_order
       FROM org_studio_roadmap_versions
       WHERE project_id = $1 AND status = 'planned' AND sort_order > $2 AND workspace_id = $3
       ORDER BY sort_order ASC
       LIMIT 1`,
      [projectId, current.sort_order, 'default-workspace'],
    );

    if (nextResult.rows.length === 0) {
      console.log(
        `[AutoAdvance] ${projectId}: ${current.version} shipped — no next planned version`,
      );
      return;
    }

    const next = nextResult.rows[0];

    // 6. Horizon gate — HARD STOP if next version is above the ceiling.
    //    isVersionGreater(next, horizon) === true  ⇒  next > horizon  ⇒  stop.
    if (isVersionGreater(next.version, approvedThrough)) {
      console.log(
        `[AutoAdvance] ${projectId}: ${current.version} shipped — next ${next.version} is above horizon ${approvedThrough}, stopping`,
      );
      return;
    }

    // 7. All roadmap items must have taskIds (can't launch without tickets)
    const nextItems: any[] = next.items || [];
    const draftItems = nextItems.filter((i: any) => !i.taskId);
    if (draftItems.length > 0) {
      console.log(
        `[AutoAdvance] ${projectId}: ${next.version} has ${draftItems.length} item(s) without taskId — stopping (manual launch will alert user)`,
      );
      return;
    }

    // 8. Promote next version to current
    await client.query(
      `UPDATE org_studio_roadmap_versions SET status = 'current' WHERE id = $1 AND workspace_id = $2`,
      [next.id, 'default-workspace'],
    );

    // 9. Move linked planning tasks → backlog, set version + assignee
    const devOwner = projData.devOwner || '';
    let movedCount = 0;
    for (const item of nextItems) {
      if (!item.taskId) continue;
      try {
        const taskRes = await client.query(
          `SELECT id, status FROM org_studio_tasks WHERE id = $1 AND workspace_id = $2`,
          [item.taskId, 'default-workspace'],
        );
        if (taskRes.rows.length > 0 && taskRes.rows[0].status === 'planning') {
          await client.query(
            `UPDATE org_studio_tasks
             SET status = 'backlog',
                 version = $1,
                 assignee = COALESCE(NULLIF(assignee, ''), $2)
             WHERE id = $3 AND workspace_id = $4`,
            [next.version, devOwner, item.taskId, 'default-workspace'],
          );
          movedCount++;
        }
      } catch (taskErr: any) {
        console.error(
          `[AutoAdvance] Failed to move task ${item.taskId} to backlog:`,
          taskErr?.message,
        );
      }
    }

    // 10. Update project.currentVersion. HORIZON IS NEVER TOUCHED.
    try {
      projData.currentVersion = next.version;
      await client.query(
        `UPDATE org_studio_projects SET data = $1 WHERE id = $2 AND workspace_id = $3`,
        [JSON.stringify(projData), projectId, 'default-workspace'],
      );
    } catch (err: any) {
      console.error('[AutoAdvance] Failed to update currentVersion:', err?.message);
    }

    console.log(
      `[AutoAdvance] ${projectId}: ${current.version} → ${next.version} (horizon=${approvedThrough}, ${movedCount} tasks moved planning→backlog)`,
    );
  } catch (err: any) {
    console.error('[AutoAdvance] checkAndAutoAdvance error (non-fatal):', err?.message || err);
  } finally {
    if (ownClient) client.release();
  }
}

/* ------------------------------------------------------------------ */
/*  reconcileRoadmapItemDone                                           */
/* ------------------------------------------------------------------ */

/**
 * Cross-check every `current` roadmap version's item-done flags against
 * the underlying tasks' `status`. Fixes drift caused by missed sync calls
 * (historical bug) or any future write path that forgets to call sync.
 *
 * For each `current` version (optionally filtered by projectId):
 *   - For each item with a taskId, set item.done = (task.status === 'done').
 *   - If all items done AND version still `current` after flips, ship it.
 *   - After shipping, call checkAndAutoAdvance. Paused projects
 *     (currentVersion === null) ship the version but skip auto-advance.
 *
 * Non-fatal: wraps in try/catch. No-ops in file-store mode.
 *
 * @param projectId - optional project filter; when omitted, scans all projects.
 * @returns summary counts for logging / API response.
 */
export async function reconcileRoadmapItemDone(
  projectId?: string,
): Promise<{ scanned: number; flipped: number; shipped: number; advanced: number; skippedAdvance: number }> {
  const summary = { scanned: 0, flipped: 0, shipped: 0, advanced: 0, skippedAdvance: 0 };
  const pool = getPool();
  if (!pool) return summary;

  try {
    const client = await pool.connect();
    try {
      // 1. Find all `current` versions (optionally scoped to one project).
      const versionsRes = projectId
        ? await client.query(
            `SELECT id, project_id, version, items FROM org_studio_roadmap_versions
             WHERE status = 'current' AND workspace_id = $1 AND project_id = $2`,
            ['default-workspace', projectId],
          )
        : await client.query(
            `SELECT id, project_id, version, items FROM org_studio_roadmap_versions
             WHERE status = 'current' AND workspace_id = $1`,
            ['default-workspace'],
          );

      summary.scanned = versionsRes.rows.length;

      // 2. For each version: lock it, fetch linked task statuses, flip drifted items.
      const shippedProjectIds: string[] = [];
      for (const v of versionsRes.rows) {
        try {
          await client.query('BEGIN');

          // Re-fetch under FOR UPDATE to avoid racing with live syncs.
          const locked = await client.query(
            `SELECT id, project_id, version, items FROM org_studio_roadmap_versions
             WHERE id = $1 AND status = 'current' AND workspace_id = $2 FOR UPDATE`,
            [v.id, 'default-workspace'],
          );
          if (locked.rows.length === 0) { await client.query('COMMIT'); continue; }
          const row = locked.rows[0];
          const items: any[] = row.items || [];

          const taskIds = items.map((i: any) => i.taskId).filter(Boolean);
          const statusMap = new Map<string, string>();
          if (taskIds.length > 0) {
            const tRes = await client.query(
              `SELECT id, status FROM org_studio_tasks WHERE id = ANY($1) AND workspace_id = $2`,
              [taskIds, 'default-workspace'],
            );
            for (const t of tRes.rows) statusMap.set(t.id, t.status);
          }

          let localFlipped = 0;
          for (const item of items) {
            if (!item.taskId) continue;
            const actualStatus = statusMap.get(item.taskId);
            if (actualStatus === undefined) continue; // orphan taskId — leave as-is
            const shouldBeDone = actualStatus === 'done';
            if (item.done !== shouldBeDone) {
              item.done = shouldBeDone;
              localFlipped++;
              console.log(
                `[RoadmapSync] ${row.project_id} ${row.version}: item ${item.id} → done=${shouldBeDone} (reconcile)`,
              );
            }
          }

          if (localFlipped > 0) {
            await client.query(
              `UPDATE org_studio_roadmap_versions SET items = $1 WHERE id = $2`,
              [JSON.stringify(items), row.id],
            );
            summary.flipped += localFlipped;
          }

          // 3. If all items done and there's at least one, ship this version.
          let didShip = false;
          if (items.length > 0 && items.every((i: any) => i.done === true)) {
            const shippedAt = Date.now();
            await client.query(
              `UPDATE org_studio_roadmap_versions SET status = 'shipped', shipped_at = $1
               WHERE id = $2 AND workspace_id = $3 AND status = 'current'`,
              [String(shippedAt), row.id, 'default-workspace'],
            );
            console.log(`[VersionShip] ${row.project_id}: ${row.version} shipped (reconcile)`);
            summary.shipped++;
            didShip = true;
          }

          await client.query('COMMIT');
          if (didShip) shippedProjectIds.push(row.project_id);
        } catch (vErr: any) {
          try { await client.query('ROLLBACK'); } catch { /* best-effort */ }
          console.error(
            `[RoadmapReconcile] version ${v.id} error (non-fatal):`,
            vErr?.message || vErr,
          );
        }
      }

      // 4. For each shipped project, run auto-advance (paused projects will skip internally).
      for (const pid of shippedProjectIds) {
        try {
          // Snapshot the paused state BEFORE calling advance, so we can classify.
          const projRes = await client.query(
            `SELECT data FROM org_studio_projects WHERE id = $1 AND workspace_id = $2`,
            [pid, 'default-workspace'],
          );
          const projData =
            projRes.rows.length === 0
              ? {}
              : typeof projRes.rows[0].data === 'string'
                ? JSON.parse(projRes.rows[0].data)
                : projRes.rows[0].data || {};
          const wasPaused = projData.currentVersion === null || projData.currentVersion === undefined;

          if (wasPaused) {
            console.log(
              `[AutoAdvance] ${pid}: project paused (currentVersion=null) — shipped via reconcile but skipping auto-advance`,
            );
            summary.skippedAdvance++;
            continue;
          }

          await checkAndAutoAdvance(pid);

          // Re-read to see if currentVersion moved — proxy for a successful advance.
          const after = await client.query(
            `SELECT data FROM org_studio_projects WHERE id = $1 AND workspace_id = $2`,
            [pid, 'default-workspace'],
          );
          const afterData =
            after.rows.length === 0
              ? {}
              : typeof after.rows[0].data === 'string'
                ? JSON.parse(after.rows[0].data)
                : after.rows[0].data || {};
          if (afterData.currentVersion && afterData.currentVersion !== projData.currentVersion) {
            summary.advanced++;
          }
        } catch (advErr: any) {
          console.error(
            `[RoadmapReconcile] auto-advance ${pid} error (non-fatal):`,
            advErr?.message || advErr,
          );
        }
      }
    } finally {
      client.release();
    }
  } catch (err: any) {
    console.error('[RoadmapReconcile] error (non-fatal):', err?.message || err);
  }

  console.log(
    `[RoadmapReconcile] scanned=${summary.scanned} flipped=${summary.flipped} shipped=${summary.shipped} advanced=${summary.advanced} skipped_advance=${summary.skippedAdvance}` +
      (projectId ? ` project=${projectId}` : ''),
  );
  return summary;
}
