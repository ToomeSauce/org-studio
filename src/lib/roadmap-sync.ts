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
import { promoteProjectToNextVersion } from './project-state';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Fire-and-forget scheduler trigger so newly backlogged tasks get
 * dispatched immediately after version auto-advance.
 * Resolves display name → agentId via store teammates.
 */
function triggerSchedulerForAgent(assigneeName: string): void {
  (async () => {
    try {
      // Resolve display name → agentId
      const storeRes = await fetch('http://localhost:4501/api/store');
      if (!storeRes.ok) return;
      const store = await storeRes.json();
      const teammates: any[] = store?.settings?.teammates || [];
      const match = teammates.find((t: any) =>
        t.name?.toLowerCase() === assigneeName.toLowerCase() ||
        t.agentId === assigneeName.toLowerCase()
      );
      const agentId = match?.agentId;
      if (!agentId) {
        console.warn(`[AutoAdvance] no agentId found for devOwner "${assigneeName}" — skipping dispatch`);
        return;
      }

      const apiKey = process.env.ORG_STUDIO_API_KEY || '';
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

      const res = await fetch('http://localhost:4501/api/scheduler', {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'trigger', agentId }),
      });
      if (res.ok) {
        console.log(`[AutoAdvance] scheduler triggered for ${assigneeName} (${agentId})`);
      } else {
        console.warn(`[AutoAdvance] scheduler trigger returned ${res.status} for ${agentId}`);
      }
    } catch (err: any) {
      console.warn(`[AutoAdvance] scheduler trigger failed for ${assigneeName}:`, err?.message || err);
    }
  })();
}

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

    // All items must be done (zero-item versions are auto-shipped)
    if (items.length > 0 && !items.every((i: any) => i.done === true)) return;

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

    // 3b. Project state gate: if project is explicitly stopped, the human has
    // paused auto-advance. Reconcile still ships the completed version (done flags
    // + status='shipped' are factual), but we do NOT promote a next version.
    if (projData.state === 'stopped') {
      console.log(
        `[AutoAdvance] ${projectId}: project stopped (state=stopped) — shipped ${current.version} but skipping auto-advance`,
      );
      (checkAndAutoAdvance as any)._lastSkipReason = 'stopped';
      return;
    }

    // Legacy compat: also check currentVersion === null for un-migrated projects
    if (projData.currentVersion === null || projData.currentVersion === undefined) {
      console.log(
        `[AutoAdvance] ${projectId}: project paused (currentVersion=null) — shipped ${current.version} but skipping auto-advance`,
      );
      (checkAndAutoAdvance as any)._lastSkipReason = 'paused';
      return;
    }

    // 4. No horizon = nothing is approved. Auto-stop.
    if (!approvedThrough) {
      if (projData.state !== 'stopped') {
        projData.state = 'stopped';
        projData.currentVersion = null;
        await client.query(
          `UPDATE org_studio_projects SET data = $1 WHERE id = $2 AND workspace_id = $3`,
          [JSON.stringify(projData), projectId, 'default-workspace'],
        );
        console.log(
          `[AutoAdvance] ${projectId}: auto-stopped — no approvedThrough set, shipped ${current.version}`,
        );
      } else {
        console.log(
          `[AutoAdvance] ${projectId}: no approvedThrough set — stopping after ${current.version}`,
        );
      }
      return;
    }

    // 5-10. Delegate to shared promote util (handles finding next version,
    //       horizon gate, taskId gate, version status update, task moves,
    //       and currentVersion bump).
    const result = await promoteProjectToNextVersion(projectId, client);
    if (result.promoted) {
      console.log(
        `[AutoAdvance] ${projectId}: ${current.version} → ${result.to} (${result.movedTasks} tasks moved planning→backlog)`,
      );

      // Trigger the scheduler for the project's dev owner so the newly
      // backlogged tasks get dispatched immediately — no poll needed.
      if (result.movedTasks > 0 && projData.devOwner) {
        triggerSchedulerForAgent(projData.devOwner);
      }
    } else {
      console.log(
        `[AutoAdvance] ${projectId}: ${current.version} shipped — promote skipped: ${result.reason}`,
      );

      // All approved work is done and no next version to promote — auto-stop the project.
      // This prevents the project from staying in "started" state with nothing to do.
      if (projData.state !== 'stopped') {
        projData.state = 'stopped';
        projData.currentVersion = null;
        await client.query(
          `UPDATE org_studio_projects SET data = $1 WHERE id = $2 AND workspace_id = $3`,
          [JSON.stringify(projData), projectId, 'default-workspace'],
        );
        console.log(
          `[AutoAdvance] ${projectId}: auto-stopped — all approved versions shipped, nothing to promote`,
        );
      }
    }
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
          const wasStopped = projData.state === 'stopped' || projData.currentVersion === null || projData.currentVersion === undefined;

          if (wasStopped) {
            console.log(
              `[AutoAdvance] ${pid}: project stopped/paused — shipped via reconcile but skipping auto-advance`,
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
          } else if (!afterData.currentVersion || afterData.currentVersion === projData.currentVersion) {
            // checkAndAutoAdvance didn't advance — check if we should auto-stop.
            // This catches the case where the shipped version was the last current one
            // and there's nothing to promote (all approved work done).
            const hasPlannedInHorizon = await (async () => {
              const horizon = afterData.autonomy?.approvedThrough;
              if (!horizon) return false;
              const { isVersionGreater } = await import('./version-utils');
              const nextRes = await client.query(
                `SELECT version FROM org_studio_roadmap_versions
                 WHERE project_id = $1 AND status = 'planned' AND workspace_id = $2
                 ORDER BY sort_order ASC LIMIT 1`,
                [pid, 'default-workspace'],
              );
              if (nextRes.rows.length === 0) return false;
              return !isVersionGreater(nextRes.rows[0].version, horizon);
            })();

            if (!hasPlannedInHorizon && afterData.state !== 'stopped') {
              afterData.state = 'stopped';
              afterData.currentVersion = null;
              await client.query(
                `UPDATE org_studio_projects SET data = $1 WHERE id = $2 AND workspace_id = $3`,
                [JSON.stringify(afterData), pid, 'default-workspace'],
              );
              console.log(
                `[RoadmapReconcile] ${pid}: auto-stopped — all approved versions shipped, nothing to promote`,
              );
            }
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
