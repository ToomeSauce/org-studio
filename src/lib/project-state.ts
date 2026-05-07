/**
 * project-state.ts
 *
 * Centralised project state helpers:
 *   - `isProjectRunning(project)` — single source of truth for run-gating.
 *   - `promoteProjectToNextVersion(projectId, client)` — the ONE path that
 *     advances `currentVersion` (used by Launch button, auto-advance, and
 *     server.mjs intent handler).
 *   - `migrateProjectState(projects)` — idempotent one-shot migration from
 *     the old `currentVersion === null` pause pattern to `project.state`.
 *
 * Design notes:
 *   - `project.state: "active" | "inactive"` is the **only** field that
 *     gates whether the scheduler dispatches work for a project.
 *     (#1185: renamed from 'started'/'stopped'. Both literals accepted in the
 *     type during transition; helpers normalize.)
 *   - `currentVersion` is purely "which version is in flight right now".
 *     It's never used as a pause flag anymore.
 *   - `autonomy.enabled` is removed. `autonomy.approvedThrough` is also
 *     gone (#1224); approval is set membership against
 *     primary-component `approvedVersions[]`.
 */

// #1224: version-utils helpers no longer needed here — horizon is set
// membership against approvedVersions[].


/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Is the project running? This is the single check the scheduler uses
 * to decide whether to dispatch tasks for a project.
 *
 * Default (missing field) = active, for backward compat.
 *
 * #1185: accepts both legacy ('started'/'stopped') and new ('active'/'inactive')
 * literals during the rename transition. After ticket A's migration runs, all
 * stored values are 'active'/'inactive'; legacy literals only appear in
 * unmigrated test fixtures.
 */
export function isProjectRunning(
  project: { state?: 'active' | 'inactive' | 'started' | 'stopped' } | null | undefined,
): boolean {
  if (!project) return false;
  const s = project.state;
  // 'inactive' or 'stopped' → not running. Anything else (including
  // undefined or 'active' or 'started') → running.
  return s !== 'inactive' && s !== 'stopped';
}

/**
 * #1185 — normalize legacy state literal to new naming. Pure function;
 * returns the new literal. Use anywhere a state value flows from old data
 * into UI/log strings to avoid mixing terminologies.
 */
export function normalizeProjectState(
  state: 'active' | 'inactive' | 'started' | 'stopped' | undefined,
): 'active' | 'inactive' {
  if (state === 'inactive' || state === 'stopped') return 'inactive';
  return 'active'; // undefined, 'active', 'started' all map to active
}

/* ------------------------------------------------------------------ */
/*  promoteProjectToNextVersion                                        */
/* ------------------------------------------------------------------ */

export interface PromoteResult {
  promoted: boolean;
  from: string | null;
  to: string | null;
  movedTasks: number;
  reason?: string;
}

/**
 * Advance a project to its next planned roadmap version.
 *
 * This is the ONLY function that bumps `currentVersion`. Every caller
 * (Launch button, auto-advance, server.mjs intent) funnels here.
 *
 * Steps:
 *   1. Find the next planned version within the approval horizon.
 *   2. Set the version status to 'current'.
 *   3. Bump project.currentVersion.
 *   4. Move linked planning tasks → backlog.
 *   5. Log `[Promote] <pid>: <from> → <to>`.
 *
 * @param projectId - project to promote
 * @param client    - pg client (caller manages connection + transaction if desired)
 * @param opts      - override defaults (e.g. explicit targetVersion for Launch button)
 */
export async function promoteProjectToNextVersion(
  projectId: string,
  client: any,
  opts?: {
    targetVersion?: string;   // explicit version to promote to (Launch button)
    workspaceId?: string;
  },
): Promise<PromoteResult> {
  const wsId = opts?.workspaceId || 'default-workspace';
  const noop = (reason: string): PromoteResult => ({ promoted: false, from: null, to: null, movedTasks: 0, reason });

  // 1. Read project data
  const projRes = await client.query(
    `SELECT data FROM org_studio_projects WHERE id = $1 AND workspace_id = $2`,
    [projectId, wsId],
  );
  if (projRes.rows.length === 0) return noop('project not found');

  const projData =
    typeof projRes.rows[0].data === 'string'
      ? JSON.parse(projRes.rows[0].data)
      : projRes.rows[0].data || {};

  // 2. Gate: project must be active (#1185 rename: was 'started')
  if (!isProjectRunning(projData)) {
    console.log(`[Promote] ${projectId}: project is inactive — skipping`);
    return noop('project inactive');
  }

  const fromVersion = projData.currentVersion || null;

  // #1224: horizon comes only from the primary component's
  // approvedVersions[]. The legacy project-wide autonomy.approvedThrough
  // scalar and the per-component approvedThrough scalar are both gone.
  const componentsList: any[] =
    Array.isArray(projData.components) && projData.components.length > 0
      ? projData.components
      : Array.isArray(projData.sections)
        ? projData.sections
        : [];
  const primaryComponent = componentsList.find(
    (c: any) => !c?.role || (c.role !== 'qa' && c.role !== 'support'),
  );
  const approvedVersionsList: string[] = Array.isArray(primaryComponent?.approvedVersions)
    ? primaryComponent.approvedVersions
    : [];
  // approvedVersionsList computed above is the only horizon source.

  // 3. Find target version
  let targetVersion = opts?.targetVersion;

  if (!targetVersion) {
    // Auto-mode: find next planned version by sort_order
    // If there's a current version, find the one after it. Otherwise find the first planned.
    let sortOrderFloor = -Infinity;
    if (fromVersion) {
      const currentRes = await client.query(
        `SELECT sort_order FROM org_studio_roadmap_versions
         WHERE project_id = $1 AND version = $2 AND workspace_id = $3 LIMIT 1`,
        [projectId, fromVersion, wsId],
      );
      if (currentRes.rows.length > 0) {
        sortOrderFloor = currentRes.rows[0].sort_order;
      }
    }

    const nextRes = await client.query(
      `SELECT version, sort_order FROM org_studio_roadmap_versions
       WHERE project_id = $1 AND status = 'planned' AND sort_order > $2 AND workspace_id = $3
       ORDER BY sort_order ASC LIMIT 1`,
      [projectId, sortOrderFloor, wsId],
    );

    if (nextRes.rows.length === 0) return noop('no next planned version');
    targetVersion = nextRes.rows[0].version;
  }

  // 4. Horizon gate — targetVersion must be in approvedVersions[].
  // #1222 fix: set membership (not <= max). With non-contiguous approvals
  // (e.g. tick 0.18, skip 0.19, tick 0.20), `<=max` would let 0.19 promote
  // through despite never being approved. Set membership is what the UI
  // checkboxes mean.
  if (!targetVersion) return noop('no target version resolved');
  if (approvedVersionsList.length === 0) return noop('no versions approved');
  if (!approvedVersionsList.includes(targetVersion)) {
    console.log(`[Promote] ${projectId}: ${targetVersion} not in approvedVersions[${approvedVersionsList.join(',')}]`);
    return noop(`not approved (${targetVersion} not in approvedVersions)`);
  }

  // #1263 — defense-in-depth outcome-bound gate. If we have a `from` version
  // (i.e. we're advancing past one that was previously current), check its
  // metric. If criteria are set and metric is unmet, refuse to advance even
  // if all child tickets are done — checkAndAutoAdvance is the primary
  // gate, but a Launch-button promote could otherwise sneak past it.
  if (fromVersion) {
    const fromMetaRes = await client.query(
      `SELECT meta FROM org_studio_roadmap_versions WHERE project_id = $1 AND version = $2 AND workspace_id = $3 LIMIT 1`,
      [projectId, fromVersion, wsId],
    );
    const fromMeta: any = (fromMetaRes.rows[0]?.meta && typeof fromMetaRes.rows[0].meta === 'object')
      ? fromMetaRes.rows[0].meta
      : {};
    const criteria = (fromMeta.successCriteria || '').toString().trim();
    if (criteria) {
      const target = fromMeta.metricTarget;
      const cur = fromMeta.metricCurrent;
      const comp = fromMeta.metricComparator || 'gte';
      let met = false;
      if (typeof target === 'number' && typeof cur === 'number') {
        met = comp === 'lte' ? cur <= target
            : comp === 'eq' ? cur === target
            : cur >= target;
      }
      if (!met) {
        console.log(`[Promote] ${projectId}: current version ${fromVersion} metric not met — refusing to advance`);
        return noop('current version metric not met');
      }
    }
  }

  // #1263 — defense-in-depth: do not promote PAST a version whose metric
  // gate is unmet. checkAndAutoAdvance already refuses to ship in that
  // case, but this guards the explicit promote path (Launch button, intent
  // handler) so an outcome-bound `current` version can't be skipped over.
  if (fromVersion) {
    const fromRes = await client.query(
      `SELECT meta FROM org_studio_roadmap_versions
         WHERE project_id = $1 AND version = $2 AND workspace_id = $3 LIMIT 1`,
      [projectId, fromVersion, wsId],
    );
    const meta: any = (fromRes.rows[0]?.meta && typeof fromRes.rows[0].meta === 'object')
      ? fromRes.rows[0].meta
      : {};
    const criteria = (meta.successCriteria || '').toString().trim();
    if (criteria) {
      const target = meta.metricTarget;
      const cur = meta.metricCurrent;
      const comp = meta.metricComparator || 'gte';
      let met = false;
      if (typeof target === 'number' && typeof cur === 'number') {
        met = comp === 'lte' ? cur <= target
            : comp === 'eq' ? cur === target
            : cur >= target;
      }
      if (!met) {
        console.log(`[Promote] ${projectId}: current ${fromVersion} metric not met — refusing to promote`);
        return noop('current version metric not met');
      }
    }
  }

  // 5. All roadmap items must have taskIds
  let versionRes = await client.query(
    `SELECT id, items FROM org_studio_roadmap_versions
     WHERE project_id = $1 AND version = $2 AND workspace_id = $3 LIMIT 1`,
    [projectId, targetVersion, wsId],
  );
  if (versionRes.rows.length === 0) {
    // #1229: try to mirror from embedded sections[].versions[]/components[].versions[]
    // before failing. Plumbing-only — doesn't invent items, just bridges the
    // gap when a project was created without an rv-table row.
    const componentsForMirror: any[] =
      Array.isArray(projData.components) && projData.components.length > 0
        ? projData.components
        : Array.isArray(projData.sections)
          ? projData.sections
          : [];
    let embedded: any = null;
    let embeddedComponent: any = null;
    for (const comp of componentsForMirror) {
      const versions: any[] = Array.isArray(comp?.versions) ? comp.versions : [];
      const match = versions.find((v: any) => v?.version === targetVersion);
      if (match) {
        embedded = match;
        embeddedComponent = comp;
        break;
      }
    }
    if (!embedded) {
      console.log(`[Promote] ${projectId}: ${targetVersion} not found in rv-table or embedded sections — nothing to mirror`);
      return noop(`version ${targetVersion} not found in roadmap (rv-table or embedded)`);
    }

    const embeddedItems: any[] = Array.isArray(embedded?.items) ? embedded.items : [];
    if (embeddedItems.length === 0) {
      // Mirroring an empty version is pointless and would just re-fail in step 5.
      // Surface the clearer error directly.
      console.log(`[Promote] ${projectId}: ${targetVersion} has no roadmap items — cannot launch`);
      return noop(`No roadmap items in target version ${targetVersion}. Add at least one item with a taskId before launching.`);
    }

    const itemsWithIds = embeddedItems.map((it: any) => {
      if (it && typeof it === 'object' && !it.id) {
        const newId = `item-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
        return { ...it, id: newId };
      }
      return it;
    });
    const rvId = embedded?.id || `rv-${projectId}-${targetVersion.replace(/\./g, '-')}`;
    const sortOrder =
      typeof embedded?.sort_order === 'number'
        ? embedded.sort_order
        : 0;
    const rvStatus = embedded?.status || 'planned';
    const versionType = embedded?.version_type || embedded?.versionType || 'outcome';
    const title = embedded?.title || targetVersion;
    const owner = embedded?.owner || embeddedComponent?.owner || projData?.owner || projData?.devOwner || null;
    const createdAt = typeof embedded?.createdAt === 'number' ? embedded.createdAt : Date.now();

    try {
      await client.query(
        `INSERT INTO org_studio_roadmap_versions
           (id, project_id, version, title, status, items, sort_order, created_at, version_type, workspace_id, owner)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)
         ON CONFLICT (project_id, version) DO NOTHING`,
        [rvId, projectId, targetVersion, title, rvStatus, JSON.stringify(itemsWithIds), sortOrder, createdAt, versionType, wsId, owner],
      );
      console.log(`[Promote] ${projectId}: mirrored embedded ${targetVersion} into rv-table (#1229)`);
    } catch (mirrorErr: any) {
      console.error(`[Promote] ${projectId}: rv-table mirror failed for ${targetVersion}:`, mirrorErr?.message);
      return noop(`rv-table mirror failed: ${mirrorErr?.message}`);
    }

    versionRes = await client.query(
      `SELECT id, items FROM org_studio_roadmap_versions
       WHERE project_id = $1 AND version = $2 AND workspace_id = $3 LIMIT 1`,
      [projectId, targetVersion, wsId],
    );
    if (versionRes.rows.length === 0) {
      return noop('rv-table mirror succeeded but row still missing (concurrency?)');
    }
  }

  const versionRow = versionRes.rows[0];
  const items: any[] = versionRow.items || [];
  if (items.length === 0) {
    // Clearer error than the old draftItems-style noop.
    console.log(`[Promote] ${projectId}: ${targetVersion} has no roadmap items — cannot launch`);
    return noop(`No roadmap items in target version ${targetVersion}. Add at least one item with a taskId before launching.`);
  }
  const draftItems = items.filter((i: any) => !i.taskId);
  if (draftItems.length > 0) {
    console.log(`[Promote] ${projectId}: ${targetVersion} has ${draftItems.length} item(s) without taskId`);
    return noop(`${draftItems.length} items without taskId`);
  }

  // 6. Promote: set version status to 'current'
  await client.query(
    `UPDATE org_studio_roadmap_versions SET status = 'current' WHERE id = $1 AND workspace_id = $2`,
    [versionRow.id, wsId],
  );

  // 7. Move linked planning tasks → backlog
  const devOwner = projData.devOwner || '';
  let movedTasks = 0;
  for (const item of items) {
    if (!item.taskId) continue;
    try {
      const taskRes = await client.query(
        `SELECT id, status FROM org_studio_tasks WHERE id = $1 AND workspace_id = $2`,
        [item.taskId, wsId],
      );
      if (taskRes.rows.length > 0 && taskRes.rows[0].status === 'planning') {
        await client.query(
          `UPDATE org_studio_tasks
           SET status = 'backlog',
               version = $1,
               assignee = COALESCE(NULLIF(assignee, ''), $2)
           WHERE id = $3 AND workspace_id = $4`,
          [targetVersion, devOwner, item.taskId, wsId],
        );
        movedTasks++;
      }
    } catch (err: any) {
      console.error(`[Promote] Failed to move task ${item.taskId} to backlog:`, err?.message);
    }
  }

  // 8. Update project.currentVersion (and ensure state is 'active')
  projData.currentVersion = targetVersion;
  if (!projData.state) projData.state = 'active';
  await client.query(
    `UPDATE org_studio_projects SET data = $1 WHERE id = $2 AND workspace_id = $3`,
    [JSON.stringify(projData), projectId, wsId],
  );

  console.log(`[Promote] ${projectId}: ${fromVersion || '(none)'} → ${targetVersion} (${movedTasks} tasks moved planning→backlog)`);

  return { promoted: true, from: fromVersion, to: targetVersion!, movedTasks };
}

/* ------------------------------------------------------------------ */
/*  migrateProjectState                                                */
/* ------------------------------------------------------------------ */

/**
 * Idempotent migration: backfill `state` field on all projects.
 *
 * Rules (#1185 — 'started'/'stopped' renamed to 'active'/'inactive'):
 *   - Legacy 'started' → 'active'
 *   - Legacy 'stopped' → 'inactive'
 *   - Missing state + currentVersion === null → 'inactive'
 *   - Missing state + currentVersion set → 'active'
 *   - Remove `autonomy.enabled` (dead field)
 *
 * Returns the number of projects migrated.
 */
export function migrateProjectState(projects: any[]): { migrated: number; changes: Array<{ id: string; state: string }> } {
  let migrated = 0;
  const changes: Array<{ id: string; state: string }> = [];

  for (const p of projects) {
    let changed = false;

    // #1185 rename: normalize legacy literals first
    if (p.state === 'started') {
      p.state = 'active';
      changed = true;
    } else if (p.state === 'stopped') {
      p.state = 'inactive';
      changed = true;
    }

    // Backfill state when missing
    if (!p.state) {
      p.state = (p.currentVersion === null || p.currentVersion === undefined) ? 'inactive' : 'active';
      changed = true;
    }

    // Remove dead autonomy.enabled field
    if (p.autonomy && 'enabled' in p.autonomy) {
      delete p.autonomy.enabled;
      changed = true;
    }

    if (changed) {
      migrated++;
      changes.push({ id: p.id, state: p.state });
    }
  }

  return { migrated, changes };
}
