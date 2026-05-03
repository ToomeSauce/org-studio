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
 *   - `autonomy.enabled` is removed. `autonomy.approvedThrough` stays.
 */

import { isVersionInHorizon, isVersionGreater } from './version-utils';

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

  // #1112 PR 6 follow-up: horizon source-of-truth is the primary component's
  // own `approvedThrough`. The legacy project-wide `autonomy.approvedThrough`
  // is consulted as a last-resort fallback so brand-new projects without a
  // Main component still launch via the no-components UI path.
  const componentsList: any[] =
    Array.isArray(projData.components) && projData.components.length > 0
      ? projData.components
      : Array.isArray(projData.sections)
        ? projData.sections
        : [];
  const primaryComponent = componentsList.find(
    (c: any) => !c?.role || (c.role !== 'qa' && c.role !== 'support'),
  );
  const approvedThrough: string | undefined =
    primaryComponent?.approvedThrough ?? projData.autonomy?.approvedThrough;

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

  // 4. Horizon gate — targetVersion must be within approvedThrough
  if (!approvedThrough) return noop('no approvedThrough set');
  if (isVersionGreater(targetVersion, approvedThrough)) {
    console.log(`[Promote] ${projectId}: ${targetVersion} above horizon ${approvedThrough}`);
    return noop(`above horizon (${targetVersion} > ${approvedThrough})`);
  }

  // 5. All roadmap items must have taskIds
  const versionRes = await client.query(
    `SELECT id, items FROM org_studio_roadmap_versions
     WHERE project_id = $1 AND version = $2 AND workspace_id = $3 LIMIT 1`,
    [projectId, targetVersion, wsId],
  );
  if (versionRes.rows.length === 0) return noop('version row not found');

  const versionRow = versionRes.rows[0];
  const items: any[] = versionRow.items || [];
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
