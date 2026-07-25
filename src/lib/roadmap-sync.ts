/**
 * roadmap-sync.ts
 *
 * Keeps roadmap-version item `done` flags in sync with task statuses.
 *
 * When the current version's items are all done:
 *   1. Mark it shipped.
 *   2. If the next planned version is in the primary component's
 *      `approvedVersions[]` (#1224), promote it to `current` and move its
 *      linked planning tasks into backlog. The approval list itself is
 *      never modified here — only humans tick checkboxes.
 *   3. If the next planned version is NOT in `approvedVersions[]`, stop.
 *      Agent's work is done until a human approves it.
 *
 * Per docs/decisions/2026-04-19-version-numbering-convention.md:
 *   "Approval is permission. Auto-advance through approved versions is
 *    safe; crossing into unapproved territory is never automatic."
 *
 * Non-fatal: every public function wraps in try/catch so it never
 * breaks the task-update path.  Gracefully no-ops when DATABASE_URL
 * is unset (file-store mode with no Postgres pool).
 */

import { isVersionGreater } from './version-utils';
import { promoteProjectToNextVersionLocked } from './project-state';
import { sendVersionShippedNudge } from './vision-notify';
import { internalAuthHeaders } from './read-gate';
import { recordInternalCallFailure } from './dispatch-ledger';
import { buildProposeNextPrompt } from './done-but-unmet';
import { createHash } from 'crypto';

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
      // #1645: was an unauthenticated GET — cloud mode's read gate 401s it,
      // the early-return swallowed the failure, and auto-advance dispatch
      // silently never fired (#1640 class). Now authed + counted.
      const storeRes = await fetch('http://localhost:4501/api/store', {
        headers: internalAuthHeaders(),
      });
      if (!storeRes.ok) {
        recordInternalCallFailure('roadmap-sync:trigger-store-read', '/api/store', storeRes.status, 'http-status');
        return;
      }
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

/**
 * Fire-and-forget version-shipped Telegram nudge (#1191).
 *
 * Resolves vision owner via teammates from /api/store, then delegates
 * to sendVersionShippedNudge for the actual rpc call. Wrapped in IIFE
 * so the caller never awaits or sees a rejection.
 */
function fireVersionShippedNudge(
  projectId: string,
  projData: any,
  version: string,
): void {
  (async () => {
    try {
      // We need: project name, visionOwner, teammates list.
      const name = projData?.name || projectId;
      const visionOwner = projData?.visionOwner || projData?.owner;
      // Read teammates from store API (same pattern as triggerSchedulerForAgent above).
      let teammates: any[] = [];
      try {
        // #1645: authed internal read + failure counter (was unauthenticated).
        const storeRes = await fetch('http://localhost:4501/api/store', {
          headers: internalAuthHeaders(),
        });
        if (storeRes.ok) {
          const store = await storeRes.json();
          teammates = store?.settings?.teammates || [];
        } else {
          recordInternalCallFailure('roadmap-sync:nudge-store-read', '/api/store', storeRes.status, 'http-status');
        }
      } catch { /* fall through with empty teammates — helper will skip */ }

      await sendVersionShippedNudge(
        { id: projectId, name, visionOwner },
        version,
        teammates,
      );
    } catch (err: any) {
      console.warn(
        `[VersionNudge] ${projectId}: nudge for ${version} failed:`,
        err?.message || err,
      );
    }
  })();
}

/* ------------------------------------------------------------------ */
/*  syncProjectShadowVersion (#1314)                                    */
/* ------------------------------------------------------------------ */

/**
 * Mirror a single roadmap version row into the project document's embedded
 * `sections[].versions[]` and `components[].versions[]` arrays.
 *
 * Why this exists (Trevor caught it 2026-05-12): POST /api/roadmap upsert
 * inserts a new row into `org_studio_roadmap_versions` (canonical) and
 * returns 200 — but the dashboard renders from `project.sections[].versions`
 * (a shadow copy hydrated into the jsonb at write time, NOT a join). When
 * the upsert path didn't write to the shadow, the API was honest about the
 * canonical table but lying about what users would see. Six versions sat in
 * the canonical table for hours while the UI showed the old roadmap.
 *
 * Behavior:
 *   - mode='upsert' → add or replace the matching {version} entry in every
 *     section/component that already carries shadow versions. Sections with
 *     zero existing shadow versions are LEFT ALONE (those projects are
 *     intentionally not using the shadow; we don't seed it from a single
 *     write). Garage-style projects with both `components` and `sections`
 *     get both updated.
 *   - mode='delete' → remove any matching {version} entry from all shadows.
 *
 * Returns counts so callers can log/expose how many places were touched.
 * Idempotent. Safe to call from inside an open transaction (uses the
 * passed-in client's connection).
 */
export async function syncProjectShadowVersion(
  client: any,
  projectId: string,
  mode: 'upsert' | 'delete',
  version: string,
  rowFromCanonical?: {
    id?: string;
    version: string;
    title?: string;
    status?: string;
    items?: any[];
    sort_order?: number;
    version_type?: string;
    owner?: string | null;
    shipped_at?: number | null;
    progress?: { done: number; total: number };
  },
  workspaceId = 'default-workspace',
): Promise<{ sectionsHit: number; componentsHit: number; touched: boolean }> {
  const projRes = await client.query(
    `SELECT data FROM org_studio_projects WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
    [projectId, workspaceId],
  );
  if (projRes.rows.length === 0) {
    return { sectionsHit: 0, componentsHit: 0, touched: false };
  }
  const raw = projRes.rows[0].data;
  const projData =
    raw == null ? {} : typeof raw === 'string' ? JSON.parse(raw) : raw;

  let sectionsHit = 0;
  let componentsHit = 0;
  let dirty = false;

  const containers: Array<'sections' | 'components'> = ['sections', 'components'];
  for (const key of containers) {
    const arr = Array.isArray(projData[key]) ? projData[key] : [];
    for (const container of arr) {
      const versions: any[] = Array.isArray(container.versions) ? container.versions : [];
      // Don't seed shadows that are intentionally empty. Only sync into
      // containers that ALREADY carry version shadows. (Otherwise we'd
      // start populating shadows on projects that opted out.)
      if (versions.length === 0) continue;

      const existingIdx = versions.findIndex((v: any) => v?.version === version);

      if (mode === 'delete') {
        if (existingIdx >= 0) {
          versions.splice(existingIdx, 1);
          container.versions = versions;
          if (key === 'sections') sectionsHit++;
          else componentsHit++;
          dirty = true;
        }
        continue;
      }

      // mode === 'upsert' — replace existing or append new (then sort below)
      const shadowEntry = {
        ...(rowFromCanonical || { version }),
        version,
      };
      if (existingIdx >= 0) {
        // Preserve any per-shadow keys the canonical row didn't set
        versions[existingIdx] = { ...versions[existingIdx], ...shadowEntry };
      } else {
        versions.push(shadowEntry);
      }
      container.versions = versions;

      // #1314.1 (Basil 2026-05-12): keep the shadow array sorted by
      // sort_order ASC after every mutation. The UI renders this array
      // verbatim — no client-side sort — so insertion-order leaves new
      // versions stranded at the bottom (e.g. 0.18.2 sitting after 1.0.0
      // because it was POSTed later). Sort using the same key the
      // canonical table uses (versionSortKey via /lib/version-utils).
      try {
        const { versionSortKey, compareVersions } = require('@/lib/version-utils');
        container.versions.sort((a: any, b: any) => {
          const ao = typeof a?.sort_order === 'number' ? a.sort_order : versionSortKey(a?.version);
          const bo = typeof b?.sort_order === 'number' ? b.sort_order : versionSortKey(b?.version);
          if (ao !== bo) return ao - bo;
          return compareVersions(a?.version || '', b?.version || '');
        });
      } catch {
        // best-effort — if sort utils aren't available, fall back to insertion order
      }

      if (key === 'sections') sectionsHit++;
      else componentsHit++;
      dirty = true;
    }
  }

  if (dirty) {
    await client.query(
      `UPDATE org_studio_projects SET data = $1 WHERE id = $2 AND workspace_id = $3`,
      [JSON.stringify(projData), projectId, workspaceId],
    );
  }

  return { sectionsHit, componentsHit, touched: dirty };
}

/**
 * Drift report for a single project: count canonical roadmap rows vs
 * project-shadow entries and list any versions present in canonical but
 * missing from every shadow container. Read-only; safe to expose via API.
 */
export async function inspectRoadmapDrift(
  client: any,
  projectId: string,
): Promise<{
  canonicalCount: number;
  shadowSummary: Array<{ container: 'sections' | 'components'; id: string; name?: string; count: number }>;
  missingFromAllShadows: string[];
  inSync: boolean;
}> {
  const canRes = await client.query(
    `SELECT version FROM org_studio_roadmap_versions WHERE project_id = $1 AND workspace_id = $2 ORDER BY sort_order ASC, version ASC`,
    [projectId, 'default-workspace'],
  );
  const canonicalVersions: string[] = canRes.rows.map((r: any) => r.version);

  const projRes = await client.query(
    `SELECT data FROM org_studio_projects WHERE id = $1 AND workspace_id = $2`,
    [projectId, 'default-workspace'],
  );

  const shadowSummary: Array<{ container: 'sections' | 'components'; id: string; name?: string; count: number }> = [];
  const versionsInAnyShadow = new Set<string>();

  if (projRes.rows.length > 0) {
    const raw = projRes.rows[0].data;
    const projData =
      raw == null ? {} : typeof raw === 'string' ? JSON.parse(raw) : raw;
    for (const key of ['sections', 'components'] as const) {
      const arr = Array.isArray(projData[key]) ? projData[key] : [];
      for (const c of arr) {
        const versions: any[] = Array.isArray(c.versions) ? c.versions : [];
        for (const v of versions) {
          if (v?.version) versionsInAnyShadow.add(v.version);
        }
        // Only report shadow containers that are actually being used. Empty
        // shadow arrays mean "this project doesn't use the shadow" — not
        // drift.
        if (versions.length > 0) {
          shadowSummary.push({ container: key, id: c.id, name: c.name, count: versions.length });
        }
      }
    }
  }

  // "Missing" means: canonical has it AND at least one shadow exists, but no
  // shadow contains it. If the project carries no shadows at all, drift is
  // not meaningful and we report inSync=true.
  const hasAnyShadow = shadowSummary.length > 0;
  const missingFromAllShadows = hasAnyShadow
    ? canonicalVersions.filter((v) => !versionsInAnyShadow.has(v))
    : [];

  return {
    canonicalCount: canonicalVersions.length,
    shadowSummary,
    missingFromAllShadows,
    inSync: missingFromAllShadows.length === 0,
  };
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
  workspaceId = 'default-workspace',
  existingClient?: any,
): Promise<void> {
  try {
    const pool = getPool();
    if (!existingClient && !pool) return; // file-store mode — no-op for now (file-based roadmaps rare)

    const client = existingClient || await pool.connect();
    const ownClient = !existingClient;
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
        [projectId, workspaceId],
      );

      const flippedVersions: string[] = [];
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
            `UPDATE org_studio_roadmap_versions SET items = $1 WHERE id = $2 AND workspace_id = $3`,
            [JSON.stringify(items), row.id, workspaceId],
          );
          changed = true;
          flippedVersions.push(row.version);
          console.log(
            `[RoadmapSync] ${projectId} ${row.version}: item ${taskId} → done=${isDone}`,
          );
        }
      }

      // #1181 — keep the project document's embedded sections[].versions[].items[]
      // copy in lock-step with org_studio_roadmap_versions. Components like
      // RoadmapWithApprovalHorizon receive `versions={compVersions}` as a prop
      // sourced from the project doc, so without this patch the roadmap card
      // renders stale `item.done` flags even though /api/roadmap returns fresh
      // data. Same transaction → atomic.
      if (changed) {
        const projRes = await client.query(
          `SELECT data FROM org_studio_projects
           WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
          [projectId, workspaceId],
        );
        const projRow = projRes.rows[0];
        if (projRow?.data) {
          const projData =
            typeof projRow.data === 'string' ? JSON.parse(projRow.data) : projRow.data;
          let docChanged = false;
          const sections: any[] = projData.sections || [];
          for (const section of sections) {
            const versions: any[] = section.versions || [];
            for (const v of versions) {
              if (!flippedVersions.includes(v.version)) continue;
              const vItems: any[] = v.items || [];
              for (const item of vItems) {
                if (item.taskId === taskId && item.done !== isDone) {
                  item.done = isDone;
                  docChanged = true;
                }
              }
            }
          }
          if (docChanged) {
            await client.query(
              `UPDATE org_studio_projects SET data = $1 WHERE id = $2 AND workspace_id = $3`,
              [JSON.stringify(projData), projectId, workspaceId],
            );
            console.log(
              `[RoadmapSync] ${projectId}: project doc embedded items synced for task ${taskId} → done=${isDone}`,
            );
          }
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
      if (ownClient) client.release();
    }

    if (shouldCheckAdvance) {
      // Await the canonical lifecycle transaction. The task-close response must
      // not win the race against an unmet outcome handoff: checkAndAutoAdvance
      // durably queues that handoff before it commits and returns.
      await checkAndAutoAdvance(projectId, existingClient, workspaceId);
    }
  } catch (err: any) {
    console.error('[RoadmapSync] syncRoadmapItemForTask error (non-fatal):', err?.message || err);
  }
}

/* ------------------------------------------------------------------ */
/*  checkAndAutoAdvance                                                */
/* ------------------------------------------------------------------ */

export interface AdvanceAfterShipmentOutcome {
  result: import('./project-state').PromoteResult;
  ownerToWake?: string;
  pointer?: string;
  shipped?: {
    projectData: any;
    version: string;
  };
  unmetHandoff?: {
    versionId: string;
    version: string;
    idempotencyKey: string;
    owner?: string;
    agentId?: string;
    queued: boolean;
    reason?: 'duplicate' | 'no-responsible-owner';
  };
}

function noPromotion(reason: string): import('./project-state').PromoteResult {
  return { promoted: false, from: null, to: null, movedTasks: 0, reason };
}

function primaryProjectOwner(projectData: any): string[] {
  const components: any[] = Array.isArray(projectData?.components) && projectData.components.length > 0
    ? projectData.components
    : Array.isArray(projectData?.sections) ? projectData.sections : [];
  const primary = components.find(
    (component: any) => !component?.role || (component.role !== 'qa' && component.role !== 'support'),
  ) || components[0];
  const candidates = [
    primary?.owner,
    projectData?.devOwner,
    projectData?.owner,
    projectData?.visionOwner,
  ];
  return candidates.filter((owner, index, all) => {
    const normalized = (owner || '').toString().trim().toLowerCase();
    return normalized && all.findIndex((candidate) =>
      (candidate || '').toString().trim().toLowerCase() === normalized,
    ) === index;
  }).map((owner) => owner.toString().trim());
}

function outcomeHandoffKey(
  workspaceId: string,
  projectId: string,
  current: any,
  meta: any,
): string {
  const itemSignature = (current.items || [])
    .map((item: any) => `${item.id || ''}:${item.taskId || ''}:${item.done === true ? '1' : '0'}`)
    .sort();
  const state = JSON.stringify({
    workspaceId,
    projectId,
    versionId: current.id,
    version: current.version,
    items: itemSignature,
    successCriteria: (meta.successCriteria || '').toString().trim(),
    metricCurrent: typeof meta.metricCurrent === 'number' ? meta.metricCurrent : null,
    metricTarget: typeof meta.metricTarget === 'number' ? meta.metricTarget : null,
    metricComparator: meta.metricComparator || 'gte',
  });
  return `outcome-unmet-${createHash('sha256').update(state).digest('hex')}`;
}

async function resolveOutcomeOwner(
  client: any,
  workspaceId: string,
  candidates: string[],
): Promise<{ owner: string; agentId: string } | undefined> {
  if (candidates.length === 0) return undefined;
  const settingsResult = await client.query(
    `SELECT data FROM org_studio_settings
     WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
    ['default', workspaceId],
  );
  const raw = settingsResult.rows[0]?.data;
  const settings = raw == null ? {} : typeof raw === 'string' ? JSON.parse(raw) : raw;
  const teammates: any[] = Array.isArray(settings?.teammates) ? settings.teammates : [];
  for (const owner of candidates) {
    const normalized = owner.toLowerCase();
    const teammate = teammates.find((entry: any) =>
      (entry?.name || '').toString().trim().toLowerCase() === normalized ||
      (entry?.agentId || '').toString().trim().toLowerCase() === normalized,
    );
    if (teammate?.agentId) return { owner, agentId: teammate.agentId };
  }
  return undefined;
}

async function queueUnmetOutcomeHandoff(
  client: any,
  workspaceId: string,
  projectId: string,
  projectData: any,
  current: any,
  meta: any,
): Promise<{ handoff: NonNullable<AdvanceAfterShipmentOutcome['unmetHandoff']>; nextMeta: any }> {
  const idempotencyKey = outcomeHandoffKey(workspaceId, projectId, current, meta);
  if (meta.lastOutcomeHandoffKey === idempotencyKey && meta.lastOutcomeHandoffAt) {
    return {
      handoff: {
        versionId: current.id,
        version: current.version,
        idempotencyKey,
        queued: false,
        reason: 'duplicate',
      },
      nextMeta: meta,
    };
  }
  const candidates = [
    (current.owner || '').toString().trim(),
    ...primaryProjectOwner(projectData),
  ].filter(Boolean);
  const resolved = await resolveOutcomeOwner(client, workspaceId, candidates);
  if (!resolved) {
    return {
      handoff: {
        versionId: current.id,
        version: current.version,
        idempotencyKey,
        queued: false,
        reason: 'no-responsible-owner',
      },
      nextMeta: meta,
    };
  }

  const prompt = buildProposeNextPrompt({
    id: current.id,
    version: current.version,
    status: current.status,
    owner: resolved.owner,
    successCriteria: meta.successCriteria,
    metricCurrent: meta.metricCurrent,
    metricTarget: meta.metricTarget,
    metricComparator: meta.metricComparator,
    loopPaused: meta.loopPaused,
    items: current.items || [],
  });
  const outboxId = `outcome-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`;
  const inserted = await client.query(
    `INSERT INTO org_studio_outbox
       (id, idempotency_key, agent_id, payload, status, attempts,
        next_attempt_at, created_at, updated_at, workspace_id)
     VALUES ($1, $2, $3, $4::jsonb, 'pending', 0, NOW(), NOW(), NOW(), $5)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      outboxId,
      idempotencyKey,
      resolved.agentId,
      JSON.stringify({ message: prompt, sessionKey: `agent:${resolved.agentId}:main` }),
      workspaceId,
    ],
  );
  const now = Date.now();
  const queued = (inserted.rowCount || 0) > 0;
  return {
    handoff: {
      versionId: current.id,
      version: current.version,
      idempotencyKey,
      owner: resolved.owner,
      agentId: resolved.agentId,
      queued,
      ...(queued ? {} : { reason: 'duplicate' as const }),
    },
    // This durable stamp makes the periodic sweep recovery-only. It is
    // committed atomically with the outbox row; if the transaction rolls
    // back, neither survives and the sweep remains free to recover.
    nextMeta: {
      ...meta,
      lastProposeNudgeAt: now,
      lastOutcomeHandoffKey: idempotencyKey,
      lastOutcomeHandoffAt: now,
    },
  };
}

/**
 * Locked implementation shared with checkAndAutoAdvance. The caller must hold
 * the per-project roadmap lifecycle advisory transaction lock.
 */
export async function advanceAfterShipmentLocked(
  projectId: string,
  shippedVersion: string | undefined,
  client: any,
  workspaceId: string,
  includeShippedEffect = false,
): Promise<AdvanceAfterShipmentOutcome> {
  const projRes = await client.query(
    `SELECT data FROM org_studio_projects
     WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
    [projectId, workspaceId],
  );
  if (projRes.rows.length === 0) return { result: noPromotion('project not found') };
  const projData = typeof projRes.rows[0].data === 'string'
    ? JSON.parse(projRes.rows[0].data)
    : projRes.rows[0].data || {};
  const pointer = projData.currentVersion || null;
  if (!pointer) return { result: noPromotion('project has no currentVersion pointer') };
  if (shippedVersion && pointer !== shippedVersion) {
    return { result: noPromotion(`project already moved past ${shippedVersion}`), pointer };
  }

  const sourceRes = await client.query(
    `SELECT status FROM org_studio_roadmap_versions
     WHERE project_id = $1 AND version = $2 AND workspace_id = $3 LIMIT 1`,
    [projectId, pointer, workspaceId],
  );
  if (sourceRes.rows[0]?.status !== 'shipped') {
    return { result: noPromotion(`currentVersion ${pointer} is not shipped`), pointer };
  }

  // Only the write path that just transitioned current→shipped should emit
  // the shipment effect. Durable stale-pointer recovery intentionally leaves
  // this false so repeated no-op reconciles cannot spam shipment nudges.
  const shipped = includeShippedEffect
    ? { projectData: projData, version: pointer }
    : undefined;

  const result = await promoteProjectToNextVersionLocked(projectId, client, { workspaceId });
  if (!result.promoted || !result.to) return { result, pointer, shipped };

  const ownerRes = await client.query(
    `SELECT owner FROM org_studio_roadmap_versions
     WHERE project_id = $1 AND version = $2 AND workspace_id = $3 LIMIT 1`,
    [projectId, result.to, workspaceId],
  );
  const components: any[] = Array.isArray(projData.components) && projData.components.length > 0
    ? projData.components
    : Array.isArray(projData.sections) ? projData.sections : [];
  const primary = components.find(
    (c: any) => !c?.role || (c.role !== 'qa' && c.role !== 'support'),
  ) || components[0];
  const ownerToWake = ownerRes.rows[0]?.owner || primary?.owner || projData.devOwner;
  return { result, ownerToWake, pointer, shipped };
}

/**
 * Run effects that must only observe committed lifecycle state. Callers that
 * use a locked helper inside their own transaction must invoke this strictly
 * after COMMIT.
 */
async function queueRoadmapLifecycleChange(
  client: any,
  projectId: string,
  workspaceId: string,
): Promise<void> {
  const payload = JSON.stringify({
    type: 'project_update',
    projectId,
    timestamp: Date.now(),
    source: 'roadmap-lifecycle',
    workspace_id: workspaceId,
  });
  await client.query(`NOTIFY org_studio_change, '${payload.replace(/'/g, "''")}'`);
}

export function dispatchRoadmapLifecyclePostCommit(
  projectId: string,
  outcome?: AdvanceAfterShipmentOutcome,
): void {
  if (!outcome) return;
  if (outcome.shipped) {
    fireVersionShippedNudge(
      projectId,
      outcome.shipped.projectData,
      outcome.shipped.version,
    );
  }
  if (outcome.result.promoted && outcome.result.to && outcome.ownerToWake) {
    triggerSchedulerForAgent(outcome.ownerToWake);
  }
}

/**
 * Continue from a canonical version that is already marked shipped while the
 * project pointer still names it. This is the idempotent recovery seam for
 * manual current→shipped edits and interrupted post-ship dispatches.
 *
 * The whole repair is serialized and committed atomically per project. The
 * scheduler wake happens only after commit, so it cannot observe half-applied
 * pointer/task state.
 */
export async function advanceAfterShipment(
  projectId: string,
  shippedVersion?: string,
  existingClient?: any,
  workspaceId = 'default-workspace',
): Promise<import('./project-state').PromoteResult> {
  const pool = getPool();
  if (!existingClient && !pool) return noPromotion('postgres unavailable');

  const client = existingClient || await pool.connect();
  const ownClient = !existingClient;
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`roadmap-lifecycle:${workspaceId}:${projectId}`],
    );
    const outcome = await advanceAfterShipmentLocked(
      projectId,
      shippedVersion,
      client,
      workspaceId,
    );
    if (outcome.result.promoted) {
      await queueRoadmapLifecycleChange(client, projectId, workspaceId);
    }
    await client.query('COMMIT');

    if (outcome.result.promoted && outcome.result.to) {
      dispatchRoadmapLifecyclePostCommit(projectId, outcome);
      console.log(
        `[AutoAdvance] ${projectId}: ${outcome.pointer} → ${outcome.result.to} (${outcome.result.movedTasks} tasks moved planning→backlog)`,
      );
    }
    return outcome.result;
  } catch (err: any) {
    try { await client.query('ROLLBACK'); } catch { /* best-effort */ }
    console.error('[AutoAdvance] advanceAfterShipment error (non-fatal):', err?.message || err);
    return noPromotion(err?.message || 'advance-after-shipment failed');
  } finally {
    if (ownClient) client.release();
  }
}

/**
 * If the current version has all items done:
 *   • Mark it shipped.
 *   • If the next planned version is ≤ horizon, promote it to `current`
 *     and move its planning tasks to backlog.
 *   • Otherwise stop — horizon is the hard ceiling.
 *
 * The approval list (`primary.approvedVersions[]`) is NEVER written by this
 * function. Only humans tick checkboxes.
 *
 * @param projectId - the project to check
 * @param existingClient - optional pg client to reuse (avoids extra checkout)
 */
export async function checkAndAutoAdvanceLocked(
  projectId: string,
  client: any,
  workspaceId: string,
): Promise<AdvanceAfterShipmentOutcome | undefined> {
  // 1. Lock the project pointer first. It is the authoritative lifecycle
  // source. If it names a shipped row while a successor is already current,
  // repair that successor before evaluating it; otherwise a retry could ship
  // the successor and skip directly to a later planned version.
  const projectResult = await client.query(
    `SELECT data FROM org_studio_projects
     WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
    [projectId, workspaceId],
  );
  if (projectResult.rows.length === 0) return;
  const projectData = typeof projectResult.rows[0].data === 'string'
    ? JSON.parse(projectResult.rows[0].data)
    : projectResult.rows[0].data || {};
  const pointer = projectData.currentVersion || null;
  if (!pointer) return;

  const pointerStatusResult = await client.query(
    `SELECT status FROM org_studio_roadmap_versions
     WHERE project_id = $1 AND version = $2 AND workspace_id = $3 LIMIT 1`,
    [projectId, pointer, workspaceId],
  );
  if (pointerStatusResult.rows[0]?.status === 'shipped') {
    return advanceAfterShipmentLocked(projectId, pointer, client, workspaceId);
  }
  if (pointerStatusResult.rows[0]?.status !== 'current') return;

  // Find only the canonical current row named by the locked project pointer.
  const versionResult = await client.query(
    `SELECT id, version, status, items, sort_order, owner, meta
     FROM org_studio_roadmap_versions
     WHERE project_id = $1 AND status = 'current' AND workspace_id = $2
       AND version = $3
     ORDER BY sort_order ASC
     LIMIT 1 FOR UPDATE`,
    [projectId, workspaceId, pointer],
  );
  if (versionResult.rows.length === 0) return;

  const current = versionResult.rows[0];
  const items: any[] = current.items || [];

  // All items must be done (zero-item versions are auto-shipped)
  if (items.length > 0 && !items.every((i: any) => i.done === true)) return;

  // #1263 — outcome-bound gate. If `successCriteria` is set on this
  // version, ship is gated on `metricCurrent` satisfying the comparator
  // vs `metricTarget`. When the gate fails, post a one-shot system
  // comment on the rv-row's `meta.systemComments[]` and return without
  // shipping. The flag `meta.metricNotMetCommentedAt` makes the comment
  // idempotent across repeated calls; it's cleared once the metric IS
  // met (so future regressions get a fresh comment).
  {
    const meta: any = (current.meta && typeof current.meta === 'object') ? current.meta : {};
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
        const now = Date.now();
        const xy = `${typeof cur === 'number' ? cur : '?'}/${typeof target === 'number' ? target : '?'}`;
        // Keep the existing roadmap-visible one-shot comment, but also queue
        // the responsible owner's actionable handoff in THIS transaction.
        // The outbox row is invisible until COMMIT, so delivery cannot race
        // ahead of the canonical gate result or survive a rollback.
        let nextMeta = { ...meta };
        if (!meta.metricNotMetCommentedAt) {
          const list = Array.isArray(meta.systemComments) ? [...meta.systemComments] : [];
          list.push({
            at: now,
            text: `All tickets complete; metric not met (${xy}). Record attributable evidence or propose the next experiment.`,
          });
          nextMeta = { ...nextMeta, systemComments: list, metricNotMetCommentedAt: now };
        }
        const queued = await queueUnmetOutcomeHandoff(
          client,
          workspaceId,
          projectId,
          projectData,
          current,
          nextMeta,
        );
        nextMeta = queued.nextMeta;
        await client.query(
          `UPDATE org_studio_roadmap_versions SET meta = $1::jsonb WHERE id = $2 AND workspace_id = $3`,
          [JSON.stringify(nextMeta), current.id, workspaceId],
        );
        console.log(
          `[AutoAdvance] ${projectId}: ${current.version} — metric not met (${xy}); ` +
          `${queued.handoff.queued ? `handoff queued for ${queued.handoff.agentId}` : `handoff ${queued.handoff.reason}`}, NOT shipping`,
        );
        (checkAndAutoAdvance as any)._lastSkipReason = 'metric_not_met';
        return {
          result: noPromotion('metric not met'),
          pointer,
          unmetHandoff: queued.handoff,
        };
      }
      // Metric met — clear the not-met state so a future regression gets
      // a fresh comment and a fresh closeout handoff. This never changes the
      // metric itself; it only resets notification idempotency after success.
      if (
        meta.metricNotMetCommentedAt ||
        meta.lastOutcomeHandoffKey ||
        meta.lastOutcomeHandoffAt ||
        meta.lastProposeNudgeAt
      ) {
        const nextMeta = { ...meta };
        delete nextMeta.metricNotMetCommentedAt;
        delete nextMeta.lastOutcomeHandoffKey;
        delete nextMeta.lastOutcomeHandoffAt;
        delete nextMeta.lastProposeNudgeAt;
        await client.query(
          `UPDATE org_studio_roadmap_versions SET meta = $1::jsonb WHERE id = $2 AND workspace_id = $3`,
          [JSON.stringify(nextMeta), current.id, workspaceId],
        );
      }
    }
  }

  // 2. Ship the current version
  const shippedAt = Date.now();
  await client.query(
    `UPDATE org_studio_roadmap_versions SET status = 'shipped', shipped_at = $1
     WHERE id = $2 AND workspace_id = $3`,
    [String(shippedAt), current.id, workspaceId],
  );
  console.log(`[VersionShip] ${projectId}: ${current.version} shipped`);

  // 3. Read project autonomy from the row locked above.
  const projData = projectData;

  const approvedVersionsList: string[] = (() => {
    // #1224: derive from primary component's approvedVersions[] only.
    // #1314.2 (Basil 2026-05-12): fall back to first container when no
    // non-support/qa primary exists — prevents single-section support-
    // role projects from being silently un-advanceable. Same rule applied
    // in promoteProjectToNextVersion (project-state.ts).
    const comps: any[] = Array.isArray(projData.components) && projData.components.length > 0
      ? projData.components
      : Array.isArray(projData.sections) ? projData.sections : [];
    const primary =
      comps.find((c: any) => !c?.role || (c.role !== 'qa' && c.role !== 'support'))
      || comps[0];
    return Array.isArray(primary?.approvedVersions) ? primary.approvedVersions : [];
  })();

  // #1191 — the shipped nudge is deferred until the outer transaction
  // commits. Sending here could announce a shipment that later rolls back.
  const shipped = { projectData: projData, version: current.version };

  // 3b. Project state gate: if project is explicitly inactive, the human has
  // paused auto-advance. Reconcile still ships the completed version (done flags
  // + status='shipped' are factual), but we do NOT promote a next version.
  // (#1185 rename: 'stopped' → 'inactive'. Accept both during transition.)
  if (projData.state === 'inactive' || projData.state === 'stopped') {
    console.log(
      `[AutoAdvance] ${projectId}: project inactive — shipped ${current.version} but skipping auto-advance`,
    );
    (checkAndAutoAdvance as any)._lastSkipReason = 'inactive';
    return { result: noPromotion('project inactive'), pointer, shipped };
  }

  // Legacy compat: also check currentVersion === null for un-migrated projects
  if (projData.currentVersion === null || projData.currentVersion === undefined) {
    console.log(
      `[AutoAdvance] ${projectId}: project paused (currentVersion=null) — shipped ${current.version} but skipping auto-advance`,
    );
    (checkAndAutoAdvance as any)._lastSkipReason = 'paused';
    return { result: noPromotion('project paused'), pointer, shipped };
  }

  // 4. No approvals = nothing to advance to.
  // #1187: auto-deactivate REMOVED. Project state is user-controlled only.
  // We log and return; the project stays active until the user explicitly
  // deactivates from the UI.
  if (approvedVersionsList.length === 0) {
    console.log(
      `[AutoAdvance] ${projectId}: no versions approved — shipped ${current.version}, awaiting user approval to continue`,
    );
    return { result: noPromotion('no versions approved'), pointer, shipped };
  }

  // 5-10. Delegate to shared promote util (handles finding next version,
  //       horizon gate, taskId gate, version status update, task moves,
  //       and currentVersion bump).
  const outcome = await advanceAfterShipmentLocked(projectId, current.version, client, workspaceId);
  outcome.shipped = shipped;
  if (!outcome.result.promoted) {
    console.log(
      `[AutoAdvance] ${projectId}: ${current.version} shipped — promote skipped: ${outcome.result.reason}`,
    );

    // #1187: auto-deactivate REMOVED. Promote skipped means there's no
    // next approved version to advance to — the project simply stays put
    // with currentVersion at the just-shipped version. The user can
    // approve another version to continue, or explicitly deactivate.
    console.log(
      `[AutoAdvance] ${projectId}: ${current.version} shipped, no next approved version to promote — awaiting user approval`,
    );
  }
  return outcome;
}

export async function checkAndAutoAdvance(
  projectId: string,
  existingClient?: any,
  workspaceId = 'default-workspace',
): Promise<void> {
  const pool = getPool();
  if (!existingClient && !pool) return;

  const client = existingClient || await pool.connect();
  const ownClient = !existingClient;
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`roadmap-lifecycle:${workspaceId}:${projectId}`],
    );
    const outcome = await checkAndAutoAdvanceLocked(projectId, client, workspaceId);
    if (outcome?.shipped || outcome?.result.promoted || outcome?.unmetHandoff) {
      await queueRoadmapLifecycleChange(client, projectId, workspaceId);
    }
    await client.query('COMMIT');

    dispatchRoadmapLifecyclePostCommit(projectId, outcome);
    if (outcome?.unmetHandoff?.queued) {
      console.log(
        `[OutcomeGate] ${projectId} ${outcome.unmetHandoff.version}: durable owner handoff committed for ${outcome.unmetHandoff.agentId}`,
      );
    }
    if (outcome?.result.promoted && outcome.result.to) {
      console.log(
        `[AutoAdvance] ${projectId}: ${outcome.pointer} → ${outcome.result.to} (${outcome.result.movedTasks} tasks moved planning→backlog)`,
      );
    }
  } catch (err: any) {
    try { await client.query('ROLLBACK'); } catch { /* best-effort */ }
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
 * @param workspaceId - request-scoped workspace; reconciliation never crosses tenants.
 * @returns summary counts for logging / API response.
 */
export async function reconcileRoadmapItemDone(
  projectId?: string,
  workspaceId = 'default-workspace',
): Promise<{ scanned: number; flipped: number; shipped: number; advanced: number; skippedAdvance: number }> {
  const summary = { scanned: 0, flipped: 0, shipped: 0, advanced: 0, skippedAdvance: 0 };
  const pool = getPool();
  if (!pool) return summary;

  try {
    const client = await pool.connect();
    try {
      // 1. Find all canonical current versions (optionally one project).
      const versionsRes = projectId
        ? await client.query(
            `SELECT id, project_id, version, items FROM org_studio_roadmap_versions
             WHERE status = 'current' AND workspace_id = $1 AND project_id = $2`,
            [workspaceId, projectId],
          )
        : await client.query(
            `SELECT id, project_id, version, items FROM org_studio_roadmap_versions
             WHERE status = 'current' AND workspace_id = $1`,
            [workspaceId],
          );

      summary.scanned = versionsRes.rows.length;
      const completed: Array<{ projectId: string; version: string }> = [];

      // 2. Reconcile item flags only. Do NOT mark a version shipped here:
      // checkAndAutoAdvance owns the outcome gate and must see the row while
      // it is still current. The old reconcile path shipped first, bypassed
      // the metric gate, then called a function that could no longer find a
      // current row to advance.
      for (const v of versionsRes.rows) {
        try {
          await client.query('BEGIN');
          const locked = await client.query(
            `SELECT id, project_id, version, items FROM org_studio_roadmap_versions
             WHERE id = $1 AND status = 'current' AND workspace_id = $2 FOR UPDATE`,
            [v.id, workspaceId],
          );
          if (locked.rows.length === 0) {
            await client.query('COMMIT');
            continue;
          }

          const row = locked.rows[0];
          const items: any[] = row.items || [];
          const taskIds = items.map((i: any) => i.taskId).filter(Boolean);
          const statusMap = new Map<string, string>();
          if (taskIds.length > 0) {
            const tRes = await client.query(
              `SELECT id, status FROM org_studio_tasks WHERE id = ANY($1) AND workspace_id = $2`,
              [taskIds, workspaceId],
            );
            for (const t of tRes.rows) statusMap.set(t.id, t.status);
          }

          let localFlipped = 0;
          for (const item of items) {
            if (!item.taskId) continue;
            const actualStatus = statusMap.get(item.taskId);
            if (actualStatus === undefined) continue;
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
              `UPDATE org_studio_roadmap_versions
               SET items = $1
               WHERE id = $2 AND workspace_id = $3`,
              [JSON.stringify(items), row.id, workspaceId],
            );
            summary.flipped += localFlipped;
          }

          if (items.length > 0 && items.every((i: any) => i.done === true)) {
            completed.push({ projectId: row.project_id, version: row.version });
          }
          await client.query('COMMIT');
        } catch (vErr: any) {
          try { await client.query('ROLLBACK'); } catch { /* best-effort */ }
          console.error(
            `[RoadmapReconcile] version ${v.id} error (non-fatal):`,
            vErr?.message || vErr,
          );
        }
      }

      // 3. Let the normal lifecycle path evaluate each completed current row.
      for (const candidate of completed) {
        try {
          const beforeProject = await client.query(
            `SELECT data FROM org_studio_projects WHERE id = $1 AND workspace_id = $2`,
            [candidate.projectId, workspaceId],
          );
          const beforeData = beforeProject.rows.length === 0
            ? {}
            : typeof beforeProject.rows[0].data === 'string'
              ? JSON.parse(beforeProject.rows[0].data)
              : beforeProject.rows[0].data || {};
          const wasPaused = beforeData.state === 'inactive' || beforeData.state === 'stopped' ||
            beforeData.currentVersion === null || beforeData.currentVersion === undefined;

          await checkAndAutoAdvance(candidate.projectId, client, workspaceId);

          const sourceAfter = await client.query(
            `SELECT status FROM org_studio_roadmap_versions
             WHERE project_id = $1 AND version = $2 AND workspace_id = $3 LIMIT 1`,
            [candidate.projectId, candidate.version, workspaceId],
          );
          if (sourceAfter.rows[0]?.status === 'shipped') summary.shipped++;

          const afterProject = await client.query(
            `SELECT data FROM org_studio_projects WHERE id = $1 AND workspace_id = $2`,
            [candidate.projectId, workspaceId],
          );
          const afterData = afterProject.rows.length === 0
            ? {}
            : typeof afterProject.rows[0].data === 'string'
              ? JSON.parse(afterProject.rows[0].data)
              : afterProject.rows[0].data || {};
          if (afterData.currentVersion && afterData.currentVersion !== beforeData.currentVersion) {
            summary.advanced++;
          } else if (wasPaused && sourceAfter.rows[0]?.status === 'shipped') {
            summary.skippedAdvance++;
          }
        } catch (advErr: any) {
          console.error(
            `[RoadmapReconcile] lifecycle ${candidate.projectId} error (non-fatal):`,
            advErr?.message || advErr,
          );
        }
      }

      // 4. Recovery: find projects whose pointer still names a canonical
      // shipped row. This is the durable self-heal for a manual ship or an
      // interrupted older lifecycle path. advanceAfterShipment is idempotent:
      // after a successful move the pointer no longer matches this row.
      const staleRes = projectId
        ? await client.query(
            `SELECT p.id AS project_id, p.data->>'currentVersion' AS version
             FROM org_studio_projects p
             JOIN org_studio_roadmap_versions v
               ON v.project_id = p.id
              AND v.workspace_id = p.workspace_id
              AND v.version = p.data->>'currentVersion'
             WHERE p.workspace_id = $1 AND p.id = $2 AND v.status = 'shipped'`,
            [workspaceId, projectId],
          )
        : await client.query(
            `SELECT p.id AS project_id, p.data->>'currentVersion' AS version
             FROM org_studio_projects p
             JOIN org_studio_roadmap_versions v
               ON v.project_id = p.id
              AND v.workspace_id = p.workspace_id
              AND v.version = p.data->>'currentVersion'
             WHERE p.workspace_id = $1 AND v.status = 'shipped'`,
            [workspaceId],
          );

      for (const stale of staleRes.rows) {
        try {
          const result = await advanceAfterShipment(
            stale.project_id,
            stale.version,
            client,
            workspaceId,
          );
          if (result.promoted) summary.advanced++;
        } catch (recoverErr: any) {
          console.error(
            `[RoadmapReconcile] shipped-pointer recovery ${stale.project_id} error (non-fatal):`,
            recoverErr?.message || recoverErr,
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
