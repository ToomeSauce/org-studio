/**
 * Scheduler API — manages the cron job lifecycle for agent work loops.
 *
 * Architecture:
 *   - Cron jobs fire on a long interval (hours) as a scouting heartbeat.
 *   - Event-driven triggers fire immediately when tasks land in backlog.
 *   - Pre-flight gate skips LLM calls when the agent has no actionable work.
 *
 * Actions: enable, disable, runNow, sync, trigger (event-driven)
 */
import { NextRequest, NextResponse } from 'next/server';
import { rpc } from '@/lib/gateway-rpc';
import { sendToAgent } from '@/lib/runtimes/registry';
import { enqueueOutbox } from '@/lib/outbox';
import { buildLoopPrompt, buildDispatchMessage, clearConsumedHandoffs } from '@/lib/scheduler';
import type { AgentLoop } from '@/lib/store';
import { authenticateRequest } from '@/lib/auth';
import { writeHeartbeat } from '@/lib/heartbeats';
import { getStoreProvider, type StoreData } from '@/lib/store-provider';
import {
  isTaskAnyDispatchEligible,
  isTaskWaiting,
} from '@/lib/dispatch-gate';
import {
  recordDispatchAttempt,
  diagnoseAgentBacklog,
  findStaleBacklogAgents,
  type TriggerSource,
  type SkipReason,
} from '@/lib/dispatch-attempts';
import {
  recordTrigger,
  recordSweep,
  setTriggerCooldownMs,
} from '@/lib/scheduler-state';
const DEFAULT_MODEL = 'foundry-openai-chat/gpt-5.4';

// Minimum seconds between event-driven triggers for the same agent (debounce)
const TRIGGER_COOLDOWN_MS = 60_000; // 1 minute
setTriggerCooldownMs(TRIGGER_COOLDOWN_MS);
const lastTriggerByAgent: Record<string, number> = {};
// #1184 phase 3 — 24h cooldown for stale-backlog Telegram escalations.
const lastEscalateByAgent: Record<string, number> = {};

// Loop detection: max loops on same task+status before escalation
// (constants moved into the v2 section below — see #1138)

const NOTIFY_CHAT_ID = process.env.NOTIFY_CHAT_ID || '';

async function readStore(): Promise<StoreData> {
  return await getStoreProvider().read();
}

async function writeStore(store: StoreData): Promise<void> {
  await getStoreProvider().write(store);
}

function getLoop(store: StoreData, loopId: string): AgentLoop | undefined {
  const loops: AgentLoop[] = store.settings?.loops || [];
  return loops.find(l => l.id === loopId);
}

function getLoopByAgent(store: StoreData, agentId: string): AgentLoop | undefined {
  const loops: AgentLoop[] = store.settings?.loops || [];
  return loops.find(l => l.agentId === agentId && l.enabled);
}

function updateLoopInStore(store: StoreData, loopId: string, updates: Partial<AgentLoop>): void {
  const loops: AgentLoop[] = store.settings?.loops || [];
  const idx = loops.findIndex(l => l.id === loopId);
  if (idx >= 0) {
    loops[idx] = { ...loops[idx], ...updates };
    store.settings = { ...(store.settings || {}), loops };
  }
}

function getAgentName(store: StoreData, agentId: string): string {
  const teammates = store.settings?.teammates || [];
  const t = teammates.find((tm: any) => tm.agentId === agentId);
  return t?.name || agentId;
}

function getAgentRole(store: StoreData, agentId: string): string | undefined {
  const teammates = store.settings?.teammates || [];
  const t = teammates.find((tm: any) => tm.agentId === agentId);
  return t?.role;
}

/**
 * Stall detection (#1138 v2 — time-based + stale-claim aware).
 *
 * The old heuristic counted scheduler dispatches that didn't change task
 * status. That conflated two things:
 *   1. an agent stuck in a tool loop with no real output, and
 *   2. an agent doing real multi-step work where status legitimately stays
 *      `in-progress` for many tool calls (read 5 files → think → write code).
 * It also fired on stale `in-progress` claims for tasks the agent had
 * already shipped or moved past — see ticket #1138 for the 5 false-positive
 * post-mortem.
 *
 * v2 requires THREE signals before escalating, in priority order:
 *   (a) MAX_LOOPS_BEFORE_ESCALATION dispatches without progress
 *       (existing — coarse: "this isn't a one-off")
 *   (b) lastActivityAt is older than STALL_QUIET_THRESHOLD_MS
 *       (NEW — "the agent really hasn't done anything on this task lately";
 *        comments, status changes, store updates all bump lastActivityAt)
 *   (c) the assignee's most recent activity on ANY other task is OLDER
 *       than this task's lastActivityAt
 *       (NEW — if they're working other tasks, this one is a stale claim,
 *        not a stall; we annotate and skip the page instead of paging)
 *
 * Stale-claim case: comment + leave assignee/status alone (no Telegram).
 * Real stall: full pause + Telegram alert (existing behaviour).
 */
const MAX_LOOPS_BEFORE_ESCALATION = 12; // raised from 6 (#1138, was raised 3→6 earlier)
const STALL_QUIET_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes of no lastActivityAt bump
const STALE_CLAIM_COMMENT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 1 stale-claim hint per task per day

/**
 * Returns the most recent lastActivityAt across all OTHER tasks owned by
 * `assigneeLower` (i.e. excluding `excludeTaskId`). Used to detect stale
 * claims: if the agent is busy elsewhere, this task isn't a stall.
 */
function maxOtherTaskActivity(store: StoreData, assigneeLower: string, excludeTaskId: string): number {
  let max = 0;
  for (const t of store.tasks) {
    if (t.id === excludeTaskId) continue;
    if ((t.assignee || '').toLowerCase() !== assigneeLower) continue;
    const ts = t.lastActivityAt || 0;
    if (ts > max) max = ts;
  }
  return max;
}

async function detectAndIncrementLoops(store: StoreData, agentId: string): Promise<{ stalled: any[]; staleClaims: any[]; incremented: number }> {
  const agentName = getAgentName(store, agentId);
  const nameLower = agentName.toLowerCase();
  const stalled: any[] = [];
  const staleClaims: any[] = [];
  let incremented = 0;
  const now = Date.now();

  for (let i = 0; i < store.tasks.length; i++) {
    const t = store.tasks[i];
    const assignee = (t.assignee || '').toLowerCase();
    if (!(assignee === nameLower || assignee === agentId)) continue;
    if (t.status !== 'in-progress') continue;
    if (t.loopPausedAt) continue; // already paused

    // Reset loop count if agent posted a non-system comment since last dispatch
    // (comments = progress, even without status change)
    const lastComment = (t.comments || []).filter((c: any) =>
      (c.author?.toLowerCase() === nameLower || c.author?.toLowerCase() === agentId) && c.type !== 'system'
    ).pop();
    const lastDispatchTime = t._lastDispatchedAt || 0;
    if (lastComment?.createdAt && lastComment.createdAt > lastDispatchTime) {
      store.tasks[i] = { ...t, loopCount: 0, _lastDispatchedAt: now };
      continue; // has recent activity, don't increment
    }

    const newCount = (t.loopCount || 0) + 1;
    store.tasks[i] = { ...t, loopCount: newCount, _lastDispatchedAt: now };
    incremented++;

    if (newCount < MAX_LOOPS_BEFORE_ESCALATION) continue;

    // (b) Time-based gate: must also have been quiet on this task for a while.
    // lastActivityAt is bumped on comments, status changes, and store updates,
    // so a busy agent passes through this gate even mid-multi-step work.
    const lastActivity = t.lastActivityAt || t.createdAt || 0;
    const quietMs = now - lastActivity;
    if (quietMs < STALL_QUIET_THRESHOLD_MS) {
      // Loop count hit threshold but the agent has touched this task recently.
      // Almost certainly real work in progress. Don't escalate yet.
      continue;
    }

    // (c) Stale-claim check: is the agent more recently active on OTHER tasks?
    // If yes, this 'in-progress' is a forgotten claim — don't page, just note.
    const otherActivity = maxOtherTaskActivity(store, assignee, t.id);
    if (otherActivity > lastActivity) {
      staleClaims.push(store.tasks[i]);
      continue;
    }

    stalled.push(store.tasks[i]);
  }

  if (incremented > 0) {
    await writeStore(store);
  }

  return { stalled, staleClaims, incremented };
}

/**
 * Annotate stale-claim tasks: drop a one-line system comment hinting that
 * the assignee may have moved on, but DO NOT pause or page. Caller decides
 * cadence; we cooldown per task to avoid spamming the comment thread.
 */
async function annotateStaleClaims(store: StoreData, agentId: string, staleClaims: any[]): Promise<void> {
  if (staleClaims.length === 0) return;
  const agentName = getAgentName(store, agentId);
  const now = Date.now();
  let mutated = false;

  for (const task of staleClaims) {
    const idx = store.tasks.findIndex(t => t.id === task.id);
    if (idx < 0) continue;
    const existing = store.tasks[idx].comments || [];
    // Cooldown: skip if we already noted this task within the last 24h.
    const recentNote = existing
      .filter((c: any) => c.type === 'system' && typeof c.id === 'string' && c.id.startsWith('sys-stale-claim-'))
      .pop();
    if (recentNote && (now - (recentNote.createdAt || 0)) < STALE_CLAIM_COMMENT_COOLDOWN_MS) continue;

    const note = `🔍 **Possible stale claim** — ${agentName} appears to be active on other tasks more recently than this one. If this task is done or no longer assigned to ${agentName}, please update its status. (No agent loop paused.)`;
    existing.push({
      id: `sys-stale-claim-${now}-${task.id}`,
      author: 'System',
      content: note,
      createdAt: now,
      type: 'system',
    });
    store.tasks[idx] = { ...store.tasks[idx], comments: existing };
    mutated = true;
  }

  if (mutated) await writeStore(store);
}

/**
 * Pause stalled tasks: mark as paused, add system comment, send Telegram alert.
 */
async function pauseStalledTasks(store: StoreData, agentId: string, stalledTasks: any[]): Promise<void> {
  const agentName = getAgentName(store, agentId);
  const now = Date.now();

  for (const task of stalledTasks) {
    const idx = store.tasks.findIndex(t => t.id === task.id);
    if (idx < 0) continue;

    // Mark as paused
    const reason = `Agent "${agentName}" ran ${task.loopCount} scheduler loops on this task without changing status. Pausing to prevent further resource waste.`;
    store.tasks[idx] = {
      ...store.tasks[idx],
      loopPausedAt: now,
      loopPauseReason: reason,
    };

    // Add system comment
    const comments = store.tasks[idx].comments || [];
    comments.push({
      id: `sys-stall-${now}`,
      author: 'System',
      content: `⚠️ **Loop Detection — Agent Paused**\n\n${reason}\n\nTo resume: clear the pause via the task detail panel or move the task to a different status.`,
      createdAt: now,
      type: 'system',
    });
    store.tasks[idx].comments = comments;
    store.tasks[idx].lastActivityAt = now;

    // Send Telegram alert
    try {
      const sessionKey = `agent:main:main`; // Route via main agent for Telegram delivery
      await rpc('chat.send', {
        sessionKey,
        message: `⚠️ **Stall Alert — ${agentName}**\n\nTask: "${task.title}" (#${task.ticketNumber || '?'})\nLoops: ${task.loopCount} without progress\nStatus: ${task.status}\n\nAgent loop paused. Manual review needed.`,
        idempotencyKey: `stall-${task.id}-${now}`,
      });
    } catch (e: any) {
      console.error(`Failed to send stall alert for task ${task.id}:`, e?.message || e);
    }
  }

  if (stalledTasks.length > 0) {
    await writeStore(store);
  }
}

/** Check if an agent has actionable work (backlog or in-progress tasks assigned to them). */
function hasActionableWork(store: StoreData, agentId: string): boolean {
  return getActionableWork(store, agentId).hasWork;
}

// #1112 PR 4 — pure dispatch gating lives in src/lib/dispatch-gate.ts.
// Semantics (recap; details in that module):
//   Rule 1: project.state === 'active' (#1185)
//   Rule 2: task has sectionId + version
//   Rule 3: task.version <= component.approvedThrough
//   Rule 4: component-version waitsFor satisfied
//   Rule 5: status=backlog + assignee (checked at this call site)
//
// Option A (derived dispatch gating) still applies: truth lives on
// components[].versions[] + store state, not on per-task `blocked` flips.
// Task-level ad-hoc blockers still use the #1102 `blockedBy` mechanism —
// the two coexist (component-scope + task-scope).

/**
 * Detailed check for actionable work. Returns what TYPE of work exists.
 * This distinction matters: an in-progress task means the agent is ALREADY working —
 * don't re-dispatch. Only backlog/QA tasks need a new dispatch.
 */
function getActionableWork(store: StoreData, agentId: string): { hasWork: boolean; hasNewWork: boolean; hasInProgress: boolean } {
  const agentName = getAgentName(store, agentId);
  const nameLower = agentName.toLowerCase();
  const agentRole = getAgentRole(store, agentId);
  // #862: agentRole === 'qa' still shapes scheduler prompts (validation-oriented) but no longer affects column routing.

  let hasInProgress = false;
  let hasNewWork = false;

  for (const t of store.tasks) {
    const assignee = (t.assignee || '').toLowerCase();
    const status = (t.status || '').toLowerCase();

    // Skip paused tasks — they don't count as actionable
    if (t.loopPausedAt) continue;

    const isAssigned = assignee === nameLower || assignee === agentId;

    // In-progress: agent is already working on this
    if (isAssigned && status === 'in-progress') {
      hasInProgress = true;
      continue;
    }

    // #1112 PR 4 — per-component dispatch gating. Rules 1-4 encoded in
    // isTaskDispatchEligible(); rule 5 (backlog + assignee) checked here.
    // #1183 — adhoc tickets (bug/chore/spike/followup) take the parallel
    // lane via isTaskAdhocDispatchEligible. Umbrella ORs both.
    if (isAssigned && status === 'backlog') {
      if (isTaskAnyDispatchEligible(store, t as any)) hasNewWork = true;
    }

    // #862: QA-column routing removed — QA tickets are ordinary tickets owned by the QA component owner (assignee).
  }

  return { hasWork: hasInProgress || hasNewWork, hasNewWork, hasInProgress };
}

/** Quick gateway availability check with 3-second timeout. */
async function checkGateway(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    
    const res = await fetch('http://127.0.0.1:4501/api/gateway', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'status' }),
      signal: controller.signal as any,
    });
    
    clearTimeout(timeoutId);
    return res.ok;
  } catch {
    return false;
  }
}

/** 
 * Fire a one-shot dispatch to the agent's main persistent session.
 * Sends a focused task dispatch message via chat.send instead of spawning an isolated cron job.
 * This allows the agent to work with full tools, sub-agent spawning, and no artificial timeout.
 */

// In-flight tracking — shared with store route via scheduler-bridge
import { setInFlightAgent, clearInFlightAgent as bridgeClearInFlight, isInFlight } from '@/lib/runtimes/scheduler-bridge';

// Re-export for backward compat
export function clearInFlightAgent(agentId: string) {
  bridgeClearInFlight(agentId);
}

async function fireOneShot(store: StoreData, loop: AgentLoop): Promise<string | undefined> {
  const agentName = getAgentName(store, loop.agentId);
  const agentRole = getAgentRole(store, loop.agentId);

  // Prevent duplicate dispatch if agent is already in-flight
  if (isInFlight(loop.agentId)) {
    console.log(`[Dispatch] skipping ${agentName} — already in-flight`);
    return undefined;
  }

  // #948: Removed redundant `hasInProgressTask` concurrency gate.
  //
  // The `isInFlight` marker above is the authoritative concurrency signal — it is set
  // when a dispatch enqueues and cleared when the agent completes a task (see
  // updateTask in src/app/api/store/route.ts, or the safety timeout in
  // src/lib/runtimes/scheduler-bridge.ts).
  //
  // The old gate re-checked `store.tasks` for in-progress tasks assigned to this agent.
  // That check raced with stale store snapshots: when updateTask silently no-op'd (see
  // #948's root cause) OR when the read replica lagged behind the last write, the gate
  // would see a phantom in-progress task that the agent had actually already finished,
  // and refuse to dispatch the next backlog item. Effect: agents needed manual nudges
  // to keep working. Dropping this gate is safe because isInFlight covers the real
  // concurrency concern, and the dispatch message builder (`buildDispatchMessage`)
  // already picks the right task from the real backlog.

  // Build a focused dispatch message (not the full loop prompt)
  const message = await buildDispatchMessage(store, loop.agentId, agentName, agentRole);
  if (!message) {
    // No actionable work to dispatch
    return undefined;
  }

  // Clear consumed handoffs after building the message
  const handoffTaskIds = (buildDispatchMessage as any)._lastHandoffTaskIds || [];
  if (handoffTaskIds.length > 0) {
    await clearConsumedHandoffs(handoffTaskIds);
  }

  // Send to agent's main persistent session
  const sessionKey = `agent:${loop.agentId}:main`;
  setInFlightAgent(loop.agentId);

  try {
    // Enqueue to outbox — the outbox worker will call sendToAgent via /api/outbox/drain.
    // The onComplete 'redispatch' marker tells the drain endpoint to re-trigger
    // the scheduler when the agent completes (preserving the chain-dispatch behaviour).
    const idempotencyKey = `dispatch-${loop.agentId}-${Date.now()}`;
    await enqueueOutbox({
      agentId: loop.agentId,
      message,
      sessionKey,
      idempotencyKey,
      onCompleteKind: 'redispatch',
    });

    // Write heartbeat after successful enqueue
    try {
      await writeHeartbeat({ agentId: loop.agentId, loopId: loop.id, status: 'firing' });
    } catch (_hbErr) {
      // Heartbeat failures must never break scheduler execution
    }

    return sessionKey;
  } catch (e: any) {
    console.error(`fireOneShot: enqueueOutbox failed for ${agentName}:`, e?.message || e);
    // Clear in-flight on failure so agent can be retried
    bridgeClearInFlight(loop.agentId);

    // Inline retry — kept as a safety net in case enqueue itself fails
    // (e.g. Postgres is temporarily unreachable). The outbox worker handles
    // retry for send failures; this handles enqueue failures.
    const RETRY_DELAYS = [15000, 30000, 60000]; // 15s, 30s, 60s
    const retryCount = (loop as any)._retryCount || 0;
    if (retryCount < RETRY_DELAYS.length) {
      const delay = RETRY_DELAYS[retryCount];
      console.log(`fireOneShot: scheduling retry ${retryCount + 1}/${RETRY_DELAYS.length} for ${agentName} in ${delay/1000}s`);
      setTimeout(async () => {
        try {
          const freshStore = await readStore();
          const freshLoop = { ...loop, _retryCount: retryCount + 1 } as any;
          await fireOneShot(freshStore, freshLoop);
        } catch (retryErr: any) {
          console.warn(`fireOneShot: retry ${retryCount + 1} failed for ${agentName}:`, retryErr?.message);
        }
      }, delay);
    }
    return undefined;
  }
}

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const { action, loopId } = body;

    if (!action) {
      return NextResponse.json({ error: 'Missing action' }, { status: 400 });
    }

    switch (action) {
      case 'enable': {
        if (!loopId) return NextResponse.json({ error: 'Missing loopId' }, { status: 400 });

        const store = await readStore();
        const loop = getLoop(store, loopId);
        if (!loop) return NextResponse.json({ error: 'Loop not found' }, { status: 404 });

        // Check gateway availability
        const hasGateway = await checkGateway();
        if (!hasGateway) {
          return NextResponse.json(
            { error: 'Agent runtime not connected. Set GATEWAY_URL and GATEWAY_TOKEN in .env.local to enable scheduling.', code: 'NO_GATEWAY' },
            { status: 503 }
          );
        }

        const agentName = getAgentName(store, loop.agentId);
        const agentRole = getAgentRole(store, loop.agentId);
        const globalPreamble = store.settings?.loopPreamble || '';
        const prompt = await buildLoopPrompt(loop, agentName, globalPreamble, agentRole);

        // Create recurring cron job via Gateway (scouting heartbeat — runs on long interval)
        const result = await rpc('cron.add', {
          name: `Scheduler: ${agentName}`,
          agentId: loop.agentId,
          sessionTarget: 'isolated',
          schedule: { kind: 'every', everyMs: loop.intervalMinutes * 60000 },
          payload: {
            kind: 'agentTurn',
            message: prompt,
            model: loop.model || DEFAULT_MODEL,
            timeoutSeconds: 300,
          },
          delivery: { mode: 'none' },
        });

        const cronJobId = result?.id || result?.jobId || result?.job?.id;
        if (!cronJobId) {
          console.error('cron.add response missing id:', result);
          return NextResponse.json({ error: 'cron.add did not return a job ID', detail: result }, { status: 502 });
        }

        // Persist back to store
        updateLoopInStore(store, loopId, { enabled: true, cronJobId });
        await writeStore(store);

        return NextResponse.json({ ok: true, cronJobId });
      }

      case 'disable': {
        if (!loopId) return NextResponse.json({ error: 'Missing loopId' }, { status: 400 });

        const store = await readStore();
        const loop = getLoop(store, loopId);
        if (!loop) return NextResponse.json({ error: 'Loop not found' }, { status: 404 });

        // Check gateway availability
        const hasGateway = await checkGateway();
        if (!hasGateway) {
          return NextResponse.json(
            { error: 'Agent runtime not connected. Set GATEWAY_URL and GATEWAY_TOKEN in .env.local to disable scheduling.', code: 'NO_GATEWAY' },
            { status: 503 }
          );
        }

        // Remove cron job if it exists
        if (loop.cronJobId) {
          try {
            await rpc('cron.remove', { id: loop.cronJobId });
          } catch (e: any) {
            // If job already gone, that's fine
            console.warn('cron.remove warning:', e?.message || e);
          }
        }

        // Re-read store in case it changed, then update
        const freshStore = await readStore();
        updateLoopInStore(freshStore, loopId, { enabled: false, cronJobId: undefined });
        await writeStore(freshStore);

        return NextResponse.json({ ok: true });
      }

      case 'runNow': {
        if (!loopId) return NextResponse.json({ error: 'Missing loopId' }, { status: 400 });

        const store = await readStore();
        const loop = getLoop(store, loopId);
        if (!loop) return NextResponse.json({ error: 'Loop not found' }, { status: 404 });

        // Check gateway availability
        const hasGateway = await checkGateway();
        if (!hasGateway) {
          return NextResponse.json(
            { error: 'Agent runtime not connected. Set GATEWAY_URL and GATEWAY_TOKEN in .env.local to run loops.', code: 'NO_GATEWAY' },
            { status: 503 }
          );
        }

        if (loop.cronJobId) {
          // Trigger existing cron job, force even if stuck
          try {
            await rpc('cron.run', { id: loop.cronJobId, runMode: 'force' });
          } catch (e: any) {
            // If the cron job doesn't exist anymore, clear it and fire a one-shot
            console.error('cron.run error:', e?.message || e);
            const freshStore2 = await readStore();
            updateLoopInStore(freshStore2, loopId, { cronJobId: undefined });
            await writeStore(freshStore2);
            await fireOneShot(store, loop);
          }
        } else {
          await fireOneShot(store, loop);
        }

        // Update lastRun
        const freshStore = await readStore();
        updateLoopInStore(freshStore, loopId, { lastRun: Date.now() });
        await writeStore(freshStore);

        return NextResponse.json({ ok: true });
      }

      case 'runHistory': {
        if (!loopId) return NextResponse.json({ error: 'Missing loopId' }, { status: 400 });

        const store = await readStore();
        const loop = getLoop(store, loopId);
        if (!loop?.cronJobId) return NextResponse.json({ ok: true, entries: [] });

        const limit = body.limit || 20;
        try {
          const result = await rpc('cron.history', { jobId: loop.cronJobId, limit });
          const entries = (result?.entries || []).filter((e: any) => e.action === 'finished');
          return NextResponse.json({ ok: true, entries, total: result?.total });
        } catch (e: any) {
          console.error('cron.history error:', e?.message || e);
          return NextResponse.json({ ok: true, entries: [] });
        }
      }

      case 'sync': {
        const store = await readStore();
        const loops: AgentLoop[] = store.settings?.loops || [];

        // Check gateway availability
        const hasGateway = await checkGateway();
        if (!hasGateway) {
          return NextResponse.json(
            { error: 'Agent runtime not connected. Set GATEWAY_URL and GATEWAY_TOKEN in .env.local to sync scheduling.', code: 'NO_GATEWAY' },
            { status: 503 }
          );
        }

        // Get all cron jobs from Gateway
        let cronJobs: any[] = [];
        try {
          const result = await rpc('cron.list', {});
          cronJobs = result?.jobs || [];
        } catch (e: any) {
          return NextResponse.json({ error: 'Failed to list cron jobs: ' + (e?.message || e) }, { status: 502 });
        }

        const cronIds = new Set(cronJobs.map((j: any) => j.id));
        let synced = 0;
        let freshStore = await readStore();

        for (const loop of loops) {
          if (loop.enabled && loop.cronJobId && !cronIds.has(loop.cronJobId)) {
            // Enabled loop but cron job missing — recreate
            const agentName = getAgentName(freshStore, loop.agentId);
            const agentRole = getAgentRole(freshStore, loop.agentId);
            const globalPreamble = freshStore.settings?.loopPreamble || '';
            const prompt = await buildLoopPrompt(loop, agentName, globalPreamble, agentRole);
            try {
              const result = await rpc('cron.add', {
                name: `Scheduler: ${agentName}`,
                agentId: loop.agentId,
                sessionTarget: 'isolated',
                schedule: { kind: 'every', everyMs: loop.intervalMinutes * 60000 },
                payload: {
                  kind: 'agentTurn',
                  message: prompt,
                  model: loop.model || DEFAULT_MODEL,
                  timeoutSeconds: 300,
                },
                delivery: { mode: 'none' },
              });
              const newId = result?.id || result?.jobId || result?.job?.id;
              freshStore = await readStore();
              updateLoopInStore(freshStore, loop.id, { cronJobId: newId });
              await writeStore(freshStore);
              synced++;
            } catch (e: any) {
              console.error(`Failed to recreate cron for loop ${loop.id}:`, e?.message || e);
            }
          } else if (!loop.enabled && loop.cronJobId) {
            // Disabled loop but lingering cron job — remove
            try {
              await rpc('cron.remove', { id: loop.cronJobId });
            } catch (e: any) {
              console.warn(`cron.remove warning for ${loop.cronJobId}:`, e?.message || e);
            }
            freshStore = await readStore();
            updateLoopInStore(freshStore, loop.id, { cronJobId: undefined });
            await writeStore(freshStore);
            synced++;
          }
        }

        return NextResponse.json({ ok: true, synced });
      }

      case 'trigger': {
        // Event-driven trigger — called when a task lands in an agent's backlog.
        // Expects: { action: 'trigger', agentId: string, triggerSource?: TriggerSource }
        const { agentId } = body;
        if (!agentId) return NextResponse.json({ error: 'Missing agentId' }, { status: 400 });

        const store = await readStore();
        // #1184: classify the trigger source so the dispatch-health view can
        // tell addTask hooks from sweeps from manual presses. Caller is
        // responsible for tagging; default to 'manual' (safe assumption —
        // unknown counts as user-initiated for SLA purposes).
        const triggerSource: TriggerSource = (
          ['addTask', 'listen', 'sweep', 'watchdog', 'manual'].includes(
            body?.triggerSource,
          )
            ? body.triggerSource
            : 'manual'
        ) as TriggerSource;
        const agentName = getAgentName(store, agentId);

        // #1184: helper — record the attempt then return the response.
        // Computes diagnosis lazily so successful paths skip the cost.
        const recordAndReturn = async (
          response: any,
          opts: {
            outcome: 'dispatched' | 'skipped';
            reason?: SkipReason;
          },
        ) => {
          try {
            const diag = diagnoseAgentBacklog(store, agentId, agentName);
            await recordDispatchAttempt({
              agentId,
              triggerSource,
              outcome: opts.outcome,
              reason: opts.reason,
              taskCountBacklog: diag.taskCountBacklog,
              taskCountBlockedByGate: diag.taskCountBlockedByGate,
              topBlocker:
                opts.outcome === 'dispatched' ? undefined : diag.topBlocker,
            });
          } catch (e: any) {
            // Observability is best-effort — never break dispatch on log fail.
            console.warn('[trigger] recordDispatchAttempt failed:', e?.message || e);
          }
          return NextResponse.json(response);
        };

        const loop = getLoopByAgent(store, agentId);
        if (!loop) {
          return recordAndReturn(
            { ok: true, skipped: true, reason: 'No enabled loop for agent' },
            { outcome: 'skipped', reason: 'loop-disabled' },
          );
        }

        // Cooldown — don't fire more than once per minute per agent
        const now = Date.now();
        const lastTrigger = lastTriggerByAgent[agentId] || 0;
        if (now - lastTrigger < TRIGGER_COOLDOWN_MS) {
          return recordAndReturn(
            { ok: true, skipped: true, reason: 'Cooldown — triggered recently' },
            { outcome: 'skipped', reason: 'cooldown' },
          );
        }

        // Pre-flight: confirm there's actually work
        if (!hasActionableWork(store, agentId)) {
          return recordAndReturn(
            { ok: true, skipped: true, reason: 'No actionable work' },
            { outcome: 'skipped', reason: 'no-actionable-work' },
          );
        }

        // Loop detection (#1138 v2): time-based + stale-claim aware.
        const freshStore = await readStore();
        const { stalled, staleClaims, incremented } = await detectAndIncrementLoops(freshStore, agentId);

        // Stale claims: annotate (system comment) but don't pause or page.
        if (staleClaims.length > 0) {
          await annotateStaleClaims(await readStore(), agentId, staleClaims);
        }

        if (stalled.length > 0) {
          // Pause stalled tasks and send alerts instead of firing another loop
          await pauseStalledTasks(await readStore(), agentId, stalled);
          
          // Check if there's still non-paused actionable work
          const postPauseStore = await readStore();
          if (!hasActionableWork(postPauseStore, agentId)) {
            return recordAndReturn(
              { 
                ok: true, skipped: true, 
                reason: `Stall detected: ${stalled.length} task(s) paused after ${MAX_LOOPS_BEFORE_ESCALATION}+ loops`,
                paused: stalled.map(t => ({ id: t.id, title: t.title, loopCount: t.loopCount })),
              },
              { outcome: 'skipped', reason: 'stalled-paused' },
            );
          }
        }

        lastTriggerByAgent[agentId] = now;
        recordTrigger(agentId, now);

        // Dispatch task to agent's main persistent session.
        // fireOneShot returns the sessionKey iff it actually enqueued to the
        // outbox; returns undefined when buildDispatchMessage produced no
        // actionable prompt (e.g. nothing passed the dispatch filter) or when
        // enqueue itself failed. Propagate that distinction so callers (and
        // the heartbeat watchdog) can tell a real dispatch from a fizzle.
        const sessionKey = await fireOneShot(store, loop);
        if (!sessionKey) {
          return recordAndReturn(
            {
              ok: true,
              triggered: false,
              skipped: true,
              reason: 'No dispatch produced (no actionable prompt or enqueue deferred)',
            },
            { outcome: 'skipped', reason: 'no-actionable-work' },
          );
        }
        return recordAndReturn(
          { ok: true, triggered: true, method: 'dispatch', sessionKey },
          { outcome: 'dispatched' },
        );
      }

      case 'sweep': {
        // Global sweep — iterates all enabled loops and checks for orphaned/stuck work.
        // Safety net for event-driven triggers. Users call this via cron or manually.
        const sweepStartedAt = Date.now();
        const store = await readStore();
        const loops: AgentLoop[] = store.settings?.loops || [];
        const enabledLoops = loops.filter(l => l.enabled);
        const swept: { agentId: string; reason: string; triggered: boolean }[] = [];

        for (const loop of enabledLoops) {
          const agentName = getAgentName(store, loop.agentId);
          const nameLower = agentName.toLowerCase();
          const agentId = loop.agentId;

          // 1. Backlog orphans — tasks in backlog dispatch-eligible for this
          //    agent (#1112 PR 4 per-component gating + #1183 adhoc lane).
          const backlogTasks = store.tasks.filter(t => {
            const a = (t.assignee || '').toLowerCase();
            if (!(a === nameLower || a === agentId)) return false;
            if (t.status !== 'backlog') return false;
            return isTaskAnyDispatchEligible(store, t as any);
          });

          if (backlogTasks.length > 0) {
            // Pre-flight + cooldown
            const now = Date.now();
            const lastTrigger = lastTriggerByAgent[agentId] || 0;
            const cooledDown = now - lastTrigger >= TRIGGER_COOLDOWN_MS;

            if (cooledDown) {
              lastTriggerByAgent[agentId] = now;
              recordTrigger(agentId, now);
              try {
                await fireOneShot(store, loop);
                swept.push({ agentId, reason: `${backlogTasks.length} backlog orphan(s)`, triggered: true });
              } catch {
                swept.push({ agentId, reason: `${backlogTasks.length} backlog orphan(s)`, triggered: false });
              }
              continue; // one trigger per agent per sweep
            } else {
              swept.push({ agentId, reason: `${backlogTasks.length} backlog orphan(s) — cooldown`, triggered: false });
              continue;
            }
          }

          // 2. Stuck in-progress — no status update for >2 hours
          const TWO_HOURS = 2 * 60 * 60 * 1000;
          const now2 = Date.now();
          const stuckTasks = store.tasks.filter(t => {
            const a = (t.assignee || '').toLowerCase();
            if (!((a === nameLower || a === agentId) && t.status === 'in-progress')) return false;
            if (t.loopPausedAt) return false; // already paused — don't retrigger
            // Use last status change timestamp (not lastActivityAt which resets on comments)
            const lastStatusChange = t.statusHistory?.length
              ? t.statusHistory[t.statusHistory.length - 1]?.timestamp
              : t.createdAt || 0;
            return (now2 - lastStatusChange) > TWO_HOURS;
          });

          if (stuckTasks.length > 0) {
            const lastTrigger = lastTriggerByAgent[agentId] || 0;
            const cooledDown = now2 - lastTrigger >= TRIGGER_COOLDOWN_MS;

            if (cooledDown) {
              lastTriggerByAgent[agentId] = now2;
              recordTrigger(agentId, now2);
              try {
                await fireOneShot(store, loop);
                swept.push({ agentId, reason: `${stuckTasks.length} stuck in-progress task(s)`, triggered: true });
              } catch {
                swept.push({ agentId, reason: `${stuckTasks.length} stuck in-progress task(s)`, triggered: false });
              }
              continue;
            } else {
              swept.push({ agentId, reason: `${stuckTasks.length} stuck in-progress — cooldown`, triggered: false });
              continue;
            }
          }

          // #862: QA-orphan detection removed — QA tickets are owned by their assignee and follow the standard in-progress path.

          // No actionable work found for this agent
        }

        // #1187: auto-stop pass DELETED. Project state is now
        // user-controlled only — the system never flips active→inactive.
        // Spec: spec-project-model-simplification.md §Auto-stop removal.
        // The vision owner explicitly deactivates from the project page when
        // they want to pause dispatch.

        // #983 — record sweep summary + emit INFO log so silent no-op sweeps
        // are visible to operators.
        const sweepFinishedAt = Date.now();
        const triggeredCount = swept.filter((s) => s.triggered).length;
        const reasonsForLog = swept.length
          ? swept.map((s) => `${s.agentId}:${s.triggered ? 'fire' : 'skip'}(${s.reason})`).join(', ')
          : 'no-op';
        console.log(
          `[Sweep] checked=${enabledLoops.length} triggered=${triggeredCount} duration=${sweepFinishedAt - sweepStartedAt}ms reasons=[${reasonsForLog}]`,
        );
        recordSweep({
          finishedAt: sweepFinishedAt,
          durationMs: sweepFinishedAt - sweepStartedAt,
          checked: enabledLoops.length,
          triggered: triggeredCount,
          results: swept.slice(),
        });

        return NextResponse.json({ ok: true, swept });
      }

      case 'escalate-stale-backlog': {
        // #1184 phase 3 — Telegram nudge for agents whose backlog has been
        // idle ≥ 24h. Throttled to 1/agent/24h via lastEscalateByAgent.
        // Designed to be called by an external cron (or piggy-backed on the
        // existing sweep cron). Best-effort: never throws to caller.
        const thresholdMinutes = Number(body?.thresholdMinutes) || 24 * 60;
        const stale = await findStaleBacklogAgents(thresholdMinutes);
        const sent: any[] = [];
        const skipped: any[] = [];

        const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
        const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

        for (const agent of stale) {
          const last = lastEscalateByAgent[agent.agentId] || 0;
          if (Date.now() - last < 24 * 60 * 60 * 1000) {
            skipped.push({ agentId: agent.agentId, reason: 'cooldown-24h' });
            continue;
          }
          lastEscalateByAgent[agent.agentId] = Date.now();

          if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
            skipped.push({ agentId: agent.agentId, reason: 'no-telegram-config' });
            continue;
          }

          // Build a short message linking to dispatch-health.
          const lastDispatch = agent.lastDispatchAt
            ? `last dispatch: ${new Date(agent.lastDispatchAt).toLocaleString()}`
            : 'never dispatched';
          const message =
            `⏸ **Stale backlog — ${agent.agentId}**\n` +
            `${agent.backlogCount} backlog ticket(s) idle ≥ 24h. ${lastDispatch}.\n` +
            `\nGET /api/dispatch-health/${agent.agentId} for the breakdown.`;

          try {
            await fetch(
              `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  chat_id: TELEGRAM_CHAT_ID,
                  text: message,
                  parse_mode: 'Markdown',
                }),
              },
            );
            sent.push({ agentId: agent.agentId, backlogCount: agent.backlogCount });
          } catch (e: any) {
            skipped.push({ agentId: agent.agentId, reason: `send-failed: ${e?.message || e}` });
          }
        }

        return NextResponse.json({ ok: true, sent, skipped, examined: stale.length });
      }

      case 'resume': {
        // Resume a paused task — clears loopPausedAt and resets loopCount
        const { taskId } = body;
        if (!taskId) return NextResponse.json({ error: 'Missing taskId' }, { status: 400 });

        const store = await readStore();
        const idx = store.tasks.findIndex(t => t.id === taskId);
        if (idx < 0) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

        const task = store.tasks[idx];
        if (!task.loopPausedAt) {
          return NextResponse.json({ ok: true, skipped: true, reason: 'Task is not paused' });
        }

        store.tasks[idx] = {
          ...task,
          loopCount: 0,
          loopPausedAt: undefined,
          loopPauseReason: undefined,
        };

        // Add system comment
        const comments = store.tasks[idx].comments || [];
        comments.push({
          id: `sys-resume-${Date.now()}`,
          author: 'System',
          content: '✅ **Loop resumed** — loopCount reset to 0. Agent will be re-triggered on next scheduler cycle.',
          createdAt: Date.now(),
          type: 'system',
        });
        store.tasks[idx].comments = comments;
        store.tasks[idx].lastActivityAt = Date.now();

        await writeStore(store);

        // Re-trigger the agent
        const assignee = task.assignee;
        if (assignee) {
          const agentId = assignee.toLowerCase();
          const loop = getLoopByAgent(store, agentId);
          if (loop) {
            try {
              await fireOneShot(store, loop);
            } catch (e: any) {
              console.warn('resume: trigger failed:', e?.message);
            }
          }
        }

        return NextResponse.json({ ok: true, resumed: true, taskId });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (e: any) {
    const msg = typeof e === 'string' ? e : e?.message || JSON.stringify(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
