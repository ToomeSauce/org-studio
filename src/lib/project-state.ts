import { buildStatusTransition } from "./task-status";

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
    // #1594 — when true (the Launch/approve button, an explicit human act),
    // treat targetVersion as approved: add it to the primary component's
    // approvedVersions[] so the horizon gate passes, and allow launching an
    // ALREADY-current version in place (sweep its planning tickets to
    // backlog) instead of requiring advance-from-a-prior-version. Auto-
    // advance (checkAndAutoAdvance, component-approval re-trigger) leaves
    // this false so the horizon gate stays authoritative for unattended
    // promotion.
    explicitLaunch?: boolean;
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
  //
  // #1314.2 (Basil 2026-05-12): when no non-support/non-qa container
  // exists, fall back to the first container. Without this fallback,
  // single-section projects whose section is tagged role:'support' (e.g.
  // Thrivor) silently never advance — promoteProjectToNextVersion sees
  // approvedVersions:[] and refuses, even though the user just ticked an
  // approval. Routing code must always have SOMETHING to route through.
  const componentsList: any[] =
    Array.isArray(projData.components) && projData.components.length > 0
      ? projData.components
      : Array.isArray(projData.sections)
        ? projData.sections
        : [];
  const primaryComponent =
    componentsList.find((c: any) => !c?.role || (c.role !== 'qa' && c.role !== 'support'))
    || componentsList[0];
  const approvedVersionsList: string[] = Array.isArray(primaryComponent?.approvedVersions)
    ? primaryComponent.approvedVersions
    : [];
  // approvedVersionsList computed above is the only horizon source.

  // 3. Find target version
  let targetVersion = opts?.targetVersion;
  // #1594 — are we launching the ALREADY-current version in place? (i.e. the
  // target IS the current version, whose linked tickets are still in
  // planning and were never swept). This happens for the FIRST launch of a
  // project's current version, or when a version was made current via a
  // roadmap edit rather than by advancing into it.
  let launchInPlace = false;

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

    if (nextRes.rows.length === 0) {
      // #1594 — no next planned version. Before giving up, check whether the
      // CURRENT version itself still has unlaunched planning tickets. If so,
      // launch it in place instead of stranding it. This is the exact
      // scenario that bit proj-org-studio 2026.07.01: current, but its 6
      // tickets sat in planning forever because launch only ever swept the
      // *next* version's tickets.
      if (fromVersion) {
        const strandedRes = await client.query(
          `SELECT COUNT(*)::int AS n FROM org_studio_tasks
           WHERE project_id = $1 AND version = $2 AND status = 'planning' AND workspace_id = $3`,
          [projectId, fromVersion, wsId],
        );
        if ((strandedRes.rows[0]?.n || 0) > 0) {
          targetVersion = fromVersion;
          launchInPlace = true;
        }
      }
      if (!targetVersion) return noop('no next planned version');
    } else {
      targetVersion = nextRes.rows[0].version;
    }
  } else if (targetVersion === fromVersion) {
    // Explicit target IS the current version — launch in place.
    launchInPlace = true;
  }

  // #1594 — explicit Launch/approve is itself an approval act. Add the target
  // to the primary component's approvedVersions[] so the horizon gate below
  // passes without forcing the user to ALSO tick a separate per-component
  // approval checkbox (the UX trap that stranded 2026.07.01). Auto-advance
  // paths (explicitLaunch falsey) skip this — the horizon gate stays
  // authoritative for unattended promotion.
  if (opts?.explicitLaunch && targetVersion && primaryComponent) {
    if (!approvedVersionsList.includes(targetVersion)) {
      approvedVersionsList.push(targetVersion);
      const compsKey = Array.isArray(projData.components) && projData.components.length > 0
        ? 'components'
        : (Array.isArray(projData.sections) ? 'sections' : 'components');
      const compsArr: any[] = Array.isArray(projData[compsKey]) ? projData[compsKey] : [];
      const idx = compsArr.findIndex((c: any) => c?.id === primaryComponent.id);
      if (idx >= 0) {
        const existing: string[] = Array.isArray(compsArr[idx].approvedVersions) ? compsArr[idx].approvedVersions : [];
        if (!existing.includes(targetVersion)) {
          compsArr[idx] = { ...compsArr[idx], approvedVersions: [...existing, targetVersion] };
          projData[compsKey] = compsArr;
          await client.query(
            `UPDATE org_studio_projects SET data = $1 WHERE id = $2 AND workspace_id = $3`,
            [JSON.stringify(projData), projectId, wsId],
          );
          console.log(`[Promote] ${projectId}: explicit launch self-approved ${targetVersion} (added to ${compsKey}[${idx}].approvedVersions)`);
        }
      }
    }
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
  // #1594 — skip for launch-in-place: we're launching `fromVersion` itself,
  // not advancing PAST it, so its own metric is irrelevant here.
  if (fromVersion && !launchInPlace) {
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
  // #1594 — skip for launch-in-place (see above): launching the current
  // version in place is not "promoting past" it.
  if (fromVersion && !launchInPlace) {
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
  // #1594 — single-current invariant: demote any OTHER version that is
  // currently 'current' back to 'planned' before flipping the target.
  // The approve/launch path could otherwise race in a second current
  // version (exactly what happened when approving 2026.07.01 also left
  // 2026.08.01 current). One current version per project, always.
  await client.query(
    `UPDATE org_studio_roadmap_versions
     SET status = 'planned'
     WHERE project_id = $1 AND status = 'current' AND version <> $2 AND workspace_id = $3`,
    [projectId, targetVersion, wsId],
  );
  await client.query(
    `UPDATE org_studio_roadmap_versions SET status = 'current' WHERE id = $1 AND workspace_id = $2`,
    [versionRow.id, wsId],
  );

  // 7. Move linked planning tasks → backlog
  //
  // #1531 — status_history MUST be appended in the SAME UPDATE that flips
  // the typed `status` column. Without this append, the row drifts:
  // typed.status = 'backlog' (new) but statusHistory.tail.status =
  // 'planning' (stale). Scheduler queries against typed status see one
  // truth; UI history badges see another. The history append + last_activity_at
  // bump mirror what src/app/api/store/route.ts:~1224 does for normal
  // user/agent status changes. Future status-mutating SQL paths must do
  // the same OR funnel through src/lib/task-status.ts:applyStatusTransition()
  // (see followup #TBD). Test guard: src/__tests__/status-drift.test.ts.
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
        // #1535 — build the transition patch through the single source of
        // truth even though we apply it via raw SQL (this UPDATE shares a
        // transaction with the project/roadmap writes above and so can't
        // route through provider.updateTask). The helper still owns the
        // bookkeeping shape; we just translate JS field names to SQL
        // column names below.
        const nowMs = Date.now();
        const { updates } = buildStatusTransition({
          task: { id: item.taskId, status: 'planning' },
          newStatus: 'backlog',
          by: 'system-promote',
          now: nowMs,
        });
        const historyEntry = JSON.stringify(updates.statusHistory!.slice(-1)[0]);
        // STATUS_TRANSITION_ALLOWED — invariant test (#1535) checks for
        // this token nearby any raw `UPDATE org_studio_tasks SET status`
        // statement; the only legitimate raw-SQL status writer is this
        // one, gated inside the promote transaction.
        await client.query(
          `UPDATE org_studio_tasks
           SET status = $1,
               version = $2,
               assignee = COALESCE(NULLIF(assignee, ''), $3),
               status_history = COALESCE(status_history, '[]'::jsonb) || $7::jsonb,
               last_activity_at = $8,
               loop_count = 0,
               loop_paused_at = NULL,
               loop_pause_reason = NULL,
               -- claim-lease fields live in the data JSONB bag (store-provider
               -- reads them via data->>'claim_started_at'), NOT typed columns.
               -- Referencing them as columns made this UPDATE throw per-item
               -- ('column "claim_started_at" does not exist'), silently
               -- caught below — launch reported 0 tasks moved (2026-07-06).
               data = (COALESCE(data, '{}'::jsonb) - 'claim_started_at' - 'claim_lease_expires_at')
           WHERE id = $4 AND workspace_id = $5 AND status = $6`,
          [updates.status, targetVersion, devOwner, item.taskId, wsId, 'planning', historyEntry, updates.lastActivityAt],
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

  console.log(`[Promote] ${projectId}: ${fromVersion || '(none)'} → ${targetVersion}${launchInPlace ? ' (launch-in-place)' : ''} (${movedTasks} tasks moved planning→backlog)`);

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
