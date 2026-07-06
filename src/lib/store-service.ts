/**
 * #1645 — shared store service layer.
 *
 * Root-cause elimination of the #1640 failure class: in-process write-path
 * callers used to POST to their own HTTP surface (`fetch('http://localhost:
 * 4501/api/store', ...)`) to get the route's full behavior — auth, workspace
 * resolution, validation, NOTIFY emission, dispatch triggering. Those hops
 * are invisible failure points (silent 401s after auth tightening, swallowed
 * non-ok statuses, port drift).
 *
 * This module extracts the route behavior into plain async functions that
 * BOTH the HTTP route and internal callers use, so side-effects fire
 * identically on both paths:
 *
 *   - `updateProjectService()` — the full `case 'updateProject'` behavior
 *     from src/app/api/store/route.ts: workspace guard, targeted provider
 *     write (which emits NOTIFY org_studio_change), inactive→active promote
 *     re-check + dispatch trigger, devOwner-change task reassignment.
 *   - `triggerAgentLoopService()` — fire-and-forget scheduler trigger with
 *     retry + internal Bearer auth (moved verbatim from the store route so
 *     lib/ callers stop hand-rolling the same fetch).
 *
 * Design rule: functions here must be byte-identical in observable behavior
 * to the route paths they were extracted from. No new side-effects, no
 * dropped ones. The route delegates to these functions — there is exactly
 * one implementation.
 */

import { getStoreProvider, type StoreData } from '@/lib/store-provider';
import { belongsToWorkspace } from '@/lib/workspace-auth';
import { recordInternalCallFailure } from '@/lib/dispatch-ledger';

const SCHEDULER_URL = `http://localhost:${process.env.PORT || 4501}/api/scheduler`;

/* ------------------------------------------------------------------ */
/*  triggerAgentLoopService                                            */
/* ------------------------------------------------------------------ */

/**
 * Trigger the event-driven scheduler for the agent assigned to a task.
 * Fire-and-forget with retries — never blocks or throws to the caller.
 *
 * Moved from src/app/api/store/route.ts (#1645). Behavior unchanged except
 * non-ok responses / throws are now ALSO counted in
 * org_studio_internal_call_failures (#1641) — previously only console.warn'd.
 *
 * NOTE: the scheduler-trigger boundary deliberately stays on HTTP even for
 * in-process callers. `case 'trigger'` is the dispatch event boundary
 * (memoized store reader, ledger, breaker gate all hang off the route
 * invocation); collapsing it into a direct function call is architectural
 * surgery beyond the service layer — accepted HTTP end-state per #1645
 * constraints, with mandatory auth + counter coverage.
 */
export function triggerAgentLoopService(assignee: string, store: StoreData): void {
  if (!assignee) return;
  // Resolve assignee name → agentId
  const teammates = store.settings?.teammates || [];
  const match = teammates.find((t: any) =>
    t.name?.toLowerCase() === assignee.toLowerCase() ||
    t.agentId === assignee.toLowerCase()
  );
  const agentId = match?.agentId;
  if (!agentId) return;

  // Fire-and-forget — retry logic runs async, never blocks the response
  (async () => {
    const MAX_RETRIES = 3;
    const DELAYS = [1000, 5000, 15000]; // 1s, 5s, 15s
    const apiKey = process.env.ORG_STUDIO_API_KEY || '';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(SCHEDULER_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify({ action: 'trigger', agentId }),
        });
        if (res.ok) return; // success
        console.warn(`triggerAgentLoop attempt ${attempt + 1} failed: HTTP ${res.status}`);
        if (attempt === MAX_RETRIES - 1) {
          recordInternalCallFailure('store-service:trigger-agent-loop', '/api/scheduler', res.status, 'http-status');
        }
      } catch (e: any) {
        console.warn(`triggerAgentLoop attempt ${attempt + 1} error:`, e?.message || e);
        if (attempt === MAX_RETRIES - 1) {
          recordInternalCallFailure('store-service:trigger-agent-loop', '/api/scheduler', null, 'fetch-throw');
        }
      }
      if (attempt < MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, DELAYS[attempt]));
      }
    }
    console.error(`triggerAgentLoop: all ${MAX_RETRIES} attempts failed for agent ${agentId}`);
  })();
}

/* ------------------------------------------------------------------ */
/*  updateProjectService                                               */
/* ------------------------------------------------------------------ */

export type UpdateProjectResult =
  | { ok: true }
  | { ok: false; status: 403; error: string };

/**
 * Full `updateProject` behavior, extracted verbatim from the store route
 * (#1645). Both the HTTP route and internal callers (roadmap route
 * currentVersion sync) go through here.
 *
 * Side-effects preserved:
 *  1. Workspace guard (403 when project belongs to another workspace).
 *  2. Targeted `provider.updateProject()` write — the Postgres provider
 *     emits `NOTIFY org_studio_change` with the updates payload (intent
 *     routing / bidirectional sync depend on this).
 *  3. Legacy `autonomy.approvedThrough` scalar strip (#1224 defense-in-depth).
 *  4. Project state inactive→active transition: re-check promote in case the
 *     approval horizon was bumped while inactive; on promote with moved
 *     tasks, trigger the devOwner's agent loop (#1185).
 *  5. devOwner change: reassign the old owner's active (non-done) tasks to
 *     the new owner.
 *
 * @param workspaceId resolved workspace id (caller does auth/workspace resolution)
 * @param projectId   project to update
 * @param updates     partial project updates (same shape as the API payload)
 * @param storeSnapshot optional already-read store snapshot (the HTTP route
 *        passes its request-scoped read; internal callers may omit and a
 *        fresh read is taken — needed for oldProject compare + teammate
 *        resolution).
 */
export async function updateProjectService(
  workspaceId: string,
  projectId: string,
  updates: Partial<any>,
  storeSnapshot?: StoreData,
): Promise<UpdateProjectResult> {
  const provider = getStoreProvider(workspaceId);
  const store: StoreData = storeSnapshot ?? (await provider.read());

  // Check if devOwner is changing
  const oldProject = store.projects.find((p: any) => p.id === projectId);

  // Workspace guard
  if (oldProject && !belongsToWorkspace(oldProject, workspaceId)) {
    return { ok: false, status: 403, error: 'Forbidden — project belongs to another workspace' };
  }

  const newDevOwner = updates?.devOwner;
  const devOwnerChanged = newDevOwner && oldProject?.devOwner && newDevOwner !== oldProject.devOwner;

  // PERF: Use targeted provider.updateProject() instead of full store write.
  // (Postgres provider emits NOTIFY org_studio_change here.)
  await provider.updateProject(projectId, updates);
  console.log('[StoreService:updateProject] completed for', projectId);

  // #1224: project-level autonomy.approvedThrough was a legacy bridge
  // when approvals were a single scalar. Strip any incoming scalar
  // (defense-in-depth; the UI no longer writes it).
  if (updates?.autonomy && 'approvedThrough' in updates.autonomy) {
    delete (updates.autonomy as any).approvedThrough;
  }

  // Log project state changes
  if (updates?.state && updates.state !== oldProject?.state) {
    console.log(`[ProjectState] ${projectId}: ${oldProject?.state || 'undefined'} → ${updates.state}`);
    // When activating a previously inactive project, re-check promote
    // in case horizon was bumped while inactive. (#1185 rename: was started/stopped)
    const newActive = updates.state === 'active' || updates.state === 'started';
    const oldInactive = oldProject?.state === 'inactive' || oldProject?.state === 'stopped';
    if (newActive && oldInactive) {
      (async () => {
        try {
          const { promoteProjectToNextVersion } = await import('@/lib/project-state');
          const pg = await import('pg');
          const Pool = (pg as any).default?.Pool || (pg as any).Pool;
          const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
          const client = await pool.connect();
          try {
            const result = await promoteProjectToNextVersion(projectId, client);
            if (result.promoted) {
              console.log(`[ProjectState] Restart promote ${projectId}: ${result.from} → ${result.to} (${result.movedTasks} tasks → backlog)`);
              const freshStore = await getStoreProvider(workspaceId).read();
              const proj = freshStore.projects.find((p: any) => p.id === projectId);
              if (proj?.devOwner && result.movedTasks > 0) {
                triggerAgentLoopService(proj.devOwner, freshStore);
              }
            }
          } finally {
            client.release();
            await pool.end();
          }
        } catch (e: any) {
          console.error(`[ProjectState] restart promote failed for ${projectId}:`, e?.message);
        }
      })();
    }
  }

  // If devOwner changed, reassign active tasks (NOT done tasks) to new owner
  if (devOwnerChanged) {
    const projectTasks = store.tasks.filter((t: any) =>
      t.projectId === projectId &&
      t.assignee?.toLowerCase() === oldProject.devOwner.toLowerCase()
    );
    for (const task of projectTasks) {
      // Skip done tasks — they stay credited to whoever completed them
      if (task.status === 'done') continue;
      await provider.updateTask(task.id, { assignee: newDevOwner });
    }
    if (projectTasks.filter((t: any) => t.status !== 'done').length > 0) {
      console.log(`[DevOwner] Reassigned ${projectTasks.filter((t: any) => t.status !== 'done').length} active task(s) from ${oldProject.devOwner} to ${newDevOwner} (skipped ${projectTasks.filter((t: any) => t.status === 'done').length} done)`);
    }
  }

  return { ok: true };
}
