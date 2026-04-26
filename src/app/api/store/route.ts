import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, authenticateRequestWithContext, getSession, getSessionTokenFromCookie } from '@/lib/auth';
import { rpc } from '@/lib/gateway-rpc';
import { getStoreProvider, type StoreData } from '@/lib/store-provider';
import { parseMentions } from '@/lib/mention-notifier';
import { routeCommentNotifications } from '@/lib/notification-router';
import { syncRoadmapItemForTask } from '@/lib/roadmap-sync';
import { checkArchivedProject } from '@/lib/archived-project-compat';
import { isTelegramCommsEnabled } from '@/lib/telegram-guard';
import {
  resolveWorkspaceContext,
  filterByWorkspace,
  stampWorkspace,
  belongsToWorkspace,
  DEFAULT_WORKSPACE_ID,
  type WorkspaceContext,
} from '@/lib/workspace-auth';

const SCHEDULER_URL = 'http://localhost:4501/api/scheduler';

const DEFAULT_LOOP_STEPS = [
  {
    id: 'step-org',
    type: 'read-org',
    enabled: true,
    description: 'Read ORG.md — refresh mission, values, domain boundaries',
  },
  {
    id: 'step-sync',
    type: 'sync-tasks',
    enabled: true,
    description: 'Sync tasks — check Context Board, create task if doing untracked work',
  },
  {
    id: 'step-work',
    type: 'work-next',
    enabled: true,
    description: 'Work next — progress highest priority in-progress task, or pull from backlog',
  },
  {
    id: 'step-report',
    type: 'report',
    enabled: true,
    description: 'Report — update task status, move completed to Done, set activity status',
  },
];

/** Resolve model from agent name via Gateway sessions list. Best-effort, returns undefined on failure. */
async function resolveAgentModel(agentName: string, store: StoreData): Promise<string | undefined> {
  try {
    // Resolve agent name → agentId
    const teammates = (store as any).settings?.teammates || [];
    const match = teammates.find((t: any) =>
      t.name?.toLowerCase() === agentName?.toLowerCase() ||
      t.agentId === agentName?.toLowerCase()
    );
    const agentId = match?.agentId;
    if (!agentId) return undefined;

    // Query Gateway for active sessions
    const port = process.env.GATEWAY_PORT || '4501';
    const resp = await fetch(`http://127.0.0.1:${port}/api/gateway`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'sessions.list', params: { limit: 50 } }),
    });
    const data = await resp.json();
    const sessions = Array.isArray(data.result) ? data.result : (data.result?.sessions || data.result?.items || []);

    // Find the most recent active session for this agent
    const agentSession = sessions.find((s: any) =>
      s.key?.startsWith(`agent:${agentId}:`) && s.model
    );
    return agentSession?.model || undefined;
  } catch {
    return undefined; // best-effort — never block on this
  }
}

/** Generate next ticket number for a new task.
 *  @deprecated #863 — use getStoreProvider().allocateTicketNumber() which is atomic.
 *  Kept only as an emergency fallback if the provider call throws.
 */
function getNextTicketNumberFallback(store: StoreData): number {
  const existingNumbers = store.tasks
    .map(t => t.ticketNumber || 0)
    .filter(n => typeof n === 'number');
  return Math.max(...existingNumbers, 0) + 1;
}

// Gateway RPC for notifications
const GATEWAY_WS_URL = process.env.GATEWAY_URL || 'ws://127.0.0.1:18789';
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || process.env.NOTIFY_CHAT_ID || '';

// Async wrappers for StoreProvider
async function readStore() {
  return await getStoreProvider().read();
}

async function writeStore(data: any) {
  return await getStoreProvider().write(data);
}

/** Check if a task is stuck and fire event-driven trigger if so. Piggyback detection. */
function checkAndTriggerStuckTask(task: any, store: StoreData) {
  const STUCK_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours
  const now = Date.now();
  const status = (task.status || '').toLowerCase();

  if (status !== 'in-progress') return; // #862: Only in-progress has the stuck-task escalation path now
  if (task.isArchived) return; // Don't check archived tasks

  // Get last activity timestamp
  const lastActivity = task.lastActivityAt
    || (task.statusHistory?.length ? task.statusHistory[task.statusHistory.length - 1]?.timestamp : null)
    || task.createdAt
    || 0;

  if (now - lastActivity < STUCK_THRESHOLD_MS) return; // Not stuck yet

  // Task is stuck — responsible agent is the assignee (#862: QA tickets use standard assignee now)
  let responsibleName: string | null = null;
  if (!responsibleName) {
    responsibleName = task.assignee;
  }
  if (!responsibleName) return;

  // Resolve name → agentId
  const teammates = (store as any).settings?.teammates || [];
  const match = teammates.find((t: any) =>
    t.name?.toLowerCase() === responsibleName?.toLowerCase() ||
    t.agentId?.toLowerCase() === responsibleName?.toLowerCase()
  );
  const agentId = match?.agentId;
  if (!agentId) return;

  // Post a system comment notifying about stuck status
  const hours = Math.round((now - lastActivity) / (60 * 60 * 1000));
  if (!task.comments) task.comments = [];
  task.comments.push({
    id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
    createdAt: now,
    author: 'System',
    content: `⏱️ **Task stuck** — in ${status} for ${hours}+ hours. Triggering agent to resume.`,
    type: 'system',
  });

  // Fire event-driven trigger (same as triggerAgentLoop)
  (async () => {
    const MAX_RETRIES = 3;
    const DELAYS = [1000, 5000, 15000];
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
        if (res.ok) {
          console.log(`[Stuck Task] Triggered ${agentId}: task stuck in ${status} for ${hours}h`);
          return;
        }
        console.warn(`[Stuck Task] attempt ${attempt + 1} failed: HTTP ${res.status}`);
      } catch (e: any) {
        console.warn(`[Stuck Task] attempt ${attempt + 1} error:`, e?.message || e);
      }
      if (attempt < MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, DELAYS[attempt]));
      }
    }
    console.error(`[Stuck Task] all ${MAX_RETRIES} attempts failed for agent ${agentId}`);
  })();
}

/** Fire event-driven scheduler trigger for an agent when work lands in their backlog. Best-effort, non-blocking with retry. */
function triggerAgentLoop(assignee: string, store: StoreData) {
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
      } catch (e: any) {
        console.warn(`triggerAgentLoop attempt ${attempt + 1} error:`, e?.message || e);
      }
      if (attempt < MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, DELAYS[attempt]));
      }
    }
    console.error(`triggerAgentLoop: all ${MAX_RETRIES} attempts failed for agent ${agentId}`);
  })();
}


/** Send task status notification via Telegram. Best-effort, non-blocking. */
function notifyTaskStatusChange(task: any, newStatus: string, store: StoreData) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  if (!isTelegramCommsEnabled()) return; // v0.15: comms relay disabled by default
  
  // Notify on all significant status transitions (user needs to see these)
  // All statuses go to the activity feed, but only high-signal ones go to Telegram
  const FEED_STATUSES = ['in-progress', 'review', 'done', 'blocked']; // #862: dropped 'qa'
  const TELEGRAM_STATUSES = ['blocked']; // Only blocked tasks are urgent enough for Telegram
  if (!FEED_STATUSES.includes(newStatus)) return;

  const project = store.projects.find((p: any) => p.id === task.projectId);
  const projectName = project?.name || 'Unknown';
  const assignee = task.assignee || 'Unassigned';
  const reviewNotes = task.reviewNotes?.trim();

  const statusEmoji: Record<string, string> = {
    'in-progress': '⚙️',
    'review': '👀',
    'done': '✅',
    'blocked': '🚫',
  };

  const emoji = statusEmoji[newStatus] || '📋';
  let message = `${emoji} **${task.title}**\n`;
  message += `↳ ${assignee} moved to **${newStatus}**`;
  if (projectName !== 'Unknown') message += ` · ${projectName}`;
  if (reviewNotes) message += `\n\n💬 ${reviewNotes}`;

  // Send directly via Telegram Bot API

  // Always emit to activity feed
  const feedApi = (globalThis as any).__orgStudioActivityFeed;
  if (feedApi?.add) {
    feedApi.add({
      type: 'task-status',
      emoji: statusEmoji[newStatus] || '📋',
      agent: assignee,
      project: projectName,
      taskId: task.id,
      message: `${assignee} moved "${task.title}" to ${newStatus}`,
      detail: reviewNotes || undefined,
    });
  }

  // Telegram only for high-signal events
  if (!TELEGRAM_STATUSES.includes(newStatus)) return;

  fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'Markdown',
    }),
  }).catch(() => {}); // best-effort
}

// GET — return all projects and tasks
// Debounced stuck-task check — piggybacks on store reads (dashboard polls every 8s)
const STUCK_CHECK_INTERVAL_MS = 5 * 60 * 1000; // At most once per 5 minutes
const STUCK_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes idle in in-progress
let lastStuckCheck = 0;

function piggybackStuckCheck(store: any) {
  const now = Date.now();
  if (now - lastStuckCheck < STUCK_CHECK_INTERVAL_MS) return;
  lastStuckCheck = now;

  const teammates = store.settings?.teammates || [];
  const triggeredAgents = new Set<string>();

  // 1. Stuck in-progress tasks (existing check)
  for (const task of store.tasks) {
    if (task.isArchived || task.loopPausedAt) continue;
    if (task.status !== 'in-progress') continue;

    const lastActivity = task.lastActivityAt
      || (task.statusHistory?.length ? task.statusHistory[task.statusHistory.length - 1]?.timestamp : null)
      || task.createdAt || 0;

    if (now - lastActivity < STUCK_THRESHOLD_MS) continue;

    const assignee = task.assignee;
    if (!assignee) continue;

    const match = teammates.find((t: any) =>
      t.name?.toLowerCase() === assignee.toLowerCase() || t.agentId === assignee.toLowerCase()
    );
    const agentId = match?.agentId;
    if (agentId && !triggeredAgents.has(agentId)) {
      triggeredAgents.add(agentId);
      triggerAgentLoop(assignee, store);
    }
  }

  // 2. Idle agents with backlog work but nothing in-progress
  // Safety net: if the done→next-backlog chain failed, this catches it
  const IDLE_BACKLOG_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes with idle backlog
  const agentBacklog: Record<string, { assignee: string; oldestCreated: number }> = {};
  const agentHasActive = new Set<string>();

  for (const task of store.tasks) {
    if (task.isArchived || task.loopPausedAt) continue;
    const assignee = task.assignee?.toLowerCase();
    if (!assignee) continue;

    if (['in-progress', 'review'].includes(task.status)) {
      agentHasActive.add(assignee);
    } else if (task.status === 'backlog') {
      const created = task.createdAt || 0;
      if (!agentBacklog[assignee] || created < agentBacklog[assignee].oldestCreated) {
        agentBacklog[assignee] = { assignee: task.assignee, oldestCreated: created };
      }
    }
  }

  for (const [assigneeLower, info] of Object.entries(agentBacklog)) {
    if (agentHasActive.has(assigneeLower)) continue; // Already working on something
    if (triggeredAgents.has(assigneeLower)) continue; // Already triggered above
    if (now - info.oldestCreated < IDLE_BACKLOG_THRESHOLD_MS) continue; // Too recent

    const match = teammates.find((t: any) =>
      t.name?.toLowerCase() === assigneeLower || t.agentId === assigneeLower
    );
    const agentId = match?.agentId;
    if (agentId && !triggeredAgents.has(agentId)) {
      triggeredAgents.add(agentId);
      console.log(`[Sweep] Idle agent ${info.assignee} has backlog work — triggering`);
      triggerAgentLoop(info.assignee, store);
    }
  }
}

/**
 * Helper: resolve workspace from request, returning DEFAULT_WORKSPACE_ID
 * for unauthenticated / internal callers (backward-compat).
 *
 * Uses authenticateRequestWithContext to get userId from both session cookies
 * AND Bearer API keys (resolves ORG_STUDIO_API_KEY → basil).
 */
async function resolveRequestWorkspace(req: NextRequest): Promise<WorkspaceContext | NextResponse> {
  try {
    // Get auth context (includes userId for both session and Bearer)
    const authResult = await authenticateRequestWithContext(req);
    const userId = authResult.context?.userId;
    const wsResult = await resolveWorkspaceContext(req, userId);
    if (wsResult.error) return wsResult.error;
    if (wsResult.context) return wsResult.context;
  } catch {}
  return { id: DEFAULT_WORKSPACE_ID, name: 'Default Workspace' };
}

export async function GET(req: NextRequest) {
  try {
    const data = await readStore();
    piggybackStuckCheck(data);

    // Workspace filtering — transparent: single-workspace users see everything
    const wsOrError = await resolveRequestWorkspace(req);
    if (wsOrError instanceof NextResponse) return wsOrError;
    const workspace = wsOrError;
    const filteredData = {
      ...data,
      projects: filterByWorkspace(data.projects, workspace.id),
      tasks: filterByWorkspace(data.tasks, workspace.id),
    };

    return NextResponse.json(filteredData);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST — handle mutations
export async function POST(req: NextRequest) {
  const authError = await authenticateRequest(req);
  if (authError) return authError;

  // Resolve userId for this request (used to rewrite placeholder comment authors)
  let requestUserId: string | undefined;
  try {
    const authCtx = await authenticateRequestWithContext(req);
    requestUserId = authCtx.context?.userId;
  } catch { /* best-effort */ }

  // Resolve workspace context for this request
  const wsOrError = await resolveRequestWorkspace(req);
  if (wsOrError instanceof NextResponse) return wsOrError;
  const workspace = wsOrError;

  try {
    const body = await req.json();
    const { action, ...payload } = body;
    const store = await readStore();

    switch (action) {
      case 'addTask': {
        // 410 compat: reject tasks targeting archived qa-fold projects
        const addTaskProjectId = payload.task?.projectId;
        if (addTaskProjectId) {
          const archCheck = checkArchivedProject(store.projects, addTaskProjectId);
          if (archCheck.migrated) {
            return NextResponse.json(
              { error: 'Project moved', migratedTo: archCheck.migratedTo },
              { status: 410 }
            );
          }
        }

        // --- #698 Task-creation guardrails ---
        const taskVersion = (payload.task?.version || '').trim();

        {
          if (taskVersion) {
            // Roadmap task flow: version set → require roadmapItemId + validate
            const roadmapItemId = payload.task?.roadmapItemId;
            if (!roadmapItemId) {
              return NextResponse.json(
                { error: 'Tasks with a version must include roadmapItemId. Use the roadmap flow to create versioned tasks.' },
                { status: 400 }
              );
            }

            // Look up the roadmap version for this project+version
            const roadmapProjectId = payload.task?.projectId;
            let roadmapVersionRow: any = null;
            let roadmapItems: any[] = [];
            if (process.env.DATABASE_URL) {
              try {
                const { Pool } = await import('pg');
                const pool = new Pool({ connectionString: process.env.DATABASE_URL });
                const result = await pool.query(
                  `SELECT id, items FROM org_studio_roadmap_versions WHERE project_id = $1 AND version = $2 AND workspace_id = $3 LIMIT 1`,
                  [roadmapProjectId, taskVersion, workspace.id]
                );
                await pool.end();
                if (result.rows.length > 0) {
                  roadmapVersionRow = result.rows[0];
                  roadmapItems = roadmapVersionRow.items || [];
                }
              } catch (e: any) {
                console.error('[addTask guardrail] Postgres lookup failed:', e?.message);
              }
            } else {
              // File-based fallback
              try {
                const fs = require('fs');
                const path = require('path');
                const roadmapPath = path.join(process.cwd(), 'data', 'roadmaps', `${roadmapProjectId}.json`);
                if (fs.existsSync(roadmapPath)) {
                  const data = JSON.parse(fs.readFileSync(roadmapPath, 'utf-8'));
                  const ver = (data.versions || []).find((v: any) => v.version === taskVersion);
                  if (ver) {
                    roadmapVersionRow = ver;
                    roadmapItems = ver.items || [];
                  }
                }
              } catch (e: any) {
                console.error('[addTask guardrail] File lookup failed:', e?.message);
              }
            }

            if (!roadmapVersionRow) {
              return NextResponse.json(
                { error: `Roadmap version ${taskVersion} not found for project ${roadmapProjectId}.` },
                { status: 400 }
              );
            }

            // Find the item by id
            const matchedItem = roadmapItems.find((item: any) => item.id === roadmapItemId);
            if (!matchedItem) {
              return NextResponse.json(
                { error: `Roadmap item '${roadmapItemId}' not found in version ${taskVersion}.` },
                { status: 400 }
              );
            }

            if (matchedItem.taskId) {
              return NextResponse.json(
                { error: 'Roadmap item already has a linked task. Each item can only be linked to one task.' },
                { status: 400 }
              );
            }

            if (!payload.task.taskType) payload.task.taskType = 'feature';
          } else {
            // Adhoc task flow: no version
            const allowedAdhocTypes = ['bug', 'chore', 'followup', 'spike'];
            const taskType = payload.task?.taskType;
            if (!taskType || !allowedAdhocTypes.includes(taskType)) {
              return NextResponse.json(
                { error: `Adhoc tasks require taskType to be one of: ${allowedAdhocTypes.join(', ')}. Got: '${taskType || '(empty)'}'. For roadmap tasks, use the roadmap flow with a version and roadmapItemId.` },
                { status: 400 }
              );
            }

            // Title regex check: reject titles that look like roadmap version prefixes
            const title = (payload.task?.title || '').trim();
            if (/^v\d+\.\d+:/i.test(title)) {
              return NextResponse.json(
                { error: 'Task title looks like a roadmap version prefix; use the roadmap flow or remove the version prefix.' },
                { status: 400 }
              );
            }
          }
        }
        // --- End #698 guardrails ---

        const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        const now = Date.now();
        let initialStatus = payload.task?.status || 'backlog';

        // Auto-promote: if task is for the project's current version, go straight
        // to backlog instead of planning. Planning is for future versions only.
        if (initialStatus === 'planning' && payload.task?.version && payload.task?.projectId) {
          const proj = (store.projects || []).find((p: any) => p.id === payload.task.projectId);
          if (proj?.currentVersion && payload.task.version === proj.currentVersion) {
            initialStatus = 'backlog';
            console.info(`[addTask] Auto-promoted to backlog: version ${payload.task.version} is currentVersion for ${proj.name || proj.id}`);
          }
        }

        // #862: reject 'qa' as a status — QA is a component, not a column.
        const VALID_STATUSES = ['planning', 'backlog', 'in-progress', 'review', 'done', 'blocked'];
        if (!VALID_STATUSES.includes(initialStatus)) {
          return NextResponse.json(
            { error: `Invalid status '${initialStatus}'. Allowed: ${VALID_STATUSES.join(', ')}. (QA is a component, not a column — see #862.)` },
            { status: 400 }
          );
        }
        // #1138 follow-up: blocked status requires a non-empty blockedReason.
        // Without one, blocked tasks accumulate as silent dead weight — 16 of
        // them in the active store as of 2026-04-26 with no context for why.
        if (initialStatus === 'blocked') {
          const reason = (payload.task?.blockedReason || '').trim();
          if (!reason) {
            return NextResponse.json(
              { error: "Tasks created with status='blocked' must include a non-empty blockedReason. Describe what's blocking it and what would unblock." },
              { status: 400 }
            );
          }
        }
        // #863: atomic allocation via provider (Postgres sequence / file-mode mutex).
        let ticketNumber: number;
        try {
          ticketNumber = await getStoreProvider().allocateTicketNumber();
        } catch (e: any) {
          console.error('[TicketNumber] allocateTicketNumber failed, using fallback:', e?.message);
          ticketNumber = getNextTicketNumberFallback(store);
        }

        // #1126 PR 4: assignee defaulting from version.owner / section.owner.
        //
        // Precedence: task.assignee (explicit) > version.owner > section.owner.
        // If the caller already supplied an assignee, we leave it alone. If
        // they didn't, and the task targets a (sectionId, version) pair where
        // the version carries an owner override OR the section has a default
        // owner, we snapshot that owner onto the task explicitly. We do NOT
        // re-derive on read — once a task is created the assignee is
        // pinned, so editing version.owner later doesn't silently reassign
        // live tasks.
        const explicitAssignee = (payload.task?.assignee || '').trim();
        if (!explicitAssignee && payload.task?.projectId && payload.task?.sectionId) {
          try {
            const proj = (store.projects || []).find((p: any) => p.id === payload.task.projectId);
            if (proj) {
              const { getEffectiveOwner, getEffectiveComponents } = await import('@/lib/component-helpers');
              // Find the versionId for this task's (sectionId, version) pair.
              // version.id is the canonical lookup key for getEffectiveOwner;
              // the task itself stores the version string, not the version id.
              const cmp = getEffectiveComponents(proj).find((c: any) => c.id === payload.task.sectionId);
              const versionRow = cmp?.versions?.find((v: any) => v.version === payload.task.version);
              const owner = getEffectiveOwner(proj, payload.task.sectionId, versionRow?.id);
              if (owner) {
                payload.task.assignee = owner;
                console.log(`[addTask] Defaulted assignee=${owner} for ${payload.task.sectionId}/v${payload.task.version} (snapshot-on-create per #1126).`);
              }
            }
          } catch (e: any) {
            console.error('[addTask #1126] Effective-owner lookup failed (non-fatal):', e?.message);
          }
        }

        const task = {
          id,
          ticketNumber,
          createdAt: now,
          ...payload.task,
          workspace_id: payload.task?.workspace_id || workspace.id,
          statusHistory: [{ status: initialStatus, timestamp: now }],
          initiatedBy: payload.task?.initiatedBy || 'unknown',
        };
        // PERF: Use targeted provider.createTask() instead of full store write
        await getStoreProvider().createTask(task);

        // Write back taskId to roadmap item if this is a roadmap task
        if (task.roadmapItemId && task.version && task.projectId) {
          (async () => {
            try {
              if (process.env.DATABASE_URL) {
                const { Pool } = await import('pg');
                const pool = new Pool({ connectionString: process.env.DATABASE_URL });
                const result = await pool.query(
                  `SELECT id, items FROM org_studio_roadmap_versions WHERE project_id = $1 AND version = $2 AND workspace_id = $3 LIMIT 1`,
                  [task.projectId, task.version, workspace.id]
                );
                if (result.rows.length > 0) {
                  const items = result.rows[0].items || [];
                  const item = items.find((i: any) => i.id === task.roadmapItemId);
                  if (item) {
                    item.taskId = task.id;
                    await pool.query(
                      `UPDATE org_studio_roadmap_versions SET items = $1 WHERE id = $2`,
                      [JSON.stringify(items), result.rows[0].id]
                    );
                    console.log(`[addTask] Linked roadmap item ${task.roadmapItemId} → task ${task.id}`);
                  }
                }
                await pool.end();
              } else {
                // File-based fallback
                const fs = require('fs');
                const path = require('path');
                const roadmapPath = path.join(process.cwd(), 'data', 'roadmaps', `${task.projectId}.json`);
                if (fs.existsSync(roadmapPath)) {
                  const data = JSON.parse(fs.readFileSync(roadmapPath, 'utf-8'));
                  const ver = (data.versions || []).find((v: any) => v.version === task.version);
                  if (ver) {
                    const item = (ver.items || []).find((i: any) => i.id === task.roadmapItemId);
                    if (item) {
                      item.taskId = task.id;
                      fs.writeFileSync(roadmapPath, JSON.stringify(data, null, 2));
                      console.log(`[addTask] Linked roadmap item ${task.roadmapItemId} → task ${task.id}`);
                    }
                  }
                }
              }
            } catch (e: any) {
              console.error('[addTask] Failed to write back taskId to roadmap item:', e?.message);
            }
          })();
        }

        // Event-driven: if task lands in backlog, trigger the assignee's loop
        if (initialStatus === 'backlog' && task.assignee) {
          triggerAgentLoop(task.assignee, store);
        }

        // #862: removed QA-column event trigger — QA tickets trigger via the standard backlog/assignee path.

        return NextResponse.json({ ok: true, task });
      }

      case 'updateTask': {
        let triggeredAssignee: string | null = null;
        let versionCompletionTriggered: { projectId: string; project: any; version?: string } | null = null;
        let taskMatched = false; // #948: detect silent no-ops when the task isn't in the store snapshot.

        for (let i = 0; i < store.tasks.length; i++) {
          const t = store.tasks[i];
          if (t.id !== payload.id) continue;
          taskMatched = true;

          // Workspace guard: reject cross-workspace mutations
          if (!belongsToWorkspace(t, workspace.id)) {
            return NextResponse.json({ error: 'Forbidden — task belongs to another workspace' }, { status: 403 });
          }

          const updates = { ...payload.updates };

          // #862: reject status 'qa' — QA is a component, not a column.
          if (updates.status !== undefined) {
            const VALID_STATUSES = ['planning', 'backlog', 'in-progress', 'review', 'done', 'blocked'];
            if (!VALID_STATUSES.includes(updates.status)) {
              return NextResponse.json(
                { error: `Invalid status '${updates.status}'. Allowed: ${VALID_STATUSES.join(', ')}. (QA is a component, not a column — see #862.)` },
                { status: 400 }
              );
            }
          }

          // #1138 follow-up: transitioning TO blocked requires a non-empty
          // blockedReason — either set in this update or already present on
          // the task. Lets agents flip status without clobbering an existing
          // reason, but blocks the silent-dead-weight failure mode.
          if (updates.status === 'blocked' && t.status !== 'blocked') {
            const incomingReason = typeof updates.blockedReason === 'string' ? updates.blockedReason.trim() : '';
            const existingReason = typeof t.blockedReason === 'string' ? t.blockedReason.trim() : '';
            if (!incomingReason && !existingReason) {
              return NextResponse.json(
                { error: "Moving a task to status='blocked' requires a non-empty blockedReason. Describe what's blocking it and what would unblock." },
                { status: 400 }
              );
            }
          }

          // Guard: only the assignee can move a task to done
          if (updates.status === 'done' && payload.by) {
            const moverLower = (payload.by || '').toLowerCase();
            const assigneeLower = (t.assignee || '').toLowerCase();
            if (moverLower && assigneeLower && moverLower !== assigneeLower) {
              return NextResponse.json(
                { error: `Only the assignee (${t.assignee}) can move this task to done. Current mover: ${payload.by}` },
                { status: 403 }
              );
            }
          }

          // Soft warning: needsReview flagged but going straight to done
          if (updates.status === 'done' && t.needsReview) {
            console.warn(`[TaskGuard] Task ${t.id} (#${t.ticketNumber || '?'}) has needsReview=true but moved to done directly. reviewReason: ${t.reviewReason || '(none)'}`);
          }

          if (updates.status && updates.status !== t.status) {
            const history = t.statusHistory || [];
            const model = await resolveAgentModel(t.assignee, store);
            history.push({ status: updates.status, timestamp: Date.now(), by: t.assignee, model });
            updates.statusHistory = history;
            updates.lastActivityAt = Date.now();  // Update last activity on status change

            // Reset loop detection counters on status change
            (updates as any).loopCount = 0;
            (updates as any).loopPausedAt = null;
            (updates as any).loopPauseReason = null;

            // #862: QA is a component, not a column. Moving to 'qa' is no longer supported.
            // The status validation above already rejected it; this branch is removed.

            // Notify on status changes FROM in-progress (tracked work transitions)
            // OR notify on transitions TO in-progress/review/done/blocked (significant state changes)
            const shouldNotify = (t.status === 'in-progress') || 
                                  ['in-progress', 'review', 'done', 'blocked'].includes(updates.status);
            if (shouldNotify) {
              const merged = { ...t, ...updates };
              notifyTaskStatusChange(merged, updates.status, store);
            }

            // **NEW: Check for version completion when task moves to done**
            if (updates.status === 'done' && t.projectId && t.version) {
              const project = store.projects.find((p: any) => p.id === t.projectId);
              if (project) {
                // Check if ALL tasks for this version are now done
                const versionTasks = store.tasks.filter((task: any) => 
                  task.projectId === t.projectId && task.version === t.version && !task.isArchived
                );
                const allDone = versionTasks.every((task: any) => 
                  task.id === t.id ? true : task.status === 'done'
                );
                if (allDone && versionTasks.length > 0) {
                  versionCompletionTriggered = { projectId: t.projectId, project, version: t.version };
                }
              }
            }
          }
          const updated = { ...t, ...updates };
          if ((updated.status === 'backlog') &&
              (updates.status === 'backlog' || updates.assignee) &&
              updated.assignee) {
            triggeredAssignee = updated.assignee;
          }

          // #862: QA-bounce trigger removed (no more qa column). Reassignment on in-progress still triggers below.

          // Trigger new assignee when an in-progress task is reassigned
          if (updated.status === 'in-progress' && updates.assignee &&
              updates.assignee !== t.assignee && updated.assignee) {
            triggeredAssignee = updated.assignee;
          }

          // #862: QA-column trigger removed — QA tickets follow standard backlog→in-progress assignee triggers.

          store.tasks[i] = updated;
          // Piggyback stuck-task detection: check if this updated task is now stuck
          checkAndTriggerStuckTask(updated, store);
          
          // PERF: Use targeted provider.updateTask() instead of full store write.
          // #948: wrap in try/catch so silent provider failures surface as 500 instead
          // of returning a misleading ok:true. Silent failures were breaking the
          // autonomous delivery chain (agents left stuck in in-progress).
          try {
            await getStoreProvider().updateTask(payload.id, updates);
          } catch (providerErr: any) {
            console.error(`[updateTask] provider write failed for ${payload.id}:`, providerErr?.message);
            throw providerErr;
          }

          // Sync roadmap item done flag when task status changes
          if (updates.status && updated.projectId) {
            const isDone = updates.status === 'done';
            // Fire async — never block the response
            syncRoadmapItemForTask(updated.projectId, payload.id, isDone).catch(() => {});
          }

        }

        // #948: if the for-loop never matched, the task isn't in the store snapshot.
        // This happens when addTask's Postgres commit isn't yet visible to a subsequent
        // readStore() call on a different connection. Re-read directly from Postgres via the
        // provider's targeted read, and if found, apply the update directly (without the full
        // side-effect pipeline — the caller can retry after consistency converges if they need
        // notifications). This turns the silent no-op into either success or a clear error.
        if (!taskMatched) {
          try {
            const provider = getStoreProvider();
            // Read-your-writes fallback: fetch fresh state and retry the mutate.
            const fresh = await provider.read();
            const freshTask = fresh.tasks.find((t: any) => t.id === payload.id);
            if (!freshTask) {
              console.warn(`[updateTask] task ${payload.id} not found in cache or fresh read`);
              return NextResponse.json(
                { error: `Task not found: ${payload.id}` },
                { status: 404 }
              );
            }
            if (!belongsToWorkspace(freshTask, workspace.id)) {
              return NextResponse.json(
                { error: 'Forbidden — task belongs to another workspace' },
                { status: 403 }
              );
            }
            const fallbackUpdates = { ...payload.updates } as any;
            // Apply the same status-transition bookkeeping the main branch applies.
            if (fallbackUpdates.status && freshTask.status !== fallbackUpdates.status) {
              const now = Date.now();
              const history = Array.isArray(freshTask.statusHistory) ? [...freshTask.statusHistory] : [];
              history.push({ status: fallbackUpdates.status, timestamp: now, by: payload.by, model: payload.model });
              fallbackUpdates.statusHistory = history;
              fallbackUpdates.lastActivityAt = now;
              fallbackUpdates.loopCount = 0;
              fallbackUpdates.loopPausedAt = null;
              fallbackUpdates.loopPauseReason = null;
            }
            await provider.updateTask(payload.id, fallbackUpdates);
            console.log(`[updateTask] #948 fallback path matched task ${payload.id} via fresh read`);
            return NextResponse.json({ ok: true, viaFallback: true });
          } catch (e: any) {
            console.error(`[updateTask] fallback read failed:`, e?.message);
            return NextResponse.json(
              { error: `updateTask no-op: task ${payload.id} not in cache and fallback read failed` },
              { status: 500 }
            );
          }
        }
        if (triggeredAssignee) {
          triggerAgentLoop(triggeredAssignee, store);
        }

        // Chain to next backlog task when agent completes work
        if (payload.updates?.status && ['done', 'review'].includes(payload.updates.status)) {
          const completed = store.tasks.find(t => t.id === payload.id);
          if (completed?.assignee) {
            // Clear the in-flight lock — task completion is the definitive signal
            // that the agent's dispatch session finished (OpenClaw doesn't have onComplete callbacks)
            const assigneeLower = completed.assignee.toLowerCase();
            const teammates = store.settings?.teammates || [];
            const match = teammates.find((t: any) =>
              t.name?.toLowerCase() === assigneeLower || t.agentId === assigneeLower
            );
            if (match?.agentId) {
              try {
                const { clearInFlightAgent } = await import('@/lib/runtimes/scheduler-bridge');
                clearInFlightAgent(match.agentId);
              } catch {}
            }

            const hasMoreBacklog = store.tasks.some(t =>
              !t.isArchived &&
              t.status === 'backlog' &&
              t.assignee?.toLowerCase() === assigneeLower
            );
            if (hasMoreBacklog) {
              triggerAgentLoop(completed.assignee, store);
            }
          }
        }

        // #1102: Auto-unblock fan-out on blocker completion.
        //
        // When a task transitions to `done`, scan for any non-archived blocked
        // tasks that declared it in their `blockedBy` array. For each such
        // downstream task: if ALL of its `blockedBy` tickets are now done,
        // flip it back to `backlog` and trigger the assignee's loop. Also
        // move `blockedBy` → `previouslyBlockedBy` for the audit trail.
        //
        // Contract:
        //  - Structural edges only: reads from `task.blockedBy: number[]`.
        //    Free-text "blocked by #N" comments are NOT parsed here.
        //  - Unspecified blocks (blockedBy empty/null) stay manual-unblock-only.
        //    Preserves today's behaviour for tasks that were blocked without
        //    declaring a structured edge.
        if (payload.updates?.status === 'done') {
          const completedTask = store.tasks.find(t => t.id === payload.id);
          const completedTicket = completedTask?.ticketNumber;
          if (completedTicket) {
            const unblocked: { task: any; clearedBy: number[] }[] = [];
            for (const t of store.tasks) {
              if (t.isArchived) continue;
              if (t.status !== 'blocked') continue;
              const bb = Array.isArray((t as any).blockedBy) ? (t as any).blockedBy as number[] : [];
              if (bb.length === 0) continue;
              if (!bb.includes(completedTicket)) continue;

              // Check: are ALL blockers now done?
              const allResolved = bb.every(tn => {
                if (tn === completedTicket) return true; // this one is the just-completed task
                const blocker = store.tasks.find(x => x.ticketNumber === tn);
                return blocker?.status === 'done';
              });
              if (!allResolved) continue;

              unblocked.push({ task: t, clearedBy: bb });
            }

            for (const { task: t, clearedBy } of unblocked) {
              const updates: any = {
                status: 'backlog',
                blockedBy: [],
                previouslyBlockedBy: [
                  ...((t as any).previouslyBlockedBy || []),
                  ...clearedBy,
                ],
                loopCount: 0,
                loopPausedAt: null,
                loopPauseReason: null,
              };

              try {
                await getStoreProvider().updateTask(t.id, updates);
                console.log(
                  `[Auto-unblock] #${t.ticketNumber} → backlog (all blockers [${clearedBy.join(',')}] done)`
                );
              } catch (e: any) {
                console.error(`[Auto-unblock] failed for #${t.ticketNumber}:`, e?.message);
                continue;
              }

              // Post system comment on the unblocked task
              try {
                const blockerList = clearedBy.map(n => `#${n}`).join(', ');
                await getStoreProvider().addComment(t.id, {
                  id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
                  createdAt: Date.now(),
                  author: 'System',
                  content: `🔓 **Auto-unblocked** — all declared blockers resolved (${blockerList}). Returned to backlog.`,
                  type: 'system',
                } as any);
              } catch {}

              // Refresh the task in the local snapshot so downstream logic sees
              // it as backlog (e.g. triggerAgentLoop reads store.tasks).
              Object.assign(t, updates);

              // Trigger the assignee's loop
              if (t.assignee) {
                triggerAgentLoop(t.assignee, store);
              }
            }
          }
        }

        // #1112 PR 2/6: Component-version completion announcement.
        //
        // When this task transition to `done` just completed its component's
        // version, scan all OTHER components (any project) whose own versions
        // declare a matching `waitsFor` dep. On each dependent component that
        // now becomes dispatch-eligible, post ONE System comment on ONE of
        // its now-eligible backlog tasks (to avoid per-task spam). Also
        // trigger that component's owner so the dispatcher picks up the
        // newly-eligible work immediately.
        //
        // Strictly observability + scheduler nudge. The actual gating lives
        // in `isTaskGatedByWaitsFor` (dispatch-gate.ts); this block does NOT
        // mutate task statuses.
        if (payload.updates?.status === 'done') {
          const completed = store.tasks.find(t => t.id === payload.id);
          const completedSectionId = (completed as any)?.sectionId;
          const completedVersion = completed?.version;
          if (completedSectionId && completedVersion && completed?.projectId) {
            // Did THIS done transition complete the component's version?
            const stillOpen = store.tasks.some(t =>
              !t.isArchived &&
              t.id !== completed.id &&
              t.projectId === completed.projectId &&
              (t as any).sectionId === completedSectionId &&
              t.version === completedVersion &&
              t.status !== 'done'
            );
            if (!stillOpen) {
              // Component-version complete. Scan for dependents via per-version waitsFor.
              const completedProjectId = completed.projectId;
              const announcedComponents = new Set<string>();
              for (const proj of store.projects || []) {
                const comps: any[] = (proj as any).components?.length
                  ? (proj as any).components
                  : (proj.sections || []);
                for (const cmp of comps) {
                  if (!Array.isArray(cmp.versions) || cmp.versions.length === 0) continue;
                  // Check each version on this component for a waitsFor that
                  // just got satisfied by our completion.
                  const matchingVersion = cmp.versions.find((v: any) => {
                    const w = v?.waitsFor;
                    if (!w || !w.componentId || !w.version) return false;
                    return w.componentId === completedSectionId &&
                      w.version === completedVersion &&
                      (w.projectId ? w.projectId === completedProjectId : proj.id === completedProjectId);
                  });
                  if (!matchingVersion) continue;

                  // Find one surviving backlog task on this component-version to anchor the announcement.
                  const anchor = store.tasks.find(t =>
                    !t.isArchived &&
                    t.projectId === proj.id &&
                    (t as any).sectionId === cmp.id &&
                    t.version === matchingVersion.version &&
                    t.status === 'backlog'
                  );

                  const key = `${proj.id}::${cmp.id}::${matchingVersion.version}`;
                  if (announcedComponents.has(key)) continue;
                  announcedComponents.add(key);

                  const completedCmp = (store.projects.find(p => p.id === completedProjectId) as any);
                  const completedCmpList: any[] = completedCmp?.components?.length
                    ? completedCmp.components
                    : (completedCmp?.sections || []);
                  const completedCmpName = completedCmpList.find((c: any) => c.id === completedSectionId)?.name || completedSectionId;

                  if (anchor) {
                    try {
                      await getStoreProvider().addComment(anchor.id, {
                        id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
                        createdAt: Date.now(),
                        author: 'System',
                        content: `🔓 **Component unblocked** — *${completedCmpName}* @ \`${completedVersion}\` shipped. *${cmp.name}* @ \`${matchingVersion.version}\` is now dispatch-eligible; this task and siblings can be picked up.`,
                        type: 'system',
                      } as any);
                    } catch (e: any) {
                      console.error(`[Component-unblock] failed to post announcement on #${anchor.ticketNumber}:`, e?.message);
                    }
                  }

                  console.log(
                    `[Component-unblock] ${completedCmpName}@${completedVersion} shipped → ${cmp.name}@${matchingVersion.version} (${proj.name}) dispatch-eligible`
                  );

                  // Trigger the dependent component's owner so the now-eligible
                  // backlog task surfaces on the next tick.
                  if (cmp.owner) triggerAgentLoop(cmp.owner, store);
                }
              }
            }
          }
        }

        // **NEW: Handle version completion asynchronously**
        if (versionCompletionTriggered) {
          (async () => {
            try {
              const completedVersion = (versionCompletionTriggered as any).version;

              if (completedVersion) {
                console.log(
                  `[Version Dispatch] All tasks for ${completedVersion} in project ${versionCompletionTriggered.projectId} are done`
                );

                // #1112 PR 6: Post-migration, versions live on components.
                // Find the version record on the component matching the
                // triggering task and mark it shipped. Do NOT bump any
                // approvedThrough banner automatically — humans explicitly
                // move the approval horizon.
                const triggerTask = store.tasks.find((tt: any) => tt.id === payload.id);
                const compId: string | undefined = (triggerTask as any)?.sectionId;
                const proj: any = versionCompletionTriggered.project;
                const compsRef: any[] = proj.components?.length ? proj.components : (proj.sections || []);
                const ownerCmp = compsRef.find((c) => c.id === compId);
                const updates: any = { currentVersion: completedVersion };
                if (ownerCmp && Array.isArray(ownerCmp.versions)) {
                  const completedVersionRecord = ownerCmp.versions.find(
                    (v: any) => v.version === completedVersion || v.label === completedVersion,
                  );
                  if (completedVersionRecord) {
                    completedVersionRecord.status = 'shipped';
                    completedVersionRecord.approvedAt = new Date().toISOString();
                    // Persist the whole components/sections array so the
                    // updated version record round-trips to the store.
                    if (proj.components?.length) {
                      updates.components = proj.components;
                    } else if (proj.sections?.length) {
                      updates.sections = proj.sections;
                    }
                  }
                }

                // Persist all updates
                await getStoreProvider().updateProject(versionCompletionTriggered.projectId, updates);
              }
            } catch (e) {
              console.error('[Version Dispatch] Completion error:', e);
            }
          })();
        }

        return NextResponse.json({ ok: true });
      }

      case 'deleteTask': {
        // Workspace guard
        const delTask = store.tasks.find((t: any) => t.id === payload.id);
        if (delTask && !belongsToWorkspace(delTask, workspace.id)) {
          return NextResponse.json({ error: 'Forbidden — task belongs to another workspace' }, { status: 403 });
        }
        // Changed to archive instead of delete
        // PERF: Use targeted provider.updateTask() instead of full store write
        await getStoreProvider().updateTask(payload.id, {
          isArchived: true,
          archivedAt: Date.now(),
          archivedBy: payload.by || 'unknown',
        });
        return NextResponse.json({ ok: true });
      }

      case 'unarchiveTask': {
        // PERF: Use targeted provider.updateTask() instead of full store write
        await getStoreProvider().updateTask(payload.id, {
          isArchived: false,
          archivedAt: undefined,
          archivedBy: undefined,
        });
        return NextResponse.json({ ok: true });
      }

      case 'permanentlyDeleteTask': {
        // PERF: Use targeted provider.deleteTask() instead of full store write
        await getStoreProvider().deleteTask(payload.id);
        return NextResponse.json({ ok: true });
      }

      case 'addProject': {
        const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        const project = { id, createdAt: Date.now(), ...payload.project, workspace_id: payload.project?.workspace_id || workspace.id };

        // #1112 PR 1: Stop writing `devOwner` / `qaOwner` on new projects. These
        // fields hardcode a 2-role worldview that the Components model replaces.
        // Existing projects keep their values (nothing strips them). New projects
        // get them silently dropped — the Components panel replaces the story.
        if ('devOwner' in project) delete (project as any).devOwner;
        if ('qaOwner' in project) delete (project as any).qaOwner;

        // #1112 PR 6: Stop scaffolding legacy project-level roadmap/horizon on
        // new projects. Roadmaps live on components now — new projects start
        // with no components by default; the user adds a Main component and
        // that's where versions[] / approvedThrough get set. The project-level
        // `autonomy` bag is kept for cadence/approvalMode but no longer carries
        // `approvedThrough`.
        if ('versions' in project) delete (project as any).versions;
        if (!project.autonomy) project.autonomy = {};
        if ('approvedThrough' in (project as any).autonomy) {
          delete (project as any).autonomy.approvedThrough;
        }

        // PERF: Use targeted provider.createProject() instead of full store write
        await getStoreProvider().createProject(project);
        return NextResponse.json({ ok: true, project });
      }

      case 'updateProject': {
        console.log('[API:store:updateProject]', { id: payload.id, updates: JSON.stringify(payload.updates).slice(0, 500) });
        
        // Check if devOwner is changing
        const oldProject = store.projects.find((p: any) => p.id === payload.id);

        // Workspace guard
        if (oldProject && !belongsToWorkspace(oldProject, workspace.id)) {
          return NextResponse.json({ error: 'Forbidden — project belongs to another workspace' }, { status: 403 });
        }

        const newDevOwner = payload.updates?.devOwner;
        const devOwnerChanged = newDevOwner && oldProject?.devOwner && newDevOwner !== oldProject.devOwner;

        // PERF: Use targeted provider.updateProject() instead of full store write
        await getStoreProvider().updateProject(payload.id, payload.updates);
        console.log('[API:store:updateProject] completed for', payload.id);

        // When approvedThrough changes, check if a shipped version can now advance.
        // This closes the gap where auto-advance stopped at the horizon ceiling,
        // and a later horizon bump had no re-trigger.
        const newApproved = payload.updates?.autonomy?.approvedThrough;
        const oldApproved = oldProject?.autonomy?.approvedThrough;
        if (newApproved && newApproved !== oldApproved) {
          console.log(`[ApprovedThrough] ${payload.id}: ${oldApproved || 'null'} → ${newApproved}`);
          // Fire-and-forget: attempt promote if there's a shipped current version
          (async () => {
            try {
              const { promoteProjectToNextVersion } = await import('@/lib/project-state');
              const pg = await import('pg');
              const Pool = (pg as any).default?.Pool || (pg as any).Pool;
              const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
              const client = await pool.connect();
              try {
                const result = await promoteProjectToNextVersion(payload.id, client);
                if (result.promoted) {
                  console.log(`[ApprovedThrough] Promoted ${payload.id}: ${result.from} → ${result.to} (${result.movedTasks} tasks → backlog)`);
                  // Trigger scheduler for devOwner
                  const freshStore = await getStoreProvider().read();
                  const proj = freshStore.projects.find((p: any) => p.id === payload.id);
                  if (proj?.devOwner && result.movedTasks > 0) {
                    triggerAgentLoop(proj.devOwner, freshStore);
                  }
                } else {
                  console.log(`[ApprovedThrough] ${payload.id}: promote skipped — ${result.reason}`);
                }
              } finally {
                client.release();
                await pool.end();
              }
            } catch (e: any) {
              console.error(`[ApprovedThrough] promote check failed for ${payload.id}:`, e?.message);
            }
          })();
        }

        // Log project state changes
        if (payload.updates?.state && payload.updates.state !== oldProject?.state) {
          console.log(`[ProjectState] ${payload.id}: ${oldProject?.state || 'undefined'} → ${payload.updates.state}`);
          // When restarting a stopped project, re-check promote in case horizon was bumped while stopped
          if (payload.updates.state === 'started' && oldProject?.state === 'stopped') {
            (async () => {
              try {
                const { promoteProjectToNextVersion } = await import('@/lib/project-state');
                const pg = await import('pg');
                const Pool = (pg as any).default?.Pool || (pg as any).Pool;
                const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
                const client = await pool.connect();
                try {
                  const result = await promoteProjectToNextVersion(payload.id, client);
                  if (result.promoted) {
                    console.log(`[ProjectState] Restart promote ${payload.id}: ${result.from} → ${result.to} (${result.movedTasks} tasks → backlog)`);
                    const freshStore = await getStoreProvider().read();
                    const proj = freshStore.projects.find((p: any) => p.id === payload.id);
                    if (proj?.devOwner && result.movedTasks > 0) {
                      triggerAgentLoop(proj.devOwner, freshStore);
                    }
                  }
                } finally {
                  client.release();
                  await pool.end();
                }
              } catch (e: any) {
                console.error(`[ProjectState] restart promote failed for ${payload.id}:`, e?.message);
              }
            })();
          }
        }

        // Note: Vision cron management has been replaced by the Launch model
        // No auto-create/update/delete cron logic needed here anymore

        // If devOwner changed, reassign active tasks (NOT done tasks) to new owner
        if (devOwnerChanged) {
          const projectTasks = store.tasks.filter((t: any) => 
            t.projectId === payload.id && 
            t.assignee?.toLowerCase() === oldProject.devOwner.toLowerCase()
          );
          for (const task of projectTasks) {
            // Skip done tasks — they stay credited to whoever completed them
            if (task.status === 'done') continue;
            await getStoreProvider().updateTask(task.id, { assignee: newDevOwner });
          }
          if (projectTasks.filter((t: any) => t.status !== 'done').length > 0) {
            console.log(`[DevOwner] Reassigned ${projectTasks.filter((t: any) => t.status !== 'done').length} active task(s) from ${oldProject.devOwner} to ${newDevOwner} (skipped ${projectTasks.filter((t: any) => t.status === 'done').length} done)`);
          }
        }

        return NextResponse.json({ ok: true });
      }

      case 'updateComponent': {
        /**
         * #1112 PR 6 follow-up: targeted update for a single component on a
         * project. Used by the per-component approval banner so writes go to
         * `components[i].approvedThrough` instead of the legacy project-wide
         * field.
         *
         * Side effect: when `approvedThrough` is the changing field, fires the
         * same promote/scheduler-trigger flow that legacy approvedThrough
         * changes used to — because extending a component's banner can unblock
         * waiting tasks on that component the same way bumping the project-wide
         * banner used to.
         *
         * Body: { projectId, componentId, updates: Partial<Component> }
         */
        const { projectId, componentId: targetComponentId, updates: compUpdates } = payload;
        if (!projectId || !targetComponentId || !compUpdates) {
          return NextResponse.json(
            { error: 'Missing projectId, componentId, or updates' },
            { status: 400 },
          );
        }
        const targetProject = store.projects.find((p: any) => p.id === projectId);
        if (!targetProject) {
          return NextResponse.json({ error: 'Project not found' }, { status: 404 });
        }
        if (!belongsToWorkspace(targetProject, workspace.id)) {
          return NextResponse.json(
            { error: 'Forbidden — project belongs to another workspace' },
            { status: 403 },
          );
        }

        // Components live in `components` going forward; older projects may
        // still have them under `sections`. Tolerate both, write back on the
        // same key the project already uses.
        const compsKey = Array.isArray((targetProject as any).components)
          ? 'components'
          : 'sections';
        const comps: any[] = Array.isArray((targetProject as any)[compsKey])
          ? [...(targetProject as any)[compsKey]]
          : [];
        const compIdx = comps.findIndex((c) => c?.id === targetComponentId);
        if (compIdx < 0) {
          return NextResponse.json({ error: 'Component not found on project' }, { status: 404 });
        }

        const oldComp = comps[compIdx];
        const oldApprovedThrough = oldComp?.approvedThrough ?? null;
        const newComp = { ...oldComp, ...compUpdates };
        // Normalize: explicit null clears the field rather than persisting null.
        if (compUpdates.approvedThrough === null) {
          delete newComp.approvedThrough;
        }
        comps[compIdx] = newComp;

        await getStoreProvider().updateProject(projectId, { [compsKey]: comps } as any);
        console.log(
          `[API:store:updateComponent] ${projectId}/${targetComponentId}`,
          JSON.stringify(compUpdates).slice(0, 200),
        );

        // Promote re-trigger when component approval banner moves.
        const newApprovedThrough = newComp.approvedThrough ?? null;
        if ('approvedThrough' in compUpdates && newApprovedThrough !== oldApprovedThrough) {
          console.log(
            `[ComponentApproval] ${projectId}/${targetComponentId}: ${oldApprovedThrough || 'null'} → ${newApprovedThrough || 'null'}`,
          );
          // Fire-and-forget promote against this project. promoteProjectToNextVersion
          // walks every component (post follow-up) and advances any whose horizon
          // has expanded enough to make a shipped/current version unstick.
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
                  console.log(
                    `[ComponentApproval] Promoted ${projectId}: ${result.from} → ${result.to} (${result.movedTasks} tasks → backlog)`,
                  );
                  const freshStore = await getStoreProvider().read();
                  const proj = freshStore.projects.find((p: any) => p.id === projectId);
                  // Trigger the component's owner if known, else any project devOwner.
                  const ownerToWake = newComp.owner || proj?.devOwner;
                  if (ownerToWake && result.movedTasks > 0) {
                    triggerAgentLoop(ownerToWake, freshStore);
                  }
                }
              } finally {
                client.release();
                await pool.end();
              }
            } catch (e: any) {
              console.error(
                `[ComponentApproval] promote check failed for ${projectId}:`,
                e?.message,
              );
            }
          })();
        }

        return NextResponse.json({ ok: true });
      }

      case 'deleteProject': {
        // Workspace guard
        const delProj = store.projects.find((p: any) => p.id === payload.id);
        if (delProj && !belongsToWorkspace(delProj, workspace.id)) {
          return NextResponse.json({ error: 'Forbidden — project belongs to another workspace' }, { status: 403 });
        }
        // PERF: Use targeted provider.deleteProject() instead of full store write
        await getStoreProvider().deleteProject(payload.id);
        return NextResponse.json({ ok: true });
      }

      case 'addComment': {
        // Support both legacy { taskId, comment } and new { scope, comment } shapes
        const commentScope = payload.scope
          ? payload.scope
          : payload.taskId
            ? { kind: 'task', taskId: payload.taskId }
            : null;
        if (!commentScope) return NextResponse.json({ error: 'Missing taskId or scope' }, { status: 400 });

        // For task-scoped comments, validate the task exists
        let task: any = null;
        if (commentScope.kind === 'task' && commentScope.taskId) {
          task = store.tasks.find((t: any) => t.id === commentScope.taskId);
          if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
          // Workspace guard
          if (!belongsToWorkspace(task, workspace.id)) {
            return NextResponse.json({ error: 'Forbidden — task belongs to another workspace' }, { status: 403 });
          }
        }

        const commentId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        const model = await resolveAgentModel(payload.comment?.author, store);

        // Resolve placeholder author 'You' to the actual teammate name for the
        // logged-in user. Otherwise mentions render as "💬 **You** mentioned you",
        // which agents interpret as a self-test instead of a real user message.
        // Multi-human-safe: always goes through session->teammate lookup, never
        // hardcodes a name.
        let resolvedAuthor = payload.comment?.author;
        if (resolvedAuthor === 'You' || !resolvedAuthor) {
          const teammates = store.settings?.teammates || [];
          let matchedName: string | undefined;
          if (requestUserId) {
            const match = teammates.find((t: any) =>
              t.id === requestUserId ||
              t.agentId === requestUserId ||
              t.name?.toLowerCase() === String(requestUserId).toLowerCase() ||
              t.email?.toLowerCase() === String(requestUserId).toLowerCase()
            );
            if (match?.name) matchedName = match.name;
          }
          // Last resort: keep whatever userId the session gave us (better than
          // 'You'). Only hits if the user is logged in but has no teammate
          // record — they get labeled with their raw userId instead of a generic.
          resolvedAuthor = matchedName || requestUserId || 'Unknown';
        }

        const comment = {
          id: commentId,
          createdAt: Date.now(),
          ...payload.comment,
          author: resolvedAuthor,
          model: payload.comment?.model || model, // explicit > resolved
        };
        // PERF: Use targeted provider.addComment() instead of full store write
        // But also update lastActivityAt on the task
        await getStoreProvider().addComment(commentScope, comment);
        if (task) {
          await getStoreProvider().updateTask(commentScope.taskId, { lastActivityAt: Date.now() });
        }

        // --- Unified notification routing (async, best-effort) ---
        const teammates = store.settings?.teammates || [];
        const mentions = parseMentions(comment.content, teammates);
        let mentionResult: any = null;
        if (mentions.length > 0) {
          mentionResult = { detected: mentions.map(m => m.teammate.name || m.teammate.agentId) };
        }

        // Build context for the unified router
        const routerProject = (() => {
          const pid = commentScope.kind === 'task'
            ? task?.projectId
            : commentScope.boardProjectId;
          if (!pid) return undefined;
          const p = store.projects.find((pr: any) => pr.id === pid);
          if (!p) return undefined;
          return {
            id: p.id,
            name: p.name,
            devOwner: p.devOwner,
            visionOwner: p.visionOwner,
            qaOwner: p.qaOwner,
            owner: p.owner,
            sections: p.sections,
          };
        })();

        const routerSection = (() => {
          if (commentScope.kind !== 'section' || !routerProject) return undefined;
          const sec = (routerProject.sections || []).find((s: any) => s.id === commentScope.sectionId);
          return sec ? { id: sec.id, name: sec.name, owner: sec.owner } : undefined;
        })();

        const projectTasks = routerProject
          ? store.tasks.filter((t: any) => t.projectId === routerProject.id)
          : [];

        // Single unified call replaces all per-scope branchy dispatch
        routeCommentNotifications({
          comment: { id: comment.id, author: comment.author, content: comment.content },
          scope: commentScope,
          teammates,
          context: {
            task: task ? { id: task.id, title: task.title, projectId: task.projectId, assignee: task.assignee } : undefined,
            project: routerProject,
            section: routerSection,
            projectTasks: projectTasks.map((t: any) => ({ assignee: t.assignee })),
            watchers: [],
          },
        })
          .then(result => {
            if (result.notified.length) {
              console.log(`[notification-router] Notified ${result.notified.join(', ')} for ${commentScope.kind} comment`);
            }
          })
          .catch(err => console.error('[notification-router] Error:', err));

        // Telegram notification when an agent posts a task comment (so humans see replies)
        if (task) {
          const commentAuthor = (comment.author || '').toLowerCase();
          const isAgentComment = teammates.some((t: any) => 
            !t.isHuman && (t.name?.toLowerCase() === commentAuthor || t.agentId?.toLowerCase() === commentAuthor)
          );
          if (isAgentComment && TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID && isTelegramCommsEnabled()) {
            const projectName = store.projects?.find((p: any) => p.id === task.projectId)?.name || '';
            const truncContent = comment.content?.length > 200 ? comment.content.slice(0, 200) + '…' : comment.content;
            const tgMsg = `💬 *${comment.author}* commented on "${task.title}"${projectName ? ` · ${projectName}` : ''}\n\n${truncContent}`;
            fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: tgMsg, parse_mode: 'Markdown' }),
            }).catch(() => {}); // best-effort
          }

          // Emit to activity feed
          const feedApi2 = (globalThis as any).__orgStudioActivityFeed;
          if (feedApi2?.add) {
            feedApi2.add({
              type: 'comment',
              emoji: '💬',
              agent: comment.author,
              project: store.projects?.find((p: any) => p.id === task.projectId)?.name || '',
              taskId: task.id,
              message: `${comment.author} commented on "${task.title}"`,
              detail: comment.content?.slice(0, 100),
            });
          }
        } // end if (task)

        return NextResponse.json({ ok: true, comment, mentions: mentionResult });
      }

      case 'listComments': {
        if (!payload.scope) return NextResponse.json({ error: 'Missing scope' }, { status: 400 });
        const provider = getStoreProvider();
        if (typeof (provider as any).listComments !== 'function') {
          return NextResponse.json({ error: 'listComments not supported by current provider' }, { status: 501 });
        }
        const listOpts: { limit?: number; before?: number } = {};
        if (payload.limit) listOpts.limit = Number(payload.limit);
        if (payload.before) listOpts.before = Number(payload.before);
        const comments = await (provider as any).listComments(payload.scope, listOpts);
        return NextResponse.json({ ok: true, comments });
      }

      case 'listDmThreads': {
        const provider = getStoreProvider();
        if (typeof (provider as any).listDmThreads !== 'function') {
          return NextResponse.json({ threads: [] }); // graceful fallback
        }
        const threads = await (provider as any).listDmThreads(payload.forAgent);
        return NextResponse.json({ ok: true, threads });
      }

      case 'addHandoff': {
        // Context injection: dev attaches notes when resolving a blocker.
        // These notes get prepended to the agent's next scheduler loop prompt.
        const task = store.tasks.find((t: any) => t.id === payload.taskId);
        if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
        if (!payload.message) return NextResponse.json({ error: 'Missing message' }, { status: 400 });
        if (!payload.author) return NextResponse.json({ error: 'Missing author' }, { status: 400 });

        const now = Date.now();
        const commentId = Math.random().toString(36).slice(2, 10) + now.toString(36);
        
        // PERF: Use targeted provider methods instead of full store write
        // Add the handoff comment
        await getStoreProvider().addComment(payload.taskId, {
          id: commentId,
          author: payload.author,
          content: `📋 **Handoff Note** (will be injected into ${task.assignee || 'agent'}'s next loop):\n\n${payload.message}`,
          createdAt: now,
          type: 'system' as const,
        });
        
        // Update task with devHandoff and clear loop pause
        await getStoreProvider().updateTask(payload.taskId, {
          devHandoff: {
            message: payload.message,
            author: payload.author,
            createdAt: now,
          },
          lastActivityAt: now,
          loopPausedAt: null,
          loopPauseReason: null,
          loopCount: 0,
        });

        // Trigger the agent's scheduler so they pick this up immediately
        try {
          const assignee = (task.assignee || '').toLowerCase();
          const teammates = store.settings?.teammates || [];
          const teammate = teammates.find((tm: any) => 
            tm.name?.toLowerCase() === assignee || tm.agentId === assignee
          );
          const agentId = teammate?.agentId || assignee;
          if (agentId) {
            await fetch('http://localhost:4501/api/scheduler', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'trigger', agentId }),
            });
          }
        } catch (e: any) {
          console.warn('addHandoff: trigger failed:', e?.message);
        }

        return NextResponse.json({ ok: true, handoff: task.devHandoff });
      }

      case 'updateSettings': {
        // PERF: Use targeted provider.updateSettings() instead of full store write
        await getStoreProvider().updateSettings(payload.settings);
        return NextResponse.json({ ok: true });
      }

      case 'addTeammate': {
        const teammates = store.settings?.teammates || [];
        const id = payload.teammate?.id || Math.random().toString(36).slice(2, 10);
        const teammate = { id, ...payload.teammate };
        teammates.push(teammate);
        
        // Auto-create scheduler loop for non-human agents
        const loops = store.settings?.loops || [];
        let loopCreated = false;
        if (!teammate.isHuman && teammate.agentId && !loops.some((l: any) => l.agentId === teammate.agentId)) {
          const maxOffset = loops.reduce((max: number, l: any) => Math.max(max, l.startOffsetMinutes || 0), 0);
          const newLoop = {
            id: 'loop-' + Math.random().toString(36).slice(2, 10),
            steps: DEFAULT_LOOP_STEPS.map(s => ({ ...s })),
            agentId: teammate.agentId,
            enabled: true,
            cronJobId: null,
            intervalMinutes: 30,
            startOffsetMinutes: maxOffset + 5,
          };
          loops.push(newLoop);
          loopCreated = true;
        }
        
        // Write both teammates and loops together if loop was created
        if (loopCreated) {
          await getStoreProvider().updateSettings({ teammates, loops });
        } else {
          await getStoreProvider().updateSettings({ teammates });
        }
        return NextResponse.json({ ok: true, teammate });
      }

      case 'updateTeammate': {
        const teammates = store.settings?.teammates || [];
        const idx = teammates.findIndex((t: any) => t.id === payload.id);
        if (idx >= 0) {
          teammates[idx] = { ...teammates[idx], ...payload.updates };
          // PERF: Use targeted provider.updateSettings() instead of full store write
          await getStoreProvider().updateSettings({ teammates });
        }
        return NextResponse.json({ ok: true });
      }

      case 'removeTeammate': {
        const teammates = (store.settings?.teammates || []).filter((t: any) => t.id !== payload.id);
        // PERF: Use targeted provider.updateSettings() instead of full store write
        await getStoreProvider().updateSettings({ teammates });
        return NextResponse.json({ ok: true });
      }

      case 'updateValues': {
        // PERF: Use targeted provider.updateSettings() instead of full store write
        await getStoreProvider().updateSettings({ values: payload.values });
        return NextResponse.json({ ok: true });
      }

      case 'addLoop': {
        const loops = store.settings?.loops || [];
        const id = 'loop-' + Math.random().toString(36).slice(2, 10);
        const loop = { id, ...payload.loop };
        loops.push(loop);
        // PERF: Use targeted provider.updateSettings() instead of full store write
        await getStoreProvider().updateSettings({ loops });
        return NextResponse.json({ ok: true, loop: { ...loop, id } });
      }

      case 'updateLoop': {
        const loops = store.settings?.loops || [];
        const idx = loops.findIndex((l: any) => l.id === payload.id);
        if (idx >= 0) {
          loops[idx] = { ...loops[idx], ...payload.updates };
          // PERF: Use targeted provider.updateSettings() instead of full store write
          await getStoreProvider().updateSettings({ loops });
        }
        return NextResponse.json({ ok: true });
      }

      case 'deleteLoop': {
        const loops = (store.settings?.loops || []).filter((l: any) => l.id !== payload.id);
        // PERF: Use targeted provider.updateSettings() instead of full store write
        await getStoreProvider().updateSettings({ loops });
        return NextResponse.json({ ok: true });
      }

      case 'updateLoopPreamble': {
        // PERF: Use targeted provider.updateSettings() instead of full store write
        await getStoreProvider().updateSettings({ loopPreamble: payload.loopPreamble });
        return NextResponse.json({ ok: true });
      }

      case 'updateQaLead': {
        // #862: QA is a component, not a column. `qaLead` is deprecated.
        // This action is retained as a no-op for backward compat (any callers don't 500).
        // Callers should move to per-project `qaOwner` on the project record instead.
        return NextResponse.json({
          ok: true,
          deprecated: true,
          message: 'updateQaLead is deprecated post-#862. QA is a component; set `qaOwner` on the project instead.',
        });
      }

      case '__removed_updateQaLead_legacy__': {
        const newQaLead = payload.agentId || null;
        const oldQaLead = store.settings?.qaLead || null;

        // PERF: Use targeted provider.updateSettings() instead of full store write
        await getStoreProvider().updateSettings({ qaLead: newQaLead });

        // If QA lead was cleared, move any tasks in 'qa' back to 'in-progress'
        if (!newQaLead && oldQaLead) {
          for (let i = 0; i < store.tasks.length; i++) {
            if (store.tasks[i].status === 'qa') {
              const t = store.tasks[i];
              const history = t.statusHistory || [];
              history.push({ status: 'in-progress', timestamp: Date.now(), by: 'System' });
              
              // Update task with new status
              await getStoreProvider().updateTask(t.id, {
                status: 'in-progress',
                statusHistory: history,
              });
              
              // Add system comment
              await getStoreProvider().addComment(t.id, {
                id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
                createdAt: Date.now(),
                author: 'System',
                content: 'Moved from QA back to In Progress — QA lead was removed.',
                type: 'system',
              });
            }
          }
        }

        return NextResponse.json({ ok: true });
      }

      case 'updateGuardrails': {
        const project = store.projects.find((p: any) => p.id === payload.projectId);
        if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

        const guardrails = payload.guardrails || '';
        await getStoreProvider().updateProject(payload.projectId, { guardrails });
        const updatedProject = { ...project, guardrails };
        return NextResponse.json({ ok: true, project: updatedProject });
      }

      case 'promoteVersion': {
        // Consolidated promote: UI Start button + auto-advance funnel through here.
        // Wraps promoteProjectToNextVersion from project-state.ts.
        const { promoteProjectToNextVersion } = await import('@/lib/project-state');
        const promoteProjectId = payload.projectId;
        const targetVersion = payload.targetVersion; // optional: explicit version for manual launch
        if (!promoteProjectId) {
          return NextResponse.json({ error: 'Missing projectId' }, { status: 400 });
        }

        // Need a Postgres client for the promote util
        if (!process.env.DATABASE_URL) {
          return NextResponse.json({ error: 'promoteVersion requires Postgres' }, { status: 501 });
        }
        const { Pool: PgPool } = await import('pg');
        const pool = new PgPool({ connectionString: process.env.DATABASE_URL });
        const pgClient = await pool.connect();
        try {
          const result = await promoteProjectToNextVersion(promoteProjectId, pgClient, {
            targetVersion,
            workspaceId: workspace.id,
          });
          if (!result.promoted) {
            return NextResponse.json({ ok: false, reason: result.reason });
          }
          // Trigger the dev agent to pick up the new backlog tasks
          const project = store.projects.find((p: any) => p.id === promoteProjectId);
          if (project?.devOwner) {
            triggerAgentLoop(project.devOwner, store);
          }
          return NextResponse.json({ ok: true, ...result });
        } finally {
          pgClient.release();
          await pool.end();
        }
      }

      // --- Section CRUD ---

      case 'addSection': {
        // Validate owner if non-empty: must match a teammate name
        const sectionOwner = payload.section?.owner || '';
        if (sectionOwner) {
          const teammateNames = (store.settings?.teammates || []).map((t: any) => t.name?.toLowerCase());
          if (!teammateNames.includes(sectionOwner.toLowerCase())) {
            return NextResponse.json(
              { error: `Invalid section owner '${sectionOwner}': must be a team member` },
              { status: 400 }
            );
          }
        }
        const section = await getStoreProvider().addSection(payload.projectId, {
          name: payload.section?.name || 'New Section',
          owner: sectionOwner,
          outcomes: payload.section?.outcomes || '',
          contract: payload.section?.contract || '',
          ...(payload.section?.id ? { id: payload.section.id } : {}),
        });
        return NextResponse.json({ ok: true, section });
      }

      case 'updateSection': {
        // Validate owner if being set to non-empty
        const updOwner = (payload.updates || {}).owner;
        if (updOwner !== undefined && updOwner !== '') {
          const teammateNames = (store.settings?.teammates || []).map((t: any) => t.name?.toLowerCase());
          if (!teammateNames.includes(updOwner.toLowerCase())) {
            return NextResponse.json(
              { error: `Invalid section owner '${updOwner}': must be a team member` },
              { status: 400 }
            );
          }
        }
        await getStoreProvider().updateSection(payload.projectId, payload.sectionId, payload.updates || {});
        return NextResponse.json({ ok: true });
      }

      case 'deleteSection': {
        try {
          // Before deleting, reassign tasks in this section to the default Main section
          const project = store.projects.find((p: any) => p.id === payload.projectId);
          if (project) {
            const sections = project.sections || [];
            const defaultMain = sections.find((s: any) => s.id === `sec-main-${payload.projectId}`);
            const fallbackSection = defaultMain || sections.find((s: any) => s.id !== payload.sectionId);
            const reassignToId = fallbackSection?.id || `sec-main-${payload.projectId}`;

            const tasksToReassign = store.tasks.filter(
              (t: any) => t.projectId === payload.projectId && t.sectionId === payload.sectionId
            );
            for (const t of tasksToReassign) {
              await getStoreProvider().updateTask(t.id, { sectionId: reassignToId });
            }
          }

          await getStoreProvider().deleteSection(payload.projectId, payload.sectionId);
          return NextResponse.json({ ok: true });
        } catch (e: any) {
          if (e.message === 'Cannot delete the last section') {
            return NextResponse.json({ error: e.message }, { status: 400 });
          }
          throw e;
        }
      }

      case 'reorderSections': {
        await getStoreProvider().reorderSections(payload.projectId, payload.sectionIds || []);
        return NextResponse.json({ ok: true });
      }

      case 'purgeSection': {
        if (!payload.projectId || !payload.sectionId) {
          return NextResponse.json({ error: 'Missing projectId or sectionId' }, { status: 400 });
        }
        await getStoreProvider().purgeSection(payload.projectId, payload.sectionId);
        return NextResponse.json({ ok: true });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
