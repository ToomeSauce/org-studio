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
import { authenticateRequestWithContext, requireWriteScope } from '@/lib/auth';
import { writeHeartbeat } from '@/lib/heartbeats';
import { getStoreProviderAllWorkspaces, type StoreData } from '@/lib/store-provider';
import { bounceLeaseLevel3, type BounceProvider } from '@/lib/lease-bounce';
import {
  isTaskAnyDispatchEligible,
  isTaskWaiting,
} from '@/lib/dispatch-gate';
import {
  recordDispatchAttempt,
  diagnoseAgentBacklog,
  classifyBlocker,
  findStaleBacklogAgents,
  type TriggerSource,
  type SkipReason,
} from '@/lib/dispatch-attempts';
import {
  recordTrigger,
  recordSweep,
  setTriggerCooldownMs,
} from '@/lib/scheduler-state';
// #1352 slice 5: pure decision helpers. Logic mirrors what was inlined in
// this file; importing them keeps route.ts in sync with the test suite
// (src/lib/claim-contract.test.ts) so the contract can't silently drift.
import {
  isLeaseExpired,
  classifyExpiredLease as classifyExpiredLeaseLib,
  computeEscalation,
  isDispatchBlocked,
  dispatchBlockReason,
  maxOtherTaskActivity as maxOtherTaskActivityLib,
  shouldEscalateAgainst,
} from '@/lib/claim-contract';
// #1492: lease-guard honors human STOP comments — pause counting (no warn,
// no ping, no disable, no auto-bounce) on tasks held by an authority
// (human/QA) STOP. See src/lib/stop-window.ts for the full detection spec.
import { isTaskHeldByHumanStop } from '@/lib/stop-window';
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

// Scheduler is fundamentally cross-workspace (cron-like; iterates all loops/teammates).
// TODO(#1387 A.3): split scheduler into per-workspace ticks so each workspace's
// loops/teammates run with their own scoped provider. For A.1, use the escape hatch.
async function readStore(): Promise<StoreData> {
  return await getStoreProviderAllWorkspaces().read();
}

async function writeStore(store: StoreData): Promise<void> {
  await getStoreProviderAllWorkspaces().write(store);
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
// #1352: STALE_CLAIM_COMMENT_COOLDOWN_MS removed — superseded by lease-based
// auto-bounce in sweepExpiredLeases() below. The old comment-only nudge had
// no action attached and let dead claims sit for days; the new contract
// returns the task to backlog within one tick of lease expiry. doneWhen #6
// says REMOVED, not duplicated.
// #1352: Sweep window — how recently another task touch counts as "agent
// is active elsewhere" (and therefore THIS in-progress is a forgotten
// claim). Wider than the lease window itself: an agent might have just
// posted on another task 30 min ago and still legitimately have this
// one's lease expired. 60 min matches the lease, keeping the contract
// symmetric — if you haven't touched THIS task in 60 min but touched
// something else within 60 min, that's a clean stale claim.
const STALE_OTHER_ACTIVITY_WINDOW_MS = 60 * 60 * 1000;

// #1352 slice 3: Escalation-ladder tuning.
//   - DECAY_MS: how long a stale-claim incident "counts" before resetting.
//     24h matches doneWhen #5 ("per-assignee stale_claim_count with 24h
//     decay"). An agent that has one bad day but recovers gets a clean
//     slate the next day. Long enough that repeat offenders rack up the
//     count; short enough that one-offs don't compound forever.
//   - INCREMENT_COOLDOWN_MS: minimum gap between two increments for the
//     same assignee. Without this, every scheduler tick (every ~30s for an
//     active workspace) would re-increment any task whose lease has been
//     expired for a while — a single dead task would hit Level 3 in 90
//     seconds. Tying the cooldown to the lease window (60 min) means an
//     agent gets at most one strike per lease cycle, which lines up with
//     the "hit Level 3 only after 3 distinct dead-claim incidents" intent.
//   - LEVEL_WARN / LEVEL_PING / LEVEL_DISABLE: the count thresholds.
//     1/2/3 gives the smoothest "warn → nudge → disable" UX without
//     punishing first offenders.
const STALE_COUNT_DECAY_MS = 24 * 60 * 60 * 1000;
const STALE_COUNT_INCREMENT_COOLDOWN_MS = 60 * 60 * 1000;
const LEVEL_WARN = 1;
const LEVEL_PING = 2;
const LEVEL_DISABLE = 3;

/**
 * Returns the most recent lastActivityAt across all OTHER tasks owned by
 * `assigneeLower` (i.e. excluding `excludeTaskId`). Used to detect stale
 * claims: if the agent is busy elsewhere, this task isn't a stall.
 *
 * #1352 slice 5: thin wrapper over the pure lib helper so the route file
 * still uses StoreData while tests target the pure shape. Keeping the
 * named export here so call sites elsewhere in this file don't change.
 */
function maxOtherTaskActivity(store: StoreData, assigneeLower: string, excludeTaskId: string): number {
  return maxOtherTaskActivityLib(store.tasks as any, assigneeLower, excludeTaskId);
}

async function detectAndIncrementLoops(store: StoreData, agentId: string): Promise<{ stalled: any[]; incremented: number }> {
  const agentName = getAgentName(store, agentId);
  const nameLower = agentName.toLowerCase();
  const stalled: any[] = [];
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

    // #1352: Old stale-claim arm REMOVED. The decision "agent active on
    // other tasks → it's a forgotten claim, not a stall" now lives in
    // sweepExpiredLeases() below, where it triggers an auto-bounce
    // rather than a passive comment. This branch only flags real stalls
    // (agent dispatched repeatedly, quiet across all tasks).
    stalled.push(store.tasks[i]);
  }

  if (incremented > 0) {
    await writeStore(store);
  }

  return { stalled, incremented };
}

/**
 * #1352 slice 3 — Escalation ladder for assignees who are inactive
 * everywhere (not just on the offending task). Distinct from slice 2's
 * bounce path: "moved on from this task" → bounce. "appears dead" → ladder.
 *
 * Decision tree on each tick where a task's lease has expired AND the
 * assignee has NO activity on any task within the last 60 min:
 *   - Look up teammate by name (case-insensitive against settings.teammates).
 *   - Apply 24h decay to staleClaimCount (reset to 0 if last increment
 *     older than DECAY_MS) before incrementing.
 *   - Cooldown: skip if last increment was within INCREMENT_COOLDOWN_MS.
 *     Otherwise the same dead task increments on every 30s tick.
 *   - Increment, then act on the new value:
 *     1  → warn comment on the offending task. Task stays in-progress.
 *     2  → warn comment + chat-ping to the agent's main session.
 *          Task stays in-progress (still trying to reach the agent).
 *     3+ → bounce the task (same shape as slice-2 bounce) AND stamp
 *          loopDisabledAt + loopDisableReason on the teammate. Slice 4
 *          will enforce loopDisabled in the dispatch path; for now we
 *          just set the flag and let the chat ping inform the human.
 *
 * Best-effort, never throws to the sweep caller. Logs and returns the
 * level taken (or 0 for cooldown/no-op) for observability.
 */
async function escalateInactiveClaim(
  task: any,
  assigneeName: string,
  settingsTeammates: any[],
): Promise<{ level: number; reason: 'cooldown' | 'no-teammate' | 'acted' | 'stale-skip' }> {
  const now = Date.now();
  const provider = getStoreProviderAllWorkspaces(); // scheduler: cross-workspace; TODO(#1387 A.3) split per-ws

  // #1355 idempotency guard: re-read the task from the canonical store
  // before performing any writes. Between the sweep's snapshot and now,
  // the task may have been deleted (sandbox probe cleanup), bounced by a
  // concurrent sweep tick, or moved out of in-progress by the agent.
  // If so, skip the entire escalation — no comment, no chat, no stamp.
  try {
    const freshStore = await provider.read();
    const freshTask = freshStore.tasks.find((t: any) => t.id === task.id);
    if (!shouldEscalateAgainst(freshTask)) {
      console.warn(
        `[lease-sweep #1355] Skipping escalation for task ${task.id} — ` +
        `task ${!freshTask ? 'no longer exists' : `status=${freshTask.status}`} (stale sweep snapshot).`
      );
      return { level: 0, reason: 'stale-skip' };
    }
  } catch (err: any) {
    // If re-read fails, proceed with the original snapshot — best-effort
    // guard. The escalation itself is safe (updateTask is a no-op on a
    // missing row and addComment gracefully fails).
    console.warn(`[lease-sweep #1355] Re-read guard failed: ${err?.message}. Proceeding with original snapshot.`);
  }

  const assigneeLower = assigneeName.toLowerCase();
  const teammate = settingsTeammates.find(
    (tm: any) =>
      (tm?.name || '').toLowerCase() === assigneeLower ||
      (tm?.agentId || '').toLowerCase() === assigneeLower,
  );
  // #1352 slice 5: pure decision routed through claim-contract lib.
  // Returns 'cooldown', 'no-teammate', or 'increment' with the new
  // count + level. Caller still owns the IO (provider write below).
  const decision = computeEscalation(teammate, now);
  if (decision.action === 'no-teammate') return { level: 0, reason: 'no-teammate' };
  if (decision.action === 'cooldown') return { level: 0, reason: 'cooldown' };
  const newCount = decision.newCount;

  try {
    const allTeammates = settingsTeammates.map((tm: any) =>
      tm === teammate
        ? {
            ...tm,
            staleClaimCount: newCount,
            staleClaimCountedAt: now,
            ...(decision.reachedDisable
              ? {
                  loopDisabledAt: now,
                  loopDisableReason:
                    `Auto-disabled after ${newCount} stale-claim incidents within 24h ` +
                    `(latest: task "${task.title}" #${task.ticketNumber || '?'}). ` +
                    `Clear loopDisabledAt on agent start or via Team page to re-enable.`,
                }
              : {}),
          }
        : tm,
    );
    await provider.updateSettings({ teammates: allTeammates });
  } catch (err: any) {
    console.warn(`[lease-sweep #1352] failed to bump staleClaimCount for ${assigneeName}: ${err?.message || err}`);
    return { level: 0, reason: 'cooldown' };
  }

  const leaseExpiredAt = task.claim_lease_expires_at;
  const lastActivity = task.lastActivityAt || task.claim_started_at || 0;
  const baseMsg =
    `Lease expired at ${new Date(leaseExpiredAt).toISOString()}; ` +
    `last activity on this task was ${lastActivity ? new Date(lastActivity).toISOString() : '(never)'}. ` +
    `Assignee **${assigneeName}** has no activity on any task within the last 60 min.`;

  try {
    await provider.addComment(
      { kind: 'task', taskId: task.id },
      {
        id: `sys-stale-${now}-${task.id}`,
        author: 'System',
        content:
          `⚠️ **Stale claim — Level ${newCount}** ` +
          (newCount === LEVEL_WARN
            ? `(warn).\n\n${baseMsg}\n\nNo action taken yet — task remains in-progress in case the agent returns. Next strike escalates.`
            : newCount === LEVEL_PING
              ? `(topic ping).\n\n${baseMsg}\n\nPinging the agent's main session. One more strike auto-bounces this task and disables the agent's dispatch loop.`
              : `(loop disabled + auto-bounce).\n\n${baseMsg}\n\nAgent loop has been disabled and this task is being returned to backlog. Clear loopDisabledAt on the teammate to re-enable dispatch.`),
        createdAt: now,
        type: 'system',
      },
    );
  } catch (err: any) {
    console.warn(`[lease-sweep #1352] failed to post Level ${newCount} warn comment: ${err?.message || err}`);
  }

  if (newCount >= LEVEL_PING) {
    try {
      const agentId = teammate.agentId || teammate.name?.toLowerCase() || assigneeLower;
      await rpc('chat.send', {
        sessionKey: `agent:${agentId}:main`,
        message:
          `⚠️ **Stale-claim escalation — Level ${newCount}**\n\n` +
          `Task: "${task.title}" (#${task.ticketNumber || '?'})\n` +
          `${baseMsg}\n\n` +
          (newCount >= LEVEL_DISABLE
            ? `Your dispatch loop has been **auto-disabled** and the task returned to backlog. ` +
              `Clear \`loopDisabledAt\` on your teammate record (Team page) to re-enable.`
            : `One more incident within 24h auto-disables your dispatch loop and bounces the task.`),
        idempotencyKey: `stale-claim-${task.id}-${now}`,
      });
    } catch (err: any) {
      console.warn(`[lease-sweep #1352] chat.send ping failed for ${assigneeName} (Level ${newCount}): ${err?.message || err}`);
    }
  }

  if (newCount >= LEVEL_DISABLE) {
    // #1493 — Level 3 auto-bounce write reliability. See src/lib/lease-bounce.ts
    // for the rationale, contract, and unit tests. Pre-#1493: single write,
    // no verification, swallowed error → silent state-loss on #1487.
    // Post-#1493: re-read → write → read-back verify → retry once → activity
    // feed event on hard-fail.
    const feedSink = (globalThis as any).__orgStudioActivityFeed || null;
    await bounceLeaseLevel3(
      provider as BounceProvider,
      {
        id: task.id,
        title: task.title,
        ticketNumber: task.ticketNumber,
        projectId: task.projectId,
      },
      assigneeName,
      now,
      { feedSink },
    );
  }

  return { level: newCount, reason: 'acted' };
}

/**
 * #1352: Auto-bounce sweep — replaces the old annotateStaleClaims() generator.
 *
 * Runs once per scheduler tick (before per-agent loop detection). Scans every
 * in-progress task; for each one whose claim_lease_expires_at is past AND
 * whose assignee has touched ANOTHER task within the last 60min, returns
 * the task to backlog and clears the assignee. Posts a system comment with
 * the lease + last-activity timestamps for audit.
 *
 * What changed vs. the old generator (doneWhen #6 — REMOVED, not duplicated):
 *   1. Decision input: lease expiry (deterministic) rather than loopCount
 *      threshold + quiet-window heuristic (fuzzy). 60 min is the
 *      Basil-confirmed window from slice 1.
 *   2. Outcome: actual bounce (status → backlog, assignee cleared) instead
 *      of a passive comment that anyone could ignore. The old plumbing let
 *      dead claims sit for days; this catches them within one tick.
 *   3. Scope: whole-store sweep, not per-agent. Even agents whose own
 *      schedulers never tick get their dead claims caught.
 *   4. Idempotency: by the time the task is in backlog with no assignee,
 *      next sweep doesn't even consider it (status !== 'in-progress' guard).
 *
 * Assignee-inactive-everywhere path is HANDLED IN slice 3 (escalation
 * ladder). This function only handles the "alive but moved on" case;
 * stalled-everywhere agents still flow through pauseStalledTasks().
 *
 * Best-effort: never throws to caller. Returns counts for observability.
 */
async function sweepExpiredLeases(store: StoreData): Promise<{ bounced: number; skippedInactive: number; escalated: number }> {
  const now = Date.now();
  let bounced = 0;
  let skippedInactive = 0;
  let escalated = 0;
  const provider = getStoreProviderAllWorkspaces(); // scheduler: cross-workspace; TODO(#1387 A.3) split per-ws

  for (let i = 0; i < store.tasks.length; i++) {
    const t = store.tasks[i];
    // #1352 slice 5: lease-expiry classification routed through claim-contract
    // lib. Same predicate as before (status==='in-progress' && !loopPausedAt
    // && claim_lease_expires_at && now > stamp), just centralized for testing.
    if (!isLeaseExpired(t as any, now)) continue;

    // #1492: STOP-window short-circuit. If the task is currently held by
    // a human/QA STOP directive (per src/lib/stop-window.ts), the lease
    // guard does NOT escalate against it — no warn, no ping, no disable,
    // no auto-bounce. The lease clock effectively pauses for the duration
    // of the hold. Best-effort: any error here returns held=false so the
    // sweep falls through to normal classification (fail open).
    try {
      const settingsTeammates = store.settings?.teammates || [];
      let taskComments: any[] = [];
      // Local-bind so TS narrows past the optional-method check; #1495 stale-warning fix.
      const listCommentsFn = (provider as any).listComments as
        | ((scope: any, opts: any) => Promise<any[]>)
        | undefined;
      if (typeof listCommentsFn === 'function') {
        taskComments = (await listCommentsFn(
          { kind: 'task', taskId: t.id } as any,
          { limit: 50 },
        )) as any[];
      } else {
        // Fallback: provider doesn't support listComments (legacy in-memory
        // mode). Use the inline task.comments array if present.
        taskComments = ((t as any).comments || []) as any[];
      }
      const hold = isTaskHeldByHumanStop(
        { id: t.id, assignee: t.assignee },
        taskComments || [],
        settingsTeammates as any[],
      );
      if (hold.held) {
        console.warn(
          `[lease-sweep #1492] Skipping escalation for task ${t.id} — ` +
          `held by STOP from ${hold.stopAuthor || '?'} (${hold.reason}).`,
        );
        skippedInactive++;
        continue;
      }
    } catch (err: any) {
      // Fail open — don't let listComments hiccups disable the lease guard.
      console.warn(
        `[lease-sweep #1492] STOP-window check failed for task ${t.id}: ` +
        `${err?.message || err}; continuing with normal escalation.`,
      );
    }

    // Classification: bounce-only (active elsewhere) vs escalation-ladder
    // (inactive everywhere) vs no-assignee (always bounce). Mirrors the
    // inline logic that was here before and keeps the lib helper honest.
    const classification = classifyExpiredLeaseLib(t as any, store.tasks as any, now);

    if (classification === 'escalate') {
      const settingsTeammates = store.settings?.teammates || [];
      const assigneeLower = (t.assignee || '').toLowerCase();
      const result = await escalateInactiveClaim(t, t.assignee || assigneeLower, settingsTeammates);
      if (result.reason === 'acted') {
        if (result.level >= LEVEL_DISABLE) bounced++;
        escalated++;
      }
      skippedInactive++;
      continue;
    }
    // classification === 'bounce' or 'no-assignee' — fall through to the
    // existing bounce code below.

    // #1355 idempotency guard: re-read before bounce write (same pattern
    // as escalateInactiveClaim above).
    try {
      const freshStore = await provider.read();
      const freshTask = freshStore.tasks.find((ft: any) => ft.id === t.id);
      if (!shouldEscalateAgainst(freshTask)) {
        console.warn(
          `[lease-sweep #1355] Skipping bounce for task ${t.id} — ` +
          `task ${!freshTask ? 'no longer exists' : `status=${freshTask.status}`}.`
        );
        continue;
      }
    } catch { /* best-effort guard; proceed on failure */ }

    const leaseExpiredAt = t.claim_lease_expires_at;
    const lastActivity = t.lastActivityAt || t.claim_started_at || 0;
    const formerAssignee = t.assignee || '(unassigned)';

    const history = (t.statusHistory || []).concat([
      { status: 'backlog', timestamp: now, by: 'System (lease-bounce)' },
    ]);

    // #1352: write per-task via the targeted provider API rather than a
    // whole-store DELETE+INSERT writeStore() call. The whole-store path
    // races with concurrent scheduler triggers and trips
    // org_studio_projects_pkey under load. updateTask + addComment use
    // single-row UPDATEs and are safe to call from any tick.
    try {
      await provider.updateTask(t.id, {
        status: 'backlog',
        assignee: '',
        claim_started_at: null,
        claim_lease_expires_at: null,
        loopCount: 0,
        _lastDispatchedAt: null,
        statusHistory: history,
        lastActivityAt: now,
      });
      await provider.addComment(
        { kind: 'task', taskId: t.id },
        {
          id: `sys-lease-bounce-${now}-${t.id}`,
          author: 'System',
          content:
            `⏱️ **Claim lease expired — auto-bounced to backlog.**\n\n` +
            `Lease expired at ${new Date(leaseExpiredAt).toISOString()}; ` +
            `last activity on this task was ${lastActivity ? new Date(lastActivity).toISOString() : '(never)'}. ` +
            `Former assignee: **${formerAssignee}** (still active on other tasks within 60 min — likely moved on).\n\n` +
            `Anyone can pick this back up by claiming it.`,
          createdAt: now,
          type: 'system',
        },
      );
      bounced++;
    } catch (err: any) {
      console.warn(`[lease-sweep #1352] bounce failed for task ${t.id}: ${err?.message || err}`);
      // continue — best-effort, don't let one failure abort the sweep
    }
  }

  return { bounced, skippedInactive, escalated };
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
//   Rule 3: task.version is in component.approvedVersions[] (#1224 set-membership)
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
      // #1387 A.3: scheduler today reads all workspaces' loops as a single
      // cross-workspace pool (`getStoreProviderAllWorkspaces()`). Until the
      // multi-workspace scheduler split lands (separate sub-slice), the loop
      // doesn't carry its source workspace_id; route the resulting outbox row
      // to 'default-workspace' so it matches today's single-workspace
      // production behaviour. Replacing the hardcode inside outbox.ts itself
      // (which had no workspace context at all) is the actual A.3 win.
      workspaceId: 'default-workspace',
    });

    // Write heartbeat after successful enqueue
    try {
      await writeHeartbeat({
        agentId: loop.agentId,
        loopId: loop.id,
        status: 'firing',
        // #1387 A.3: scheduler is cross-workspace today; threading the loop's
        // workspace will land with the multi-workspace scheduler split.
        workspaceId: 'default-workspace',
      });
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
  const authCtx = await authenticateRequestWithContext(request);
  if (authCtx.error) return authCtx.error;
  const scopeFail = requireWriteScope(authCtx.context);
  if (scopeFail) return scopeFail;

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

        // #1352 slice 4 — stale-claim auto-disable enforcement.
        // If the assignee's teammate record has loopDisabledAt set (stamped
        // by the Level-3 escalation in sweepExpiredLeases()), refuse to
        // dispatch. The flag is reversible by:
        //   (a) clicking 'Re-enable loop' on the Team page (clears the
        //       field via updateSettings), OR
        //   (b) the agent starting fresh — the gateway-agents WS broadcast
        //       in server.mjs hits the /api/runtimes endpoint, which on
        //       agent re-discovery clears loopDisabledAt automatically.
        //       (Implemented below in this same slice.)
                const teammates = store.settings?.teammates || [];
        const teammate = teammates.find(
          (tm: any) => (tm?.agentId || '').toLowerCase() === agentId.toLowerCase(),
        );
        // #1352 slice 5: routed through claim-contract lib so the test suite
        // and the route agree on what 'blocked' means.
        if (isDispatchBlocked(teammate)) {
          return recordAndReturn(
            {
              ok: true,
              skipped: true,
              reason: dispatchBlockReason(teammate),
              loopDisabledAt: teammate.loopDisabledAt,
            },
            { outcome: 'skipped', reason: 'stale-claim-disabled' },
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

        // #1352 slice 2 — Auto-bounce sweep. Runs ONCE per tick, before
        // per-agent loop detection, against the whole store. Dead claims
        // get returned to backlog within one tick of lease expiry; the
        // bounced tasks are then visible to anyone (including a fresh
        // dispatch to this very agent) on the next read. Best-effort —
        // any failure here must NOT block the dispatch path below.
        try {
          const sweepStore = await readStore();
          const sweepResult = await sweepExpiredLeases(sweepStore);
          if (sweepResult.bounced > 0 || sweepResult.skippedInactive > 0 || sweepResult.escalated > 0) {
            console.info(
              `[lease-sweep #1352] tick swept: bounced=${sweepResult.bounced}, ` +
                `escalated=${sweepResult.escalated}, skippedInactive=${sweepResult.skippedInactive}`,
            );
          }
        } catch (sweepErr: any) {
          console.warn('[lease-sweep #1352] failed (non-fatal):', sweepErr?.message || sweepErr);
        }

        // Loop detection (#1138 v2): time-based stall detection only.
        // (Old stale-claim arm replaced by sweepExpiredLeases above — #1352.)
        const freshStore = await readStore();
        const { stalled, incremented } = await detectAndIncrementLoops(freshStore, agentId);

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

      case 'diagnose': {
        // #1194 — Public read-only wrapper around diagnoseAgentBacklog().
        // Use this when debugging dispatch issues: "why isn't agent X picking up
        // task Y?". Returns the same shape used internally by the trigger path,
        // plus a per-task breakdown so callers can act on individual tickets.
        // Expects: { action: 'diagnose', agentId: string }
        const { agentId } = body;
        if (!agentId) return NextResponse.json({ error: 'Missing agentId' }, { status: 400 });

        const store = await readStore();
        const agentName = getAgentName(store, agentId);
        const diag = diagnoseAgentBacklog(store, agentId, agentName);

        // Per-task breakdown — useful for "which specific tickets are stuck and why".
        const nameLower = (agentName || '').toLowerCase();
        const idLower = (agentId || '').toLowerCase();
        const myBacklog = (store.tasks || []).filter((t: any) => {
          const a = (t.assignee || '').toLowerCase();
          return (a === nameLower || a === idLower) && t.status === 'backlog';
        });
        const perTask = myBacklog.map((t: any) => {
          const eligible = isTaskAnyDispatchEligible(store as any, t);
          return {
            id: t.id,
            ticketNumber: t.ticketNumber,
            title: t.title,
            projectId: t.projectId,
            version: t.version || null,
            sectionId: t.sectionId || null,
            taskType: t.taskType || null,
            eligible,
            blocker: eligible ? null : classifyBlocker(store as any, t),
          };
        });

        return NextResponse.json({
          ok: true,
          agentId,
          agentName,
          summary: diag,
          perTask,
        });
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
