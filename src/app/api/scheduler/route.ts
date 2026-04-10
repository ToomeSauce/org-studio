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
import { buildLoopPrompt, buildDispatchMessage, clearConsumedHandoffs } from '@/lib/scheduler';
import type { AgentLoop } from '@/lib/store';
import { authenticateRequest } from '@/lib/auth';
import { getStoreProvider, type StoreData } from '@/lib/store-provider';
const DEFAULT_MODEL = 'foundry-openai-chat/gpt-5.4';

// Minimum seconds between event-driven triggers for the same agent (debounce)
const TRIGGER_COOLDOWN_MS = 60_000; // 1 minute
const lastTriggerByAgent: Record<string, number> = {};

// Loop detection: max loops on same task+status before escalation

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
 * Loop detection: increment loopCount on in-progress/QA tasks for an agent.
 * Returns tasks that have exceeded the max loop threshold (stalled).
 * 
 * A "loop" means the scheduler dispatched the agent but the task status didn't change.
 * Comments and other activity reset the counter — the agent IS making progress.
 */
const MAX_LOOPS_BEFORE_ESCALATION = 6; // raised from 3 — agents need room for complex tasks

async function detectAndIncrementLoops(store: StoreData, agentId: string): Promise<{ stalled: any[]; incremented: number }> {
  const agentName = getAgentName(store, agentId);
  const nameLower = agentName.toLowerCase();
  const stalled: any[] = [];
  let incremented = 0;

  for (let i = 0; i < store.tasks.length; i++) {
    const t = store.tasks[i];
    const assignee = (t.assignee || '').toLowerCase();
    if (!(assignee === nameLower || assignee === agentId)) continue;
    if (t.status !== 'in-progress' && t.status !== 'qa') continue;
    if (t.loopPausedAt) continue; // already paused

    // Reset loop count if agent posted a comment since last dispatch
    // (comments = progress, even without status change)
    const lastComment = (t.comments || []).filter((c: any) => 
      (c.author?.toLowerCase() === nameLower || c.author?.toLowerCase() === agentId) && c.type !== 'system'
    ).pop();
    const lastDispatchTime = t._lastDispatchedAt || 0;
    if (lastComment?.createdAt && lastComment.createdAt > lastDispatchTime) {
      store.tasks[i] = { ...t, loopCount: 0, _lastDispatchedAt: Date.now() };
      continue; // has recent activity, don't increment
    }

    const newCount = (t.loopCount || 0) + 1;
    store.tasks[i] = { ...t, loopCount: newCount, _lastDispatchedAt: Date.now() };
    incremented++;

    if (newCount >= MAX_LOOPS_BEFORE_ESCALATION) {
      stalled.push(store.tasks[i]);
    }
  }

  if (incremented > 0) {
    await writeStore(store);
  }

  return { stalled, incremented };
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

/**
 * Detailed check for actionable work. Returns what TYPE of work exists.
 * This distinction matters: an in-progress task means the agent is ALREADY working —
 * don't re-dispatch. Only backlog/QA tasks need a new dispatch.
 */
function getActionableWork(store: StoreData, agentId: string): { hasWork: boolean; hasNewWork: boolean; hasInProgress: boolean } {
  const agentName = getAgentName(store, agentId);
  const nameLower = agentName.toLowerCase();
  const agentRole = getAgentRole(store, agentId);
  const isQa = agentRole === 'qa';

  let hasInProgress = false;
  let hasNewWork = false;

  for (const t of store.tasks) {
    const assignee = (t.assignee || '').toLowerCase();
    const testAssignee = (t.testAssignee || '').toLowerCase();
    const status = (t.status || '').toLowerCase();

    // Skip paused tasks — they don't count as actionable
    if (t.loopPausedAt) continue;

    const isAssigned = assignee === nameLower || assignee === agentId;

    // In-progress: agent is already working on this
    if (isAssigned && status === 'in-progress') {
      hasInProgress = true;
      continue;
    }

    // Backlog: new work to pick up
    if (isAssigned && status === 'backlog') {
      hasNewWork = true;
    }

    // QA work: tasks in qa column assigned to this agent
    if (status === 'qa') {
      if (testAssignee === nameLower || testAssignee === agentId) { hasNewWork = true; }
      else if (isQa && isAssigned) { hasNewWork = true; }
      else {
        const qaLead = store.settings?.qaLead;
        if (qaLead === agentId && !testAssignee) { hasNewWork = true; }
      }
    }
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

// Track agents currently being dispatched to prevent duplicate sends
const inFlightAgents = new Set<string>();
const inFlightTimers = new Map<string, NodeJS.Timeout>();

// Called by runtimes when an agent finishes a task dispatch
export function clearInFlightAgent(agentId: string) {
  inFlightAgents.delete(agentId);
  const timer = inFlightTimers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    inFlightTimers.delete(agentId);
  }
  console.log(`fireOneShot: cleared in-flight for agent ${agentId} (completed)`);
}

async function fireOneShot(store: StoreData, loop: AgentLoop): Promise<string | undefined> {
  const agentName = getAgentName(store, loop.agentId);
  const agentRole = getAgentRole(store, loop.agentId);

  // Prevent duplicate dispatch if agent is already in-flight
  if (inFlightAgents.has(loop.agentId)) {
    console.log(`fireOneShot: skipping ${agentName} — already in-flight`);
    return undefined;
  }

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
  inFlightAgents.add(loop.agentId);

  // Safety timeout: clear in-flight after 30 minutes in case the completion callback never fires
  const IN_FLIGHT_TIMEOUT_MS = 30 * 60 * 1000;
  const timer = setTimeout(() => {
    inFlightAgents.delete(loop.agentId);
    inFlightTimers.delete(loop.agentId);
    console.log(`fireOneShot: cleared in-flight for ${agentName} (safety timeout)`);
  }, IN_FLIGHT_TIMEOUT_MS);
  inFlightTimers.set(loop.agentId, timer);

  try {
    const result = await sendToAgent(loop.agentId, message, {
      sessionKey,
      idempotencyKey: `dispatch-${loop.agentId}-${Date.now()}`,
      onComplete: async (completedAgentId: string) => {
        inFlightAgents.delete(completedAgentId);
        const t = inFlightTimers.get(completedAgentId);
        if (t) { clearTimeout(t); inFlightTimers.delete(completedAgentId); }
        console.log(`fireOneShot: ${agentName} task completed, cleared in-flight`);
        // Auto-dispatch next task if there's NEW work (backlog/QA), not in-progress
        // In-progress means the agent is already working — don't interrupt with a new dispatch
        try {
          const freshStore = await readStore();
          const work = getActionableWork(freshStore, loop.agentId);
          if (work.hasNewWork) {
            console.log(`fireOneShot: ${agentName} has new backlog/QA work, dispatching`);
            await fireOneShot(freshStore, loop);
          } else if (work.hasInProgress) {
            console.log(`fireOneShot: ${agentName} has in-progress work, skipping re-dispatch (agent is working)`);
          }
        } catch (e: any) {
          console.warn(`fireOneShot: auto-redispatch failed for ${agentName}:`, e.message);
        }
      },
    });
    return sessionKey;
  } catch (e: any) {
    console.error(`fireOneShot: sendToAgent failed for ${agentName}:`, e?.message || e);
    // Clear in-flight on failure so agent can be retried
    inFlightAgents.delete(loop.agentId);
    const failTimer = inFlightTimers.get(loop.agentId);
    if (failTimer) { clearTimeout(failTimer); inFlightTimers.delete(loop.agentId); }

    // Retry after delay — agent runtime may be restarting
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
        // Expects: { action: 'trigger', agentId: string }
        const { agentId } = body;
        if (!agentId) return NextResponse.json({ error: 'Missing agentId' }, { status: 400 });

        const store = await readStore();
        const loop = getLoopByAgent(store, agentId);
        if (!loop) {
          return NextResponse.json({ ok: true, skipped: true, reason: 'No enabled loop for agent' });
        }

        // Cooldown — don't fire more than once per minute per agent
        const now = Date.now();
        const lastTrigger = lastTriggerByAgent[agentId] || 0;
        if (now - lastTrigger < TRIGGER_COOLDOWN_MS) {
          return NextResponse.json({ ok: true, skipped: true, reason: 'Cooldown — triggered recently' });
        }

        // Pre-flight: confirm there's actually work
        if (!hasActionableWork(store, agentId)) {
          return NextResponse.json({ ok: true, skipped: true, reason: 'No actionable work' });
        }

        // Loop detection: increment counts and check for stalled tasks
        const freshStore = await readStore();
        const { stalled, incremented } = await detectAndIncrementLoops(freshStore, agentId);

        if (stalled.length > 0) {
          // Pause stalled tasks and send alerts instead of firing another loop
          await pauseStalledTasks(await readStore(), agentId, stalled);
          
          // Check if there's still non-paused actionable work
          const postPauseStore = await readStore();
          if (!hasActionableWork(postPauseStore, agentId)) {
            return NextResponse.json({ 
              ok: true, skipped: true, 
              reason: `Stall detected: ${stalled.length} task(s) paused after ${MAX_LOOPS_BEFORE_ESCALATION}+ loops`,
              paused: stalled.map(t => ({ id: t.id, title: t.title, loopCount: t.loopCount })),
            });
          }
        }

        lastTriggerByAgent[agentId] = now;

        // Dispatch task to agent's main persistent session
        await fireOneShot(store, loop);
        return NextResponse.json({ ok: true, triggered: true, method: 'dispatch' });
      }

      case 'sweep': {
        // Global sweep — iterates all enabled loops and checks for orphaned/stuck work.
        // Safety net for event-driven triggers. Users call this via cron or manually.
        const store = await readStore();
        const loops: AgentLoop[] = store.settings?.loops || [];
        const enabledLoops = loops.filter(l => l.enabled);
        const swept: { agentId: string; reason: string; triggered: boolean }[] = [];

        for (const loop of enabledLoops) {
          const agentName = getAgentName(store, loop.agentId);
          const nameLower = agentName.toLowerCase();
          const agentId = loop.agentId;

          // 1. Backlog orphans — tasks in backlog assigned to this agent
          const backlogTasks = store.tasks.filter(t => {
            const a = (t.assignee || '').toLowerCase();
            return (a === nameLower || a === agentId) && t.status === 'backlog';
          });

          if (backlogTasks.length > 0) {
            // Pre-flight + cooldown
            const now = Date.now();
            const lastTrigger = lastTriggerByAgent[agentId] || 0;
            const cooledDown = now - lastTrigger >= TRIGGER_COOLDOWN_MS;

            if (cooledDown) {
              lastTriggerByAgent[agentId] = now;
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

          // 3. QA orphans — tasks in QA where testAssignee matches this agent or agent is qaLead
          const qaLeadSetting = store.settings?.qaLead;
          const qaOrphans = store.tasks.filter(t => {
            if (t.status !== 'qa') return false;
            const ta = (t.testAssignee || '').toLowerCase();
            if (ta === nameLower || ta === agentId) return true;
            // If no testAssignee and this agent is the qaLead, it's theirs
            if (!ta && qaLeadSetting === agentId) return true;
            return false;
          });

          if (qaOrphans.length > 0) {
            const lastTrigger = lastTriggerByAgent[agentId] || 0;
            const cooledDown = now2 - lastTrigger >= TRIGGER_COOLDOWN_MS;

            if (cooledDown) {
              lastTriggerByAgent[agentId] = now2;
              try {
                await fireOneShot(store, loop);
                swept.push({ agentId, reason: `${qaOrphans.length} QA orphan(s)`, triggered: true });
              } catch {
                swept.push({ agentId, reason: `${qaOrphans.length} QA orphan(s)`, triggered: false });
              }
              continue;
            } else {
              swept.push({ agentId, reason: `${qaOrphans.length} QA orphan(s) — cooldown`, triggered: false });
              continue;
            }
          }

          // No actionable work found for this agent
        }

        return NextResponse.json({ ok: true, swept });
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
