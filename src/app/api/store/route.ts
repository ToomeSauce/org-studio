import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import { rpc } from '@/lib/gateway-rpc';
import { getStoreProvider, type StoreData } from '@/lib/store-provider';
import { parseMentions, notifyMentionedAgents } from '@/lib/mention-notifier';

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

/** Generate next ticket number for a new task */
function getNextTicketNumber(store: StoreData): number {
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

  if (status !== 'in-progress' && status !== 'qa') return; // Only check these statuses
  if (task.isArchived) return; // Don't check archived tasks

  // Get last activity timestamp
  const lastActivity = task.lastActivityAt
    || (task.statusHistory?.length ? task.statusHistory[task.statusHistory.length - 1]?.timestamp : null)
    || task.createdAt
    || 0;

  if (now - lastActivity < STUCK_THRESHOLD_MS) return; // Not stuck yet

  // Task is stuck — resolve responsible agent
  let responsibleName: string | null = null;
  if (status === 'qa') {
    responsibleName = task.testAssignee || null;
    if (!responsibleName) {
      const teammates = (store as any).settings?.teammates || [];
      const qaLead = store.settings?.qaLead;
      if (qaLead) {
        const qaTeammate = teammates.find((t: any) => t.agentId === qaLead);
        responsibleName = qaTeammate?.name || qaLead;
      }
    }
  }
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
  
  // Notify on all significant status transitions (user needs to see these)
  // All statuses go to the activity feed, but only high-signal ones go to Telegram
  const FEED_STATUSES = ['in-progress', 'review', 'done', 'blocked', 'qa'];
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
    'qa': '🧪',
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
  const stuckAgents = new Set<string>();

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
    if (agentId && !stuckAgents.has(agentId)) {
      stuckAgents.add(agentId);
      triggerAgentLoop(assignee, store);
    }
  }
}

export async function GET() {
  try {
    const data = await readStore();
    piggybackStuckCheck(data);
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST — handle mutations
export async function POST(req: NextRequest) {
  const authError = await authenticateRequest(req);
  if (authError) return authError;

  try {
    const body = await req.json();
    const { action, ...payload } = body;
    const store = await readStore();

    switch (action) {
      case 'addTask': {
        const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        const now = Date.now();
        const initialStatus = payload.task?.status || 'backlog';
        const ticketNumber = getNextTicketNumber(store);
        const task = {
          id,
          ticketNumber,
          createdAt: now,
          ...payload.task,
          statusHistory: [{ status: initialStatus, timestamp: now }],
          initiatedBy: payload.task?.initiatedBy || 'unknown',
        };
        // PERF: Use targeted provider.createTask() instead of full store write
        await getStoreProvider().createTask(task);

        // Event-driven: if task lands in backlog, trigger the assignee's loop
        if (initialStatus === 'backlog' && task.assignee) {
          triggerAgentLoop(task.assignee, store);
        }

        // Event-driven: if task lands in QA, trigger the QA agent
        if (initialStatus === 'qa') {
          const qaAssignee = task.testAssignee || store.settings?.qaLead;
          if (qaAssignee) {
            triggerAgentLoop(qaAssignee, store);
          }
        }

        return NextResponse.json({ ok: true, task });
      }

      case 'updateTask': {
        let triggeredAssignee: string | null = null;
        let versionCompletionTriggered: { projectId: string; project: any } | null = null;

        for (let i = 0; i < store.tasks.length; i++) {
          const t = store.tasks[i];
          if (t.id !== payload.id) continue;
          const updates = { ...payload.updates };
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

            // When moving to qa, resolve testAssignee if not already set
            if (updates.status === 'qa') {
              const merged = { ...t, ...updates };
              if (!merged.testAssignee) {
                const teammates = (store as any).settings?.teammates || [];
                // resolve testAssignee: explicit > qaLead setting > team QA role > self
                const qaLeadId = store.settings?.qaLead;
                if (qaLeadId) {
                  const qaLeadTeammate = teammates.find((tm: any) => tm.agentId === qaLeadId);
                  updates.testAssignee = qaLeadTeammate?.name || qaLeadId;
                } else {
                  const qaAgent = teammates.find((tm: any) => tm.role === 'qa');
                  updates.testAssignee = qaAgent?.name || t.assignee;
                }
              }
            }

            // Notify on status changes FROM in-progress/qa (these are tracked work transitions)
            // OR notify on transitions TO in-progress/review/done/qa/blocked (significant state changes)
            const shouldNotify = (t.status === 'in-progress' || t.status === 'qa') || 
                                  ['in-progress', 'review', 'done', 'blocked', 'qa'].includes(updates.status);
            if (shouldNotify) {
              const merged = { ...t, ...updates };
              notifyTaskStatusChange(merged, updates.status, store);
            }

            // **NEW: Check for version completion when task moves to done**
            if (updates.status === 'done' && t.projectId) {
              const project = store.projects.find((p: any) => p.id === t.projectId);
              if (project?.autonomy?.enabled && project.autonomy.pendingVersion) {
                versionCompletionTriggered = { projectId: t.projectId, project };
              }
            }
          }
          const updated = { ...t, ...updates };
          if ((updated.status === 'backlog') &&
              (updates.status === 'backlog' || updates.assignee) &&
              updated.assignee) {
            triggeredAssignee = updated.assignee;
          }

          // Trigger dev agent when task bounces back to in-progress (e.g. QA rejection)
          if (updates.status === 'in-progress' && t.status === 'qa' && updated.assignee) {
            triggeredAssignee = updated.assignee;
          }

          // Trigger QA agent when task moves to QA column
          if (updates.status === 'qa') {
            const qaAssignee = updated.testAssignee || store.settings?.qaLead;
            if (qaAssignee) {
              triggerAgentLoop(qaAssignee, store);
            }
          }

          store.tasks[i] = updated;
          // Piggyback stuck-task detection: check if this updated task is now stuck
          checkAndTriggerStuckTask(updated, store);
          
          // PERF: Use targeted provider.updateTask() instead of full store write
          await getStoreProvider().updateTask(payload.id, updates);

          // Roadmap auto-sync: when task moves to done, mark matching roadmap item as done
          if (updates.status === 'done' && updated.version && updated.projectId) {
            (async () => {
              try {
                const rmRes = await fetch(`http://127.0.0.1:${process.env.PORT || 4501}/api/roadmap/${updated.projectId}`);
                if (!rmRes.ok) return;
                const rmData = await rmRes.json();
                const version = (rmData.versions || []).find((v: any) => v.version === updated.version);
                if (!version) return;
                const titleLower = updated.title?.toLowerCase().trim();
                let changed = false;
                for (const item of (version.items || [])) {
                  if (item.done) continue;
                  const itemLower = item.title?.toLowerCase().trim();
                  if (itemLower === titleLower || titleLower?.includes(itemLower) || itemLower?.includes(titleLower)) {
                    item.done = true;
                    changed = true;
                    break;
                  }
                }
                if (changed) {
                  const apiKey = process.env.ORG_STUDIO_API_KEY || '';
                  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
                  await fetch(`http://127.0.0.1:${process.env.PORT || 4501}/api/roadmap/${updated.projectId}`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                      action: 'upsert',
                      version: version.version,
                      title: version.title,
                      status: version.status,
                      items: version.items,
                    }),
                  });
                }
              } catch { /* non-blocking */ }
            })();
          }
        }
        if (triggeredAssignee) {
          triggerAgentLoop(triggeredAssignee, store);
        }

        // Chain to next backlog task when agent completes work
        if (payload.updates?.status && ['done', 'review'].includes(payload.updates.status)) {
          const completed = store.tasks.find(t => t.id === payload.id);
          if (completed?.assignee) {
            const assigneeLower = completed.assignee.toLowerCase();
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

        // **NEW: Handle version completion asynchronously**
        if (versionCompletionTriggered) {
          (async () => {
            try {
              const { checkVersionCompletion, shouldAutoLaunchNext } = await import('@/lib/vision-completion');
              const summary = checkVersionCompletion(
                versionCompletionTriggered.project,
                store.tasks
              );
              if (summary.isComplete) {
                console.log(
                  `[Vision Autonomy] Version complete for project ${versionCompletionTriggered.projectId}`
                );
                // Clear pendingVersion
                versionCompletionTriggered.project.autonomy.pendingVersion = undefined;
                // PERF: Use targeted provider.updateProject() instead of full store write
                await getStoreProvider().updateProject(versionCompletionTriggered.projectId, {
                  autonomy: versionCompletionTriggered.project.autonomy,
                });

                // Auto-launch next version if within approval boundary
                if (shouldAutoLaunchNext(versionCompletionTriggered.project, versionCompletionTriggered.project.currentVersion || '?')) {
                  try {
                    const port = process.env.GATEWAY_PORT || '4501';
                    await fetch(`http://localhost:${port}/api/vision/${versionCompletionTriggered.projectId}/launch`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                    });
                    console.log(`[Vision Autonomy] Auto-launched next version for ${versionCompletionTriggered.projectId}`);
                  } catch (e: any) {
                    console.error(`[Vision Autonomy] Auto-launch failed:`, e?.message);
                  }
                }
              }
            } catch (e) {
              console.error('[Vision Autonomy] Completion check error:', e);
            }
          })();
        }

        // **NEW: Handle outcome completion**
        if (payload.updates?.status === 'done' && payload.id) {
          const completedTask = store.tasks.find(t => t.id === payload.id);
          if (completedTask?.projectId) {
            (async () => {
              try {
                const { checkOutcomeCompletion } = await import('@/lib/vision-completion');
                const project = store.projects.find(p => p.id === completedTask.projectId);
                if (!project) return;

              const result = await checkOutcomeCompletion(project, store.tasks);
              if (result.completedOutcomeIds.length > 0) {
                console.log(`[Outcome Tracking] ${result.message}`);
                // Auto-mark outcomes as done
                for (const outcomeId of result.completedOutcomeIds) {
                  const outcome = project.outcomes?.find((o: any) => o.id === outcomeId);
                  if (outcome) {
                    outcome.done = true;
                    outcome.completedAt = Date.now();
                  }
                }
                // Persist the updated outcomes
                await getStoreProvider().updateProject(completedTask.projectId, {
                  outcomes: project.outcomes,
                });
              }
            } catch (e) {
              console.error('[Outcome Tracking] Completion check error:', e);
            }
          })();
          }
        }

        return NextResponse.json({ ok: true });
      }

      case 'deleteTask': {
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
        const project = { id, createdAt: Date.now(), ...payload.project };
        // PERF: Use targeted provider.createProject() instead of full store write
        await getStoreProvider().createProject(project);
        return NextResponse.json({ ok: true, project });
      }

      case 'updateProject': {
        console.log('[API:store:updateProject]', { id: payload.id, updates: JSON.stringify(payload.updates).slice(0, 500) });
        // PERF: Use targeted provider.updateProject() instead of full store write
        await getStoreProvider().updateProject(payload.id, payload.updates);
        console.log('[API:store:updateProject] completed for', payload.id);

        // Note: Vision cron management has been replaced by the Launch model
        // No auto-create/update/delete cron logic needed here anymore

        return NextResponse.json({ ok: true });
      }

      case 'deleteProject': {
        // PERF: Use targeted provider.deleteProject() instead of full store write
        await getStoreProvider().deleteProject(payload.id);
        return NextResponse.json({ ok: true });
      }

      case 'addComment': {
        const task = store.tasks.find((t: any) => t.id === payload.taskId);
        if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
        const commentId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        const model = await resolveAgentModel(payload.comment?.author, store);
        const comment = {
          id: commentId,
          createdAt: Date.now(),
          ...payload.comment,
          model: payload.comment?.model || model, // explicit > resolved
        };
        // PERF: Use targeted provider.addComment() instead of full store write
        // But also update lastActivityAt on the task
        await getStoreProvider().addComment(payload.taskId, comment);
        await getStoreProvider().updateTask(payload.taskId, { lastActivityAt: Date.now() });

        // @mention detection — notify mentioned agents (async, best-effort)
        const teammates = store.settings?.teammates || [];
        const mentions = parseMentions(comment.content, teammates);
        let mentionResult: any = null;
        if (mentions.length > 0) {
          // Fire-and-forget so we don't block the response
          notifyMentionedAgents(task, comment, mentions, teammates)
            .then(result => {
              if (result.sent.length) {
                console.log(`[mentions] Notified ${result.sent.join(', ')} about comment on ${task.id}`);
              }
              if (result.failed.length) {
                console.warn(`[mentions] Failed to notify ${result.failed.join(', ')} about comment on ${task.id}`);
              }
            })
            .catch(err => console.error('[mentions] Notification error:', err));
          mentionResult = { detected: mentions.map(m => m.teammate.name || m.teammate.agentId) };
        }

        return NextResponse.json({ ok: true, comment, mentions: mentionResult });
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

      case 'addOutcome': {
        const project = store.projects.find((p: any) => p.id === payload.projectId);
        if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
        if (!payload.outcome?.text) return NextResponse.json({ error: 'Missing outcome text' }, { status: 400 });

        const outcomeId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        const newOutcome = {
          id: outcomeId,
          text: payload.outcome.text,
          done: false,
          createdAt: Date.now(),
        };

        const outcomes = project.outcomes || [];
        outcomes.push(newOutcome);

        await getStoreProvider().updateProject(payload.projectId, { outcomes });
        const updatedProject = { ...project, outcomes };
        return NextResponse.json({ ok: true, project: updatedProject, outcome: newOutcome });
      }

      case 'toggleOutcome': {
        const project = store.projects.find((p: any) => p.id === payload.projectId);
        if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
        if (!payload.outcomeId) return NextResponse.json({ error: 'Missing outcomeId' }, { status: 400 });

        const outcomes = project.outcomes || [];
        const outcomeIndex = outcomes.findIndex((o: any) => o.id === payload.outcomeId);
        if (outcomeIndex === -1) return NextResponse.json({ error: 'Outcome not found' }, { status: 404 });

        const outcome = outcomes[outcomeIndex];
        const newDone = !outcome.done;
        outcomes[outcomeIndex] = {
          ...outcome,
          done: newDone,
          completedAt: newDone ? Date.now() : undefined,
        };

        await getStoreProvider().updateProject(payload.projectId, { outcomes });
        const updatedProject = { ...project, outcomes };
        return NextResponse.json({ ok: true, project: updatedProject });
      }

      case 'removeOutcome': {
        const project = store.projects.find((p: any) => p.id === payload.projectId);
        if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
        if (!payload.outcomeId) return NextResponse.json({ error: 'Missing outcomeId' }, { status: 400 });

        const outcomes = (project.outcomes || []).filter((o: any) => o.id !== payload.outcomeId);
        await getStoreProvider().updateProject(payload.projectId, { outcomes });
        const updatedProject = { ...project, outcomes };
        return NextResponse.json({ ok: true, project: updatedProject });
      }

      case 'updateGuardrails': {
        const project = store.projects.find((p: any) => p.id === payload.projectId);
        if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

        const guardrails = payload.guardrails || '';
        await getStoreProvider().updateProject(payload.projectId, { guardrails });
        const updatedProject = { ...project, guardrails };
        return NextResponse.json({ ok: true, project: updatedProject });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
