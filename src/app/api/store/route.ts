import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, authenticateRequestWithContext, requireWriteScope, getSession, getSessionTokenFromCookie } from '@/lib/auth';
import { rpc } from '@/lib/gateway-rpc';
import { getStoreProvider, type StoreData } from '@/lib/store-provider';
import { parseMentions } from '@/lib/mention-notifier';
import { routeCommentNotifications } from '@/lib/notification-router';
import { resolveTaskComponent, resolveTaskVersion } from '@/lib/notification-context';
import { syncRoadmapItemForTask } from '@/lib/roadmap-sync';
import { checkArchivedProject } from '@/lib/archived-project-compat';
import { getEffectiveOwner } from '@/lib/component-helpers';
import { isTelegramCommsEnabled } from '@/lib/telegram-guard';
import { validateAddComment, resolveCommentAuthor } from '@/lib/add-comment-validation';
import {
  resolveWorkspaceContext,
  filterByWorkspace,
  stampWorkspace,
  belongsToWorkspace,
  DEFAULT_WORKSPACE_ID,
  requireWorkspaceRole,
  type WorkspaceContext,
} from '@/lib/workspace-auth';
import { auditBreakGlassIfNeeded } from '@/lib/admin-audit';
import { validateUpdateTaskPayload } from '@/lib/update-task-validation';
import { canonicalizeTeammate } from '@/lib/canonicalize-teammate';
import { getRuntimeRegistry } from '@/lib/runtimes/registry';

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

/** Resolve model from agent name via Gateway sessions list. Best-effort, returns undefined on failure.
 *  #1344: Wrapped in AbortController (1s timeout) and gated on explicit GATEWAY_PORT in container/staging
 *  envs to prevent self-deadlock when port 4501 IS the same Next process (no Gateway behind it). */
/**
 *  resolveAgentModel — returns the model id for an agent NAME.
 *
 *  #1353 — Refactored from per-runtime branching (`if
 *  agentId.startsWith('hermes-')`) into a thin dispatch over
 *  RuntimeRegistry.getRuntimeForAgent(agentId).getAgentMetadata(agentId).
 *  All per-runtime logic now lives inside the AgentRuntime
 *  implementations themselves (src/lib/runtimes/{openclaw,hermes}.ts).
 *  Route.ts is back to being source-of-truth-agnostic.
 *
 *  Old flow:
 *    1. agentId.startsWith('hermes-') → read profile config + format
 *    2. else → fetch Gateway sessions.list (with 1s AbortController guard)
 *
 *  New flow:
 *    1. registry.getRuntimeForAgent(agentId) → .getAgentMetadata(agentId)
 *    2. Runtime owns its own source of truth + timeout discipline.
 *    3. Container/staging short-circuit moved inside OpenClaw's impl
 *       (it's specific to OpenClaw's Gateway round-trip, not Hermes).
 *
 *  Backwards compatible: same signature, same return type, same
 *  fallback-to-undefined semantics. Existing callers (~L989, ~L1744
 *  before slice 1, same offsets here) unchanged.
 *
 *  #1344: AbortController timeout enforcement moved INTO
 *  OpenClawRuntime.getAgentMetadata so each runtime owns its own
 *  network discipline. Hermes is filesystem-only so it doesn't need
 *  a timeout.
 */
async function resolveAgentModel(agentName: string, store: StoreData): Promise<string | undefined> {
  try {
    // Resolve agent name → agentId via the teammates roster.
    const teammates = (store as any).settings?.teammates || [];
    const match = teammates.find((t: any) =>
      t.name?.toLowerCase() === agentName?.toLowerCase() ||
      t.agentId === agentName?.toLowerCase()
    );
    const agentId = match?.agentId;
    if (!agentId) return undefined;

    // Thin dispatch — ask the runtime that owns this agent for its
    // canonical metadata. Each runtime knows its own source of truth,
    // timeout discipline, and env-guards (e.g. OpenClaw owns the
    // container/staging short-circuit; Hermes is filesystem-only).
    // route.ts no longer has any per-runtime branching for model
    // resolution — cf. doneWhen #4 + #8.
    const registry = await getRuntimeRegistry();
    let runtime = registry.getRuntimeForAgent(agentId);
    if (!runtime) {
      // Agent not in the map yet — registry may not have run discovery
      // since process start (it's lazy: discoverAll() is only called
      // when /api/runtimes is hit or when registry.send() is invoked).
      // First-comment-after-restart would otherwise stamp undefined.
      // Mirror the pattern used by registry.send() (see registry.ts).
      await registry.discoverAll();
      runtime = registry.getRuntimeForAgent(agentId);
    }
    if (!runtime) {
      // No runtime owns this agent (declared in teammates but no live
      // runtime backs it, or runtime is currently down). Honest
      // answer: undefined.
      return undefined;
    }
    const metadata = await runtime.getAgentMetadata(agentId);
    return metadata?.model;
  } catch {
    return undefined; // best-effort — never block on this
  }
}

/** Generate next ticket number for a new task.
 *  @deprecated #863 — use getStoreProvider(workspace.id).allocateTicketNumber() which is atomic.
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

// Async wrappers for StoreProvider — workspace-scoped per #1387 A.1.
async function readStore(workspaceId: string) {
  return await getStoreProvider(workspaceId).read();
}

async function writeStore(workspaceId: string, data: any) {
  return await getStoreProvider(workspaceId).write(data);
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
  // #1290 (2026-05-08): dropped 'review' — column removed entirely.
  const FEED_STATUSES = ['in-progress', 'done', 'blocked']; // #862: dropped 'qa'; #1290: dropped 'review'
  const TELEGRAM_STATUSES = ['blocked']; // Only blocked tasks are urgent enough for Telegram
  if (!FEED_STATUSES.includes(newStatus)) return;

  const project = store.projects.find((p: any) => p.id === task.projectId);
  const projectName = project?.name || 'Unknown';
  const assignee = task.assignee || 'Unassigned';
  const reviewNotes = task.reviewNotes?.trim();

  const statusEmoji: Record<string, string> = {
    'in-progress': '⚙️',
    'done': '✅',
    'blocked': '🚫',
    // #1290: 'review' removed — column killed.
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

    // #1290: was ['in-progress','review']; review column removed.
    if (task.status === 'in-progress') {
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
    // #1217 Bug B fix: apikey/noauth now return userId=null. Fall back to
    // 'basil' here for WORKSPACE-MEMBERSHIP purposes only — never for
    // attribution. Comment author resolution lives in case 'addComment'.
    const userId = authResult.context?.userId ?? 'basil';
    const wsResult = await resolveWorkspaceContext(req, userId);
    if (wsResult.error) return wsResult.error;
    if (wsResult.context) return wsResult.context;
  } catch {}
  return { id: DEFAULT_WORKSPACE_ID, name: 'Default Workspace' };
}

export async function GET(req: NextRequest) {
  try {
    // #1387 A.3 (decision #4): cloud-mode anonymous GET gate.
    //   OSS (no DATABASE_URL): anonymous GET allowed (today's behavior).
    //   Cloud (DATABASE_URL set):
    //     - require session cookie OR Bearer API/per-agent token, else 401.
    //     - ALLOW_ANONYMOUS_READS=true overrides (transition flag for
    //       embeds/marketing pages); a startup warning is logged elsewhere.
    if (process.env.DATABASE_URL && process.env.ALLOW_ANONYMOUS_READS !== 'true') {
      const cookieHeader = req.headers.get('cookie');
      const sessionToken = getSessionTokenFromCookie(cookieHeader);
      const authHeader = req.headers.get('authorization') || '';
      const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      let authed = false;
      if (sessionToken) {
        const session = await getSession(sessionToken);
        if (session) authed = true;
      }
      if (!authed && bearer) {
        // Match the same auth path as authenticateRequest — either global
        // ORG_STUDIO_API_KEY or a valid per-agent token (when enabled).
        if (process.env.ORG_STUDIO_API_KEY && bearer === process.env.ORG_STUDIO_API_KEY) {
          authed = true;
        } else {
          try {
            const { perAgentTokensEnabled, verifyApiToken } = await import('@/lib/api-tokens');
            if (perAgentTokensEnabled()) {
              const record = await verifyApiToken(bearer);
              if (record) authed = true;
            }
          } catch {
            // fall through
          }
        }
      }
      if (!authed) {
        return NextResponse.json(
          {
            error: 'unauthorized',
            message:
              'Cloud-mode /api/store requires authentication. Set ALLOW_ANONYMOUS_READS=true to allow anonymous reads (transition flag).',
          },
          { status: 401 },
        );
      }
    }

    // Workspace filtering — transparent: single-workspace users see everything
    const wsOrError = await resolveRequestWorkspace(req);
    if (wsOrError instanceof NextResponse) return wsOrError;
    const workspace = wsOrError;
    const data = await readStore(workspace.id);
    piggybackStuckCheck(data);

    const filteredTasks = filterByWorkspace(data.tasks, workspace.id);

    // #1293 phase 1 — strip inline task.comments[] from the snapshot and
    // replace with a numeric commentCount. The normalized org_studio_comments
    // table (#1288) is the source of truth for the UI now; TaskDetailPanel
    // fetches via listComments on open. We still preserve the inline column
    // in storage and keep dual-write going (phase 2 stops the write, phase 3
    // drops the column). Server-side consumers (scheduler, signal-detector,
    // evidence-detector, section-access, notify) call readStore() / the
    // provider directly and continue to see the inline blob — only the
    // JSON wire response from this endpoint is slimmed.
    const slimTasks = filteredTasks.map((t: any) => {
      const comments = Array.isArray(t.comments) ? t.comments : [];
      const { comments: _stripped, ...rest } = t;
      return { ...rest, commentCount: comments.length };
    });

    const filteredData = {
      ...data,
      projects: filterByWorkspace(data.projects, workspace.id),
      tasks: slimTasks,
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

  // Resolve userId + auth method for this request. userId is used to rewrite
  // placeholder comment authors ('You' → teammate name); auth method gates
  // whether the rewrite runs at all (#1217 Bug B — apikey/noauth must NOT
  // rewrite, since the global API key has no real human owner).
  let requestUserId: string | null | undefined;
  let requestAuthMethod: 'session' | 'apikey' | 'noauth' | 'agent-token' | undefined;
  try {
    const authCtx = await authenticateRequestWithContext(req);
    if (!authCtx.error) {
      const scopeFail = requireWriteScope(authCtx.context);
      if (scopeFail) return scopeFail;
      requestUserId = authCtx.context.userId;
      requestAuthMethod = authCtx.context.method;
    }
  } catch { /* best-effort */ }

  // Resolve workspace context for this request
  const wsOrError = await resolveRequestWorkspace(req);
  if (wsOrError instanceof NextResponse) return wsOrError;
  const workspace = wsOrError;

  // #1387 B.2 #4 — member-of-resolved-workspace role gate.
  // Slice A established that the workspace data layer enforces isolation at
  // the read/write surface (reads are scoped, writes are stamped). This gate
  // adds the identity check: only authenticated callers with a real
  // membership in workspace.id (OR the global ORG_STUDIO_API_KEY via
  // break-glass) can hit the mutation switch below.
  //
  // Break-glass keeps every existing agent loop and cron path working
  // unchanged today. B.3 audits each break-glass call so it's traceable.
  // Future work (separate ticket): migrate agent loops from global key to
  // per-agent tokens (#1383), then this gate becomes a real per-user check
  // for every call site.
  const roleCheck = await requireWorkspaceRole(req, workspace.id, 'member');
  if (!roleCheck.allowed) return roleCheck.response;
  // Audit call moved into the switch below (#1389) so the audit row carries
  // the specific mutation type (store.addTask vs store.addComment etc.)
  // instead of the generic 'store.mutation' label. Rationale: an audit row
  // is only useful if it reaches the mutation — a malformed body that
  // throws before the switch never mutated anything, so not auditing it is
  // the correct behavior.

  try {
    const body = await req.json();
    const { action, ...payload } = body;
    const store = await readStore(workspace.id);

    // #1389 — per-mutation audit granularity. Record the specific action
    // (addTask, updateTask, addComment, etc.) so we can answer questions
    // like "who deleted a project on date X" or "what break-glass writes
    // happened during the incident window" from the audit log directly.
    // Best-effort, never throws (handler in admin-audit.ts).
    await auditBreakGlassIfNeeded({
      req,
      workspaceId: workspace.id,
      via: roleCheck.via,
      userId: roleCheck.userId ?? null,
      action: `store.${action || 'unknown'}`,
    });

    switch (action) {
      case 'addTask': {
        // #1249 — priority field removed. Strip any client-supplied priority
        // up-front so callers using stale templates do not poison the data bag.
        // Ordering is via column position (sortOrder); see #1250 for the
        // user-facing drag-and-drop UI.
        if (payload?.task && 'priority' in payload.task) {
          delete payload.task.priority;
        }
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
          // Guardrail: reject unknown projectId. Without this, tasks land
          // with a phantom projectId and become silently invisible to
          // dispatch (the dispatch gate fails the `projects.find(p.id===…)`
          // lookup and skips the task with no warning). This was the
          // root cause of the 2026-05-06 "Org Studio backlog not running"
          // class of bug — agents typed the display-derived ID
          // ("proj-org-studio") instead of the canonical ID and the
          // store accepted it.
          const projectExists = (store.projects || []).some(
            (p: any) => p?.id === addTaskProjectId,
          );
          if (!projectExists) {
            const knownIds = (store.projects || [])
              .map((p: any) => p?.id)
              .filter(Boolean)
              .slice(0, 25);
            return NextResponse.json(
              {
                error: `Unknown projectId '${addTaskProjectId}'. The project must exist in the store before tasks can be filed against it.`,
                hint: 'Use one of the existing project IDs (see knownProjectIds) or create the project first.',
                knownProjectIds: knownIds,
              },
              { status: 400 },
            );
          }

          // #1269 — auto-resolve sectionId when caller passed only projectId.
          // Without this, a task with projectId set but sectionId missing is
          // silently invisible to the dispatch gate (which keys on
          // projectId && sectionId && version). Symmetric with the projectId
          // existence check above.
          {
            const project = (store.projects || []).find(
              (p: any) => p?.id === addTaskProjectId,
            );
            const { resolveSectionId } = await import('@/lib/resolve-section-id');
            const result = resolveSectionId(
              project,
              addTaskProjectId,
              payload.task?.sectionId,
            );
            if (!result.ok) {
              return NextResponse.json(
                {
                  error: result.error,
                  ...(result.validSectionIds ? { validSectionIds: result.validSectionIds } : {}),
                },
                { status: result.status },
              );
            }
            if (result.resolved) {
              payload.task.sectionId = result.sectionId;
              console.info(`[addTask #1269] Auto-resolved sectionId=${result.sectionId} for project ${addTaskProjectId}`);
            }
          }
        }

        // --- #698 Task-creation guardrails ---
        const taskVersion = (payload.task?.version || '').trim();

        // #1263 — per-version daily cap on auto-filed experiment
        // (spike) tickets. Spec: at most MAX_AUTO_TASKS_PER_VERSION_PER_DAY
        // (3) spike tasks per (project, version) per UTC day. Normal
        // feature/bug/chore tickets are NOT capped here. Runs BEFORE the
        // existing roadmap-item / adhoc-vs-version guardrails so an
        // automated dispatcher hammering spike tickets gets a clean 429
        // instead of a misleading downstream error.
        if (
          taskVersion &&
          payload.task?.projectId &&
          payload.task?.taskType === 'spike'
        ) {
          const { MAX_AUTO_TASKS_PER_VERSION_PER_DAY } = await import('@/lib/version-metric');
          const startOfUtcDay = (() => {
            const d = new Date();
            return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
          })();
          const sameDayCount = (store.tasks || []).filter((t: any) => {
            if (t.projectId !== payload.task.projectId) return false;
            if (t.version !== taskVersion) return false;
            if (t.taskType !== 'spike') return false;
            const created = typeof t.createdAt === 'number' ? t.createdAt : 0;
            return created >= startOfUtcDay;
          }).length;
          if (sameDayCount >= MAX_AUTO_TASKS_PER_VERSION_PER_DAY) {
            return NextResponse.json(
              {
                error: 'experiment_cap_exceeded',
                message: `At most ${MAX_AUTO_TASKS_PER_VERSION_PER_DAY} experiment tickets per version per day`,
              },
              { status: 429 },
            );
          }
        }

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
        // #1290: dropped 'review' — column removed.
        const VALID_STATUSES = ['planning', 'backlog', 'in-progress', 'done', 'blocked'];
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
          ticketNumber = await getStoreProvider(workspace.id).allocateTicketNumber();
        } catch (e: any) {
          console.error('[TicketNumber] allocateTicketNumber failed, using fallback:', e?.message);
          ticketNumber = getNextTicketNumberFallback(store);
        }

        // #okqrk04nmou2mtsz — hard guard. Both the provider call and the
        // fallback are expected to return a positive integer. Belt-and-braces
        // assertion so a NaN/null/undefined slip can never silently persist a
        // task with a missing number (the historical 6-task backfill case).
        // If neither path produced a valid number, refuse the write — better
        // a loud 500 than another invisible orphan.
        if (!Number.isInteger(ticketNumber) || ticketNumber <= 0) {
          console.error(
            `[TicketNumber] Invalid allocation result (${ticketNumber}). Refusing addTask.`,
          );
          return NextResponse.json(
            {
              error:
                'Internal error: ticket number allocation produced an invalid value. Task not created.',
            },
            { status: 500 },
          );
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
          // #1218: canonicalize assignee against the teammates roster.
          // Runs after the #1126 default-owner snapshot so the canonical
          // form is what gets persisted (and what fans out to triggers).
          assignee: canonicalizeTeammate(payload.task?.assignee, store.settings?.teammates || []),
          workspace_id: payload.task?.workspace_id || workspace.id,
          statusHistory: [{ status: initialStatus, timestamp: now }],
          initiatedBy: payload.task?.initiatedBy || 'unknown',
        };

        // #1250 — bottom-of-stack default. New tickets land at the BOTTOM of
        // their (projectId, status) column. If the caller passed an explicit
        // sortOrder we honor it; otherwise we compute max(sort_order)+1000
        // for the column from the in-memory store. This keeps DnD-ordered
        // columns stable when new tickets land on them.
        if (typeof task.sortOrder !== 'number') {
          const cohort = (store.tasks || []).filter(
            (t: any) => t.projectId === task.projectId && t.status === task.status,
          );
          let maxSort = 0;
          for (const t of cohort) {
            const s = typeof t.sortOrder === 'number' ? t.sortOrder : 0;
            if (s > maxSort) maxSort = s;
          }
          task.sortOrder = maxSort + 1000;
        }
        // PERF: Use targeted provider.createTask() instead of full store write
        await getStoreProvider(workspace.id).createTask(task);

        // #1351 slice 2 — fire-and-forget duplicate-detection hook.
        // Scores the just-created task against the project's linked repos
        // (merged PRs, last 90d) and the done-task corpus, then writes
        // `possibly_already_shipped` back via a second small update. Never
        // blocks ticket create on the lookup (constraint: best-effort).
        // Skipped for tasks with too little content to score (<2 tokens).
        if (task.title && (task.title.length + (task.description?.length || 0)) >= 10) {
          (async () => {
            try {
              const { computeMatches } = await import('@/lib/possibly-shipped-hook');
              const project = (store.projects || []).find((p: any) => p?.id === task.projectId);
              const { matches, meta } = await computeMatches({
                task: task as any,
                project,
                allTasks: store.tasks || [],
              });
              if (matches && matches.length > 0) {
                await getStoreProvider(workspace.id).updateTask(task.id, {
                  possibly_already_shipped: matches,
                } as any);
                console.info(
                  `[possibly-shipped #1351] task ${task.id} (#${task.ticketNumber || '?'}): ` +
                    `${matches.length} match(es) [top=${matches[0].score} ${matches[0].id}] ` +
                    `(${meta.prCount} PRs, ${meta.doneTaskCount} done tasks, ${meta.durationMs}ms)`,
                );
              } else {
                console.info(
                  `[possibly-shipped #1351] task ${task.id} (#${task.ticketNumber || '?'}): ` +
                    `no matches (${meta.prCount} PRs, ${meta.doneTaskCount} done tasks, ${meta.durationMs}ms` +
                    (meta.error ? `, error=${meta.error}` : '') + ')',
                );
              }
            } catch (e: any) {
              console.error('[possibly-shipped #1351] hook failed (non-fatal):', e?.message || e);
            }
          })();
        }

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
        // #1249 — priority field removed. Strip any client-supplied priority
        // from `updates` so stale templates cannot reintroduce the field.
        if (payload?.updates && 'priority' in payload.updates) {
          delete payload.updates.priority;
        }
        // #1195: validate payload shape up front so silent no-ops (missing
        // `updates`, `patch` typo, empty updates, missing id) become loud
        // 400s instead of misleading `{ ok: true }`.
        {
          const validationErr = validateUpdateTaskPayload(payload);
          if (validationErr) {
            return NextResponse.json(validationErr.body, { status: validationErr.status });
          }
        }
        // #1211: symmetric guard — adhoc-typed tasks must not carry a version.
        {
          const allowedAdhocTypes = ['bug', 'chore', 'followup', 'spike'];
          const existingTask = store.tasks.find((t: any) => t.id === payload.id);
          const effectiveType = payload.updates?.taskType ?? existingTask?.taskType;
          const hasVersionUpdate = payload.updates && 'version' in payload.updates;
          const effectiveVersion = hasVersionUpdate ? payload.updates.version : existingTask?.version;
          if (effectiveType && allowedAdhocTypes.includes(effectiveType) && effectiveVersion) {
            return NextResponse.json(
              { error: `Adhoc task (taskType=${effectiveType}) cannot have a version. Clear the version field or change taskType to 'feature'.` },
              { status: 400 }
            );
          }
        }
        // #1269 — auto-resolve sectionId on updateTask when caller is changing
        // projectId without supplying a matching sectionId. Mirrors the addTask
        // path. Out of scope per #1269 (5): existing tasks with missing
        // sectionId are NOT touched here — only acts when updates.projectId
        // is being set in this patch.
        if (
          payload.updates &&
          'projectId' in payload.updates &&
          !('sectionId' in payload.updates)
        ) {
          const newProjectId = payload.updates.projectId;
          if (newProjectId) {
            const project = (store.projects || []).find(
              (p: any) => p?.id === newProjectId,
            );
            const { resolveSectionId } = await import('@/lib/resolve-section-id');
            // Pass undefined for providedSectionId so the helper resolves.
            const result = resolveSectionId(project, newProjectId, undefined);
            if (!result.ok) {
              return NextResponse.json(
                {
                  error: result.error,
                  ...(result.validSectionIds ? { validSectionIds: result.validSectionIds } : {}),
                },
                { status: result.status },
              );
            }
            if (result.resolved) {
              payload.updates.sectionId = result.sectionId;
              console.info(`[updateTask #1269] Auto-resolved sectionId=${result.sectionId} for project ${newProjectId}`);
            }
          }
        }
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

          // #1218: canonicalize assignee against the teammates roster on write.
          if (updates.assignee !== undefined) {
            updates.assignee = canonicalizeTeammate(updates.assignee, store.settings?.teammates || []);
          }

          // #862: reject status 'qa' — QA is a component, not a column.
          // #1290: reject 'review' — column killed; default destination is 'done', use 'blocked' for awaiting-sign-off.
          if (updates.status !== undefined) {
            const VALID_STATUSES = ['planning', 'backlog', 'in-progress', 'done', 'blocked'];
            if (!VALID_STATUSES.includes(updates.status)) {
              return NextResponse.json(
                { error: `Invalid status '${updates.status}'. Allowed: ${VALID_STATUSES.join(', ')}. (QA is a component — #862. Review column removed — #1290; ship to 'done' or 'blocked' with reason.)` },
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

            // #1352 — Claim contract lifecycle on status transitions.
            //  Moving INTO in-progress → stamp a fresh lease.
            //  Moving OUT of in-progress → clear the lease.
            // Idempotent on no-op transitions (already guarded by
            // `updates.status !== t.status` outer check). Using null
            // rather than undefined keeps the Postgres path consistent
            // with the loopPausedAt clear above — the store provider
            // strips nulls on write, JSONB-overflow safe.
            const LEASE_WINDOW_MS = 60 * 60 * 1000; // 60min, Basil-confirmed
            if (updates.status === 'in-progress') {
              const nowTs = Date.now();
              (updates as any).claim_started_at = nowTs;
              (updates as any).claim_lease_expires_at = nowTs + LEASE_WINDOW_MS;
            } else {
              (updates as any).claim_started_at = null;
              (updates as any).claim_lease_expires_at = null;
            }

            // #862: QA is a component, not a column. Moving to 'qa' is no longer supported.
            // The status validation above already rejected it; this branch is removed.

            // Notify on status changes FROM in-progress (tracked work transitions)
            // OR notify on transitions TO in-progress/done/blocked (significant state changes) — #1290 dropped 'review'.
            const shouldNotify = (t.status === 'in-progress') || 
                                  ['in-progress', 'done', 'blocked'].includes(updates.status);
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

          // #1352 — Activity extends the claim lease idempotently. Any
            // field write on an active in-progress task with a current lease
            // is treated as proof-of-life. Skip when status is changing (the
            // status-transition branch above already stamps a fresh lease or
            // clears it). Only writes when there's nothing already bumping
            // it in this update.
          if (
            updated.status === 'in-progress' &&
            updated.claim_lease_expires_at &&
            updates.status === undefined &&
            (updates as any).claim_lease_expires_at === undefined
          ) {
            const renewed = Date.now() + 60 * 60 * 1000;
            (updates as any).claim_lease_expires_at = renewed;
            updated.claim_lease_expires_at = renewed;
            if (updates.lastActivityAt === undefined) {
              updates.lastActivityAt = Date.now();
              updated.lastActivityAt = updates.lastActivityAt;
            }
          }

          store.tasks[i] = updated;
          // Piggyback stuck-task detection: check if this updated task is now stuck
          checkAndTriggerStuckTask(updated, store);
          
          // PERF: Use targeted provider.updateTask() instead of full store write.
          // #948: wrap in try/catch so silent provider failures surface as 500 instead
          // of returning a misleading ok:true. Silent failures were breaking the
          // autonomous delivery chain (agents left stuck in in-progress).
          try {
            await getStoreProvider(workspace.id).updateTask(payload.id, updates);
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

          // #1351 slice 2 — re-run the duplicate-detection hook when the
          // ticket's title or description changed in this update (the two
          // fields the matcher consumes). Skipped on pure status / sort /
          // assignee updates to avoid redundant gh-api calls. Same
          // fire-and-forget pattern as addTask.
          const titleChanged = typeof payload.updates?.title === 'string' && payload.updates.title !== t.title;
          const descChanged = typeof payload.updates?.description === 'string' && payload.updates.description !== t.description;
          if (titleChanged || descChanged) {
            const taskForHook = updated as any;
            (async () => {
              try {
                const { computeMatches } = await import('@/lib/possibly-shipped-hook');
                const project = (store.projects || []).find((p: any) => p?.id === taskForHook.projectId);
                const { matches, meta } = await computeMatches({
                  task: taskForHook,
                  project,
                  allTasks: store.tasks || [],
                });
                // Always write back (even an empty array) so stale matches
                // from a previous title don't linger after an edit.
                await getStoreProvider(workspace.id).updateTask(taskForHook.id, {
                  possibly_already_shipped: matches || [],
                } as any);
                console.info(
                  `[possibly-shipped #1351] (updateTask) task ${taskForHook.id} (#${taskForHook.ticketNumber || '?'}): ` +
                    `${matches?.length || 0} match(es) ` +
                    (matches && matches.length > 0 ? `[top=${matches[0].score} ${matches[0].id}] ` : '') +
                    `(${meta.prCount} PRs, ${meta.doneTaskCount} done tasks, ${meta.durationMs}ms)`,
                );
              } catch (e: any) {
                console.error('[possibly-shipped #1351] updateTask hook failed (non-fatal):', e?.message || e);
              }
            })();
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
            const provider = getStoreProvider(workspace.id);
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

        // Chain to next backlog task when agent completes work — #1290 dropped 'review'.
        if (payload.updates?.status && payload.updates.status === 'done') {
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
                await getStoreProvider(workspace.id).updateTask(t.id, updates);
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
                await getStoreProvider(workspace.id).addComment(t.id, {
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
                      await getStoreProvider(workspace.id).addComment(anchor.id, {
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
                  // #1214: prefer version-level owner over component-level
                  // owner when a version is in scope (matchingVersion). Falls
                  // back to component owner via getEffectiveOwner.
                  const depOwner = getEffectiveOwner(proj, cmp.id, matchingVersion.id) || cmp.owner;
                  if (depOwner) triggerAgentLoop(depOwner, store);
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
                await getStoreProvider(workspace.id).updateProject(versionCompletionTriggered.projectId, updates);
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
        await getStoreProvider(workspace.id).updateTask(payload.id, {
          isArchived: true,
          archivedAt: Date.now(),
          archivedBy: payload.by || 'unknown',
        });
        return NextResponse.json({ ok: true });
      }

      case 'unarchiveTask': {
        // PERF: Use targeted provider.updateTask() instead of full store write
        await getStoreProvider(workspace.id).updateTask(payload.id, {
          isArchived: false,
          archivedAt: undefined,
          archivedBy: undefined,
        });
        return NextResponse.json({ ok: true });
      }

      case 'permanentlyDeleteTask': {
        // PERF: Use targeted provider.deleteTask() instead of full store write
        await getStoreProvider(workspace.id).deleteTask(payload.id);
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
        await getStoreProvider(workspace.id).createProject(project);
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
        await getStoreProvider(workspace.id).updateProject(payload.id, payload.updates);
        console.log('[API:store:updateProject] completed for', payload.id);

        // #1224: project-level autonomy.approvedThrough was a legacy bridge
        // when approvals were a single scalar. Now approvals live as
        // per-component approvedVersions[]. Strip any incoming scalar (the UI
        // no longer writes it; this is just defense-in-depth) and skip the
        // cascade — component-level updates fire their own promote retrigger
        // via `updateComponent`.
        if (payload.updates?.autonomy && 'approvedThrough' in payload.updates.autonomy) {
          delete (payload.updates.autonomy as any).approvedThrough;
        }
        const newApproved: string | undefined = undefined;
        const oldApproved: string | undefined = undefined;
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
                  const freshStore = await getStoreProvider(workspace.id).read();
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
          // When activating a previously inactive project, re-check promote
          // in case horizon was bumped while inactive. (#1185 rename: was started/stopped)
          const newActive = payload.updates.state === 'active' || payload.updates.state === 'started';
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
                  const result = await promoteProjectToNextVersion(payload.id, client);
                  if (result.promoted) {
                    console.log(`[ProjectState] Restart promote ${payload.id}: ${result.from} → ${result.to} (${result.movedTasks} tasks → backlog)`);
                    const freshStore = await getStoreProvider(workspace.id).read();
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
            await getStoreProvider(workspace.id).updateTask(task.id, { assignee: newDevOwner });
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
        const oldApprovedVersionsKey = JSON.stringify(
          Array.isArray(oldComp?.approvedVersions) ? [...oldComp.approvedVersions].sort() : null,
        );
        const newComp = { ...oldComp, ...compUpdates };
        // #1224: approvedThrough is dead. Strip any incoming/leftover scalar
        // so it never persists to storage. The single source of truth for
        // approval is approvedVersions[].
        delete newComp.approvedThrough;
        if ('approvedVersions' in compUpdates) {
          const list: string[] = Array.isArray(compUpdates.approvedVersions)
            ? compUpdates.approvedVersions
            : [];
          if (list.length === 0) {
            delete newComp.approvedVersions;
          } else {
            newComp.approvedVersions = list;
          }
        }
        comps[compIdx] = newComp;

        await getStoreProvider(workspace.id).updateProject(projectId, { [compsKey]: comps } as any);
        console.log(
          `[API:store:updateComponent] ${projectId}/${targetComponentId}`,
          JSON.stringify(compUpdates).slice(0, 200),
        );

        // Promote re-trigger when component approval moves.
        // #1224: only approvedVersions[] is consulted now.
        const newApprovedVersionsKey = JSON.stringify(
          Array.isArray(newComp?.approvedVersions) ? [...newComp.approvedVersions].sort() : null,
        );
        const horizonChanged =
          'approvedVersions' in compUpdates && newApprovedVersionsKey !== oldApprovedVersionsKey;
        if (horizonChanged) {
          console.log(
            `[ComponentApproval] ${projectId}/${targetComponentId}: approvedVersions ${oldApprovedVersionsKey} → ${newApprovedVersionsKey}`,
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
                  const freshStore = await getStoreProvider(workspace.id).read();
                  const proj = freshStore.projects.find((p: any) => p.id === projectId);
                  // Trigger the component's owner if known, else any project devOwner.
                  // #1214: when the promote moved tasks to a specific version
                  // (result.to), prefer that version's owner over the component
                  // owner. Resolve version string → versionId via the component.
                  let versionLevelOwner: string | undefined;
                  if (proj && result.to) {
                    const compsList: any[] = (proj as any).components?.length
                      ? (proj as any).components
                      : ((proj as any).sections || []);
                    const targetCmp = compsList.find((c: any) => c.id === targetComponentId);
                    const matchedVer = targetCmp?.versions?.find(
                      (v: any) => v.version === result.to || v.label === result.to,
                    );
                    if (matchedVer) {
                      versionLevelOwner = getEffectiveOwner(proj as any, targetComponentId, matchedVer.id);
                    }
                  }
                  const ownerToWake = versionLevelOwner || newComp.owner || proj?.devOwner;
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
        await getStoreProvider(workspace.id).deleteProject(payload.id);
        return NextResponse.json({ ok: true });
      }

      case 'addComment': {
        // #1217 Bug A + B: empty-content guard + apikey-author guard.
        // Pure validation lives in src/lib/add-comment-validation.ts so it
        // can be unit-tested without booting Next.
        const validation = validateAddComment(payload, requestAuthMethod);
        if (!validation.ok) {
          return NextResponse.json({ error: validation.error }, { status: validation.status });
        }

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

        // #1217 Bug B fix: only the `session` auth method may rewrite a
        // missing/'You' author into the logged-in user's teammate name. For
        // apikey/noauth, the validator already guaranteed an explicit author
        // (apikey) or we trust whatever the loopback caller sent (noauth).
        const resolvedAuthor = resolveCommentAuthor(
          payload.comment?.author,
          requestAuthMethod,
          requestUserId,
          store.settings?.teammates || [],
        );

        // #1218: canonicalize the final author against the teammates roster
        // (layered AFTER #1217 resolveCommentAuthor so the resolver still
        // owns the auth-method-aware rewrite logic).
        const canonicalAuthor = canonicalizeTeammate(
          resolvedAuthor,
          store.settings?.teammates || [],
        );

        const comment = {
          id: commentId,
          createdAt: Date.now(),
          ...payload.comment,
          author: canonicalAuthor,
          model: payload.comment?.model || model, // explicit > resolved
        };
        // PERF: Use targeted provider.addComment() instead of full store write
        // But also update lastActivityAt on the task
        await getStoreProvider(workspace.id).addComment(commentScope, comment);
        if (task) {
          // #1352 — If this is an active claim (in-progress + lease set),
          // extend the lease idempotently to now + 60min. Comment activity
          // counts as proof-of-life. Skipping system comments would be
          // accurate-but-fragile here (an agent posting progress notes
          // shouldn't have to also POST status to stay alive); the
          // scheduler-tick decision already cross-checks "active on other
          // tasks" before bouncing, so noise here is harmless.
          const activityUpdate: any = { lastActivityAt: Date.now() };
          if (task.status === 'in-progress' && task.claim_lease_expires_at) {
            activityUpdate.claim_lease_expires_at = Date.now() + 60 * 60 * 1000;
          }
          await getStoreProvider(workspace.id).updateTask(commentScope.taskId, activityUpdate);
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

        // #1287 — resolve component + version owners for the task scope so
        // the router can replace the project devOwner/qaOwner per-comment
        // page with version-owner + component-owner. Project-level page
        // remains as the orphan fallback (see notification-router.ts).
        const projectFull = task?.projectId
          ? store.projects.find((p: any) => p.id === task.projectId)
          : undefined;
        const routerComponent = task ? resolveTaskComponent(projectFull, task) : undefined;
        const routerVersion = task ? resolveTaskVersion(projectFull, task) : undefined;

        // Single unified call replaces all per-scope branchy dispatch
        routeCommentNotifications({
          comment: { id: comment.id, author: comment.author, content: comment.content, type: comment.type },
          scope: commentScope,
          teammates,
          context: {
            task: task ? { id: task.id, title: task.title, projectId: task.projectId, assignee: task.assignee } : undefined,
            project: routerProject,
            section: routerSection,
            component: routerComponent,
            version: routerVersion,
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
        const provider = getStoreProvider(workspace.id);
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
        const provider = getStoreProvider(workspace.id);
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
        await getStoreProvider(workspace.id).addComment(payload.taskId, {
          id: commentId,
          author: payload.author,
          content: `📋 **Handoff Note** (will be injected into ${task.assignee || 'agent'}'s next loop):\n\n${payload.message}`,
          createdAt: now,
          type: 'system' as const,
        });
        
        // Update task with devHandoff and clear loop pause
        await getStoreProvider(workspace.id).updateTask(payload.taskId, {
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
        await getStoreProvider(workspace.id).updateSettings(payload.settings);
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
          await getStoreProvider(workspace.id).updateSettings({ teammates, loops });
        } else {
          await getStoreProvider(workspace.id).updateSettings({ teammates });
        }
        return NextResponse.json({ ok: true, teammate });
      }

            case 'updateTeammate': {
        const teammates = store.settings?.teammates || [];
        const idx = teammates.findIndex((t: any) => t.id === payload.id);
        if (idx >= 0) {
          // #1352 slice 4 — Allow caller to DELETE fields by passing null.
          // JSON.stringify drops `undefined`, so the only wire-safe way to
          // say "clear this field" is to send an explicit null. Use it for
          // loopDisabledAt / loopDisableReason / staleClaim* when the
          // 'Re-enable dispatch loop' button fires. Plain merge still
          // supports normal field edits (title, domain, etc.).
          const merged: any = { ...teammates[idx], ...payload.updates };
          for (const [k, v] of Object.entries(payload.updates || {})) {
            if (v === null) delete merged[k];
          }
          teammates[idx] = merged;
          // PERF: Use targeted provider.updateSettings() instead of full store write
          await getStoreProvider(workspace.id).updateSettings({ teammates });
        }
        return NextResponse.json({ ok: true });
      }

      case 'removeTeammate': {
        const teammates = (store.settings?.teammates || []).filter((t: any) => t.id !== payload.id);
        // PERF: Use targeted provider.updateSettings() instead of full store write
        await getStoreProvider(workspace.id).updateSettings({ teammates });
        return NextResponse.json({ ok: true });
      }

      case 'updateValues': {
        // PERF: Use targeted provider.updateSettings() instead of full store write
        await getStoreProvider(workspace.id).updateSettings({ values: payload.values });
        return NextResponse.json({ ok: true });
      }

      case 'addLoop': {
        const loops = store.settings?.loops || [];
        const id = 'loop-' + Math.random().toString(36).slice(2, 10);
        const loop = { id, ...payload.loop };
        loops.push(loop);
        // PERF: Use targeted provider.updateSettings() instead of full store write
        await getStoreProvider(workspace.id).updateSettings({ loops });
        return NextResponse.json({ ok: true, loop: { ...loop, id } });
      }

      case 'updateLoop': {
        const loops = store.settings?.loops || [];
        const idx = loops.findIndex((l: any) => l.id === payload.id);
        if (idx >= 0) {
          loops[idx] = { ...loops[idx], ...payload.updates };
          // PERF: Use targeted provider.updateSettings() instead of full store write
          await getStoreProvider(workspace.id).updateSettings({ loops });
        }
        return NextResponse.json({ ok: true });
      }

      case 'deleteLoop': {
        const loops = (store.settings?.loops || []).filter((l: any) => l.id !== payload.id);
        // PERF: Use targeted provider.updateSettings() instead of full store write
        await getStoreProvider(workspace.id).updateSettings({ loops });
        return NextResponse.json({ ok: true });
      }

      case 'updateLoopPreamble': {
        // PERF: Use targeted provider.updateSettings() instead of full store write
        await getStoreProvider(workspace.id).updateSettings({ loopPreamble: payload.loopPreamble });
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
        await getStoreProvider(workspace.id).updateSettings({ qaLead: newQaLead });

        // If QA lead was cleared, move any tasks in 'qa' back to 'in-progress'
        if (!newQaLead && oldQaLead) {
          for (let i = 0; i < store.tasks.length; i++) {
            if (store.tasks[i].status === 'qa') {
              const t = store.tasks[i];
              const history = t.statusHistory || [];
              history.push({ status: 'in-progress', timestamp: Date.now(), by: 'System' });
              
              // Update task with new status
              await getStoreProvider(workspace.id).updateTask(t.id, {
                status: 'in-progress',
                statusHistory: history,
              });
              
              // Add system comment
              await getStoreProvider(workspace.id).addComment(t.id, {
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
        await getStoreProvider(workspace.id).updateProject(payload.projectId, { guardrails });
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
        const section = await getStoreProvider(workspace.id).addSection(payload.projectId, {
          name: payload.section?.name || 'New Section',
          owner: sectionOwner,
          outcomes: payload.section?.outcomes || '',
          contract: payload.section?.contract || '',
          ...(payload.section?.id ? { id: payload.section.id } : {}),
        });
        return NextResponse.json({ ok: true, section });
      }

      case 'updateSection': {
        // #1126 PR 6: reject any attempt to set `role: 'qa'`. After the Thrivor
        // migration folded QA into Main, no `role: 'qa'` sections exist. The
        // gate's carve-out was removed; allowing a new one to be created
        // would silently break sequential dispatch on that section.
        if ((payload.updates || {}).role === 'qa') {
          return NextResponse.json(
            { error: "role: 'qa' on a section is no longer supported. QA work is modeled as a versioned slice with version.owner instead. See #1126." },
            { status: 400 }
          );
        }
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
        await getStoreProvider(workspace.id).updateSection(payload.projectId, payload.sectionId, payload.updates || {});
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
              await getStoreProvider(workspace.id).updateTask(t.id, { sectionId: reassignToId });
            }
          }

          await getStoreProvider(workspace.id).deleteSection(payload.projectId, payload.sectionId);
          return NextResponse.json({ ok: true });
        } catch (e: any) {
          if (e.message === 'Cannot delete the last section') {
            return NextResponse.json({ error: e.message }, { status: 400 });
          }
          throw e;
        }
      }

      case 'reorderSections': {
        await getStoreProvider(workspace.id).reorderSections(payload.projectId, payload.sectionIds || []);
        return NextResponse.json({ ok: true });
      }

      case 'purgeSection': {
        if (!payload.projectId || !payload.sectionId) {
          return NextResponse.json({ error: 'Missing projectId or sectionId' }, { status: 400 });
        }
        await getStoreProvider(workspace.id).purgeSection(payload.projectId, payload.sectionId);
        return NextResponse.json({ ok: true });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
