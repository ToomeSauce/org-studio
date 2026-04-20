/**
 * roadmap-sync.ts
 *
 * Keeps roadmap-version item `done` flags in sync with task statuses,
 * and auto-advances to the next planned version when all items in the
 * current version are done.
 *
 * Non-fatal: every public function wraps in try/catch so it never
 * breaks the task-update path.  Gracefully no-ops when DATABASE_URL
 * is unset (file-store mode with no Postgres pool).
 */

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
    try {
      // Find all roadmap versions for this project that mention this taskId
      // Note: roadmap_versions are scoped by project_id; workspace_id guard applied
      const result = await client.query(
        `SELECT id, version, status, items, sort_order
         FROM org_studio_roadmap_versions
         WHERE project_id = $1 AND workspace_id = $2`,
        [projectId, 'default-workspace'], // TODO(v0.17-multi-workspace): resolve from caller context
      );

      let changed = false;
      let changedVersionId: string | null = null;

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
          changedVersionId = row.id;
          console.log(
            `[RoadmapSync] ${projectId} v${row.version}: item ${taskId} → done=${isDone}`,
          );
        }
      }

      // If we flipped an item to done, check whether the entire version completed
      if (changed && isDone && changedVersionId) {
        await checkAndAutoAdvance(projectId, client);
      }
    } finally {
      client.release();
    }
  } catch (err: any) {
    console.error('[RoadmapSync] syncRoadmapItemForTask error (non-fatal):', err?.message || err);
  }
}

/* ------------------------------------------------------------------ */
/*  checkAndAutoAdvance                                                */
/* ------------------------------------------------------------------ */

/**
 * If the current version has all items done, ship it and optionally
 * launch the next planned version.
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
    console.log(`[AutoAdvance] ${projectId}: v${current.version} shipped`);

    // 3. Read project autonomy
    const projResult = await client.query(
      `SELECT data FROM org_studio_projects WHERE id = $1 AND workspace_id = $2`,
      [projectId, 'default-workspace'],
    );
    if (projResult.rows.length === 0) return;

    const projData =
      typeof projResult.rows[0].data === 'string'
        ? JSON.parse(projResult.rows[0].data)
        : projResult.rows[0].data || {};

    const autonomy = projData.autonomy || {};
    const autoAdvance: boolean = autonomy.autoAdvance === true;
    const approvedThrough: string | undefined = autonomy.approvedThrough;

    if (!autoAdvance) {
      console.log(
        `[AutoAdvance] auto-advance disabled for ${projectId} — v${current.version} shipped, manual launch required`,
      );
      return;
    }

    // 4. Find next planned version (next by sort_order)
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
        `[AutoAdvance] ${projectId}: v${current.version} shipped → no next planned version`,
      );
      return;
    }

    const next = nextResult.rows[0];

    // 5. Approval gating
    if (approvedThrough) {
      if (parseFloat(next.version) > parseFloat(approvedThrough)) {
        console.log(
          `[AutoAdvance] ${projectId}: approval required for v${next.version} (approvedThrough=${approvedThrough}) — manual launch needed`,
        );
        return;
      }
    } else {
      // No approvedThrough set at all — block auto-advance to be safe
      console.log(
        `[AutoAdvance] ${projectId}: no approvedThrough set — manual launch needed for v${next.version}`,
      );
      return;
    }

    // 6. Check all items have taskIds (can't launch without planning tickets)
    const nextItems: any[] = next.items || [];
    const draftItems = nextItems.filter((i: any) => !i.taskId);
    if (draftItems.length > 0) {
      console.log(
        `[AutoAdvance] ${projectId}: v${next.version} has ${draftItems.length} item(s) without taskId — manual launch needed`,
      );
      return;
    }

    // 7. Launch the next version
    await client.query(
      `UPDATE org_studio_roadmap_versions SET status = 'current' WHERE id = $1 AND workspace_id = $2`,
      [next.id, 'default-workspace'],
    );

    // 8. Move linked tasks from planning → backlog
    let movedCount = 0;
    const taskIds = nextItems.map((i: any) => i.taskId).filter(Boolean);

    // Read devOwner for assignee
    const devOwner = projData.devOwner || '';

    for (const tid of taskIds) {
      try {
        const taskRes = await client.query(
          `SELECT id, status FROM org_studio_tasks WHERE id = $1 AND workspace_id = $2`,
          [tid, 'default-workspace'],
        );
        if (taskRes.rows.length > 0 && taskRes.rows[0].status === 'planning') {
          await client.query(
            `UPDATE org_studio_tasks
             SET status = 'backlog',
                 version = $1,
                 assignee = COALESCE(NULLIF(assignee, ''), $2)
             WHERE id = $3 AND workspace_id = $4`,
            [next.version, devOwner, tid, 'default-workspace'],
          );
          movedCount++;
        }
      } catch (taskErr: any) {
        console.error(
          `[AutoAdvance] Failed to move task ${tid} to backlog:`,
          taskErr?.message,
        );
      }
    }

    // 9. Update project's currentVersion
    try {
      projData.currentVersion = next.version;
      await client.query(
        `UPDATE org_studio_projects SET data = $1 WHERE id = $2 AND workspace_id = $3`,
        [JSON.stringify(projData), projectId, 'default-workspace'],
      );
    } catch (err: any) {
      console.error('[AutoAdvance] Failed to update project currentVersion:', err?.message);
    }

    console.log(
      `[AutoAdvance] ${projectId}: v${current.version} shipped → v${next.version} launched (${movedCount} tasks moved planning→backlog)`,
    );
  } catch (err: any) {
    console.error('[AutoAdvance] checkAndAutoAdvance error (non-fatal):', err?.message || err);
  } finally {
    if (ownClient) client.release();
  }
}
