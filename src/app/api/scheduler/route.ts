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
import { buildDispatchMessage, clearConsumedHandoffs } from '@/lib/scheduler';
import type { AgentLoop } from '@/lib/store';
import { authenticateRequestWithContext, requireWriteScope } from '@/lib/auth';
import { writeHeartbeat } from '@/lib/heartbeats';
import {
  recordDispatch,
  type DispatchOutcome as LedgerOutcome,
} from '@/lib/dispatch-ledger';
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
// #1526 — Request-scoped store-read memoization for `case 'trigger'`.
// Lets the trigger handler share one cached snapshot across the read-only
// stretch (top → cooldown → loop lookup → actionable-work check →
// pre-sweep) while still calling `.refresh()` between mutations so the
// #1515 freshness contract holds. Only wired into the trigger case for
// now — sync/runNow/disable do interleaved write→read inside loops where
// memoization is unsafe. See ticket #1526 for the audit table.
import { createMemoizedStoreReader } from '@/lib/memoized-store-reader';
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
import {
  planStewardSweep,
  buildOwnerNudge,
  buildHumanSummary,
  NUDGE_COOLDOWN_MS,
  type StewardTaskLike,
} from '@/lib/domain-steward';
import {
  planProposeSweep,
  buildProposeNextPrompt,
  PROPOSE_COOLDOWN_MS,
  type DoneUnmetVersionLike,
} from '@/lib/done-but-unmet';
import { validateMetricSource, pollMetricSource } from '@/lib/metric-source';
import { searchMemory } from '@/lib/embedding/search';
import { enrichStewardNudge, enrichProposePrompt, type MemoryHit } from '@/lib/embedding/precedent';
// #1633 — push-based dispatch policy (enable/runNow/sync no longer create heavy crons).
import { planEnable, planRunNow, planSync } from '@/lib/scheduler-dispatch-policy';

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

/**
 * #1497 — targeted settings write that avoids the full-store DELETE+INSERT race.
 *
 * Background: `writeStore()` calls `PostgresStoreProvider.write()` which does
 * `BEGIN; DELETE FROM org_studio_tasks; INSERT (every task from in-memory snapshot); COMMIT`.
 * That is a classic read-modify-write race against EVERY concurrent task write: if
 * an updateTask flip-to-done lands between this routes `readStore()` and
 * `writeStore()`, our COMMITs DELETE wipes the just-landed done and INSERTs the
 * pre-state back. Both writes return ok:true; the slower COMMIT silently wins.
 *
 * Most `writeStore()` calls in this file only mutate `store.settings.loops`
 * (loop config, cronJobId, lastRun). For those, we route through the provider
 * `updateSettings()` which does a row-level UPSERT on `org_studio_settings` and
 * doesnt touch `org_studio_tasks` at all — eliminating the race against task
 * writes entirely. Settings writes still have a narrow internal race with
 * concurrent settings mutations (read-modify-write), but those are rare (loop
 * enable/disable, cron resync) and bounded to settings fields, so they do not
 * cause cross-domain silent loss of task state.
 *
 * Use `writeLoops()` instead of `writeStore()` whenever the only mutation is
 * to `store.settings.loops`. For mutations that touch tasks, use targeted
 * `provider.updateTask(taskId, ...)` instead of a full rewrite.
 */
async function writeLoops(store: StoreData): Promise<void> {
  const loops = store.settings?.loops || [];
  await getStoreProviderAllWorkspaces().updateSettings({ loops });
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
  // #1497: track per-task field updates so we can do targeted UPDATEs at the
  // end instead of a full-store DELETE+INSERT (which races with task writes).
  const taskFieldUpdates: Array<{ id: string; updates: Record<string, any> }> = [];

  // #1524: bulk-fetch comments once for every in-progress task owned by
  // this agent, so the inner loop avoids N+1 listComments calls and we
  // stop reading the soon-to-be-removed inline `task.comments[]` blob.
  // Falls back to the inline blob on provider error / file-provider mode.
  let commentsByTask: Map<string, any[]> = new Map();
  try {
    const provider = getStoreProviderAllWorkspaces() as any;
    if (typeof provider.listCommentsForTasks === 'function') {
      const candidateIds = store.tasks
        .filter((t: any) => {
          const assignee = (t.assignee || '').toLowerCase();
          return (assignee === nameLower || assignee === agentId)
            && t.status === 'in-progress'
            && !t.loopPausedAt;
        })
        .map((t: any) => t.id);
      if (candidateIds.length > 0) {
        commentsByTask = await provider.listCommentsForTasks(candidateIds);
      }
    }
  } catch (err: any) {
    console.warn(
      `[detectAndIncrementLoops #1524] bulk listCommentsForTasks failed; ` +
      `falling back to inline blob: ${err?.message || err}`,
    );
  }

  for (let i = 0; i < store.tasks.length; i++) {
    const t = store.tasks[i];
    const assignee = (t.assignee || '').toLowerCase();
    if (!(assignee === nameLower || assignee === agentId)) continue;
    if (t.status !== 'in-progress') continue;
    if (t.loopPausedAt) continue; // already paused

    // Reset loop count if agent posted a non-system comment since last dispatch
    // (comments = progress, even without status change)
    // #1524: prefer the bulk-fetched comments map (from
    // listCommentsForTasks); fall back to the inline blob for legacy mode.
    const commentsForTask = commentsByTask.get(t.id) ?? (t.comments || []);
    const lastComment = (commentsForTask as any[]).filter((c: any) =>
      (c.author?.toLowerCase() === nameLower || c.author?.toLowerCase() === agentId) && c.type !== 'system'
    ).pop();
    const lastDispatchTime = t._lastDispatchedAt || 0;
    if (lastComment?.createdAt && lastComment.createdAt > lastDispatchTime) {
      store.tasks[i] = { ...t, loopCount: 0, _lastDispatchedAt: now };
      taskFieldUpdates.push({ id: t.id, updates: { loopCount: 0, _lastDispatchedAt: now } });
      continue; // has recent activity, don't increment
    }

    const newCount = (t.loopCount || 0) + 1;
    store.tasks[i] = { ...t, loopCount: newCount, _lastDispatchedAt: now };
    taskFieldUpdates.push({ id: t.id, updates: { loopCount: newCount, _lastDispatchedAt: now } });
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
    // #1497: targeted per-task UPDATEs replace the full-store DELETE+INSERT race.
    // Each updateTask is a row-level UPDATE that doesnt touch other tasks rows.
    const provider = getStoreProviderAllWorkspaces();
    for (const u of taskFieldUpdates) {
      try { await provider.updateTask(u.id, u.updates); }
      catch (e: any) { console.warn(`[detectAndIncrementLoops #1497] updateTask failed for ${u.id}:`, e?.message || e); }
    }
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
  // #1497: targeted per-task UPDATEs + addComment via the provider instead of
  // mutating the in-memory snapshot and then full-store rewriting. Eliminates
  // the race where this writeStore() would wipe out concurrent updateTask
  // flips landed between our readStore() and writeStore().
  const provider = getStoreProviderAllWorkspaces();

  for (const task of stalledTasks) {
    const idx = store.tasks.findIndex(t => t.id === task.id);
    if (idx < 0) continue;

    // Mark as paused (snapshot mirror still updated so any downstream uses of
    // `store` in this tick see consistent state — actual persistence is the
    // targeted provider call below).
    const reason = `Agent "${agentName}" ran ${task.loopCount} scheduler loops on this task without changing status. Pausing to prevent further resource waste.`;
    store.tasks[idx] = {
      ...store.tasks[idx],
      loopPausedAt: now,
      loopPauseReason: reason,
      lastActivityAt: now,
    };

    try {
      await provider.updateTask(task.id, {
        loopPausedAt: now,
        loopPauseReason: reason,
        lastActivityAt: now,
      });
    } catch (e: any) {
      console.warn(`[pauseStalledTasks #1497] updateTask failed for ${task.id}:`, e?.message || e);
    }

    // Add system comment via the targeted addComment path (writes to normalized
    // comments table; no full-store rewrite).
    try {
      await provider.addComment(
        { kind: 'task', taskId: task.id },
        {
          id: `sys-stall-${now}-${task.id}`,
          author: 'System',
          content: `⚠️ **Loop Detection — Agent Paused**\n\n${reason}\n\nTo resume: clear the pause via the task detail panel or move the task to a different status.`,
          createdAt: now,
          type: 'system',
        },
      );
    } catch (e: any) {
      console.warn(`[pauseStalledTasks #1497] addComment failed for ${task.id}:`, e?.message || e);
    }

    // Send Telegram alert
    try {
      // #1529: this function is called with a slim store (no `title`).
      // Fetch the full row just for the alert. Stalled tasks are rare
      // (typically 0 per tick); the extra round-trip is acceptable.
      let alertTitle: string = task.title;
      if (!alertTitle && typeof (provider as any).getTaskFull === 'function') {
        try {
          const full = await (provider as any).getTaskFull(task.id);
          alertTitle = full?.title || `(no title — task ${task.id})`;
        } catch {
          alertTitle = `(title unavailable — task ${task.id})`;
        }
      }
      const sessionKey = `agent:main:main`; // Route via main agent for Telegram delivery
      await rpc('chat.send', {
        sessionKey,
        message: `⚠️ **Stall Alert — ${agentName}**\n\nTask: "${alertTitle}" (#${task.ticketNumber || '?'})\nLoops: ${task.loopCount} without progress\nStatus: ${task.status}\n\nAgent loop paused. Manual review needed.`,
        idempotencyKey: `stall-${task.id}-${now}`,
      });
    } catch (e: any) {
      console.error(`Failed to send stall alert for task ${task.id}:`, e?.message || e);
    }
  }
  // #1497: no writeStore() — each task was persisted individually via provider.updateTask/addComment above.
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
      headers: {
        'Content-Type': 'application/json',
        // /api/gateway now enforces auth (write scope) after the 2026.5.28
        // security tightening. Without this internal Bearer the call 401s,
        // res.ok is false, and EVERY scheduler enable/sync wrongly reports
        // NO_GATEWAY — which silently stopped per-agent dispatch crons from
        // ever being (re)created. Use the same internal key the route uses
        // for its other server-to-server calls.
        Authorization: `Bearer ${process.env.ORG_STUDIO_API_KEY || ''}`,
      },
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
import { setInFlightAgent, clearInFlightAgent as bridgeClearInFlight, isInFlight, getInFlightAgents } from '@/lib/runtimes/scheduler-bridge';

// Re-export for backward compat
export function clearInFlightAgent(agentId: string) {
  bridgeClearInFlight(agentId);
}

/**
 * #1521 — Tagged dispatch source. Threads from each `fireOneShot` call
 * site to the in-function diagnostic line so we can attribute a stale
 * dispatch to a specific path:
 *   primary       — case 'trigger' in this route (event-driven, addTask,
 *                   watchdog, manual press; all funnel through this path).
 *   watchdog      — reserved for future direct invocation (today the
 *                   watchdog hits `case 'trigger'`, so it's tagged
 *                   'primary'). Kept in the union so a future direct call
 *                   site doesn't fall back to silent 'manual'.
 *   sweep         — periodic sweep loops (backlog-orphan, stuck-in-progress).
 *   cron-retry    — inline retry after enqueueOutbox failure.
 *   cron-fallback — fallback when an existing cron job is missing.
 *   resume        — re-trigger after a comment-driven resume.
 *   manual        — explicit human/CLI trigger of fireOneShot.
 */
type FireOneShotSource =
  | 'primary'
  | 'watchdog'
  | 'sweep'
  | 'cron-retry'
  | 'cron-fallback'
  | 'resume'
  | 'manual';

async function fireOneShot(
  _staleStore: StoreData,
  loop: AgentLoop,
  source: FireOneShotSource = 'manual',
): Promise<string | undefined> {
  // #1521 — ALWAYS re-read the store right before composing the dispatch
  // message. The caller's `_staleStore` argument is intentionally ignored:
  // we keep the parameter to avoid churning 7 call sites in this PR, but
  // the fresh snapshot below is the only one we feed to buildDispatchMessage.
  //
  // Why: prior to this refactor, only the primary `case 'trigger'` path
  // re-read the store (the #1515 fix from 2026-05-21). The other 6 call
  // sites (cron-retry, cron-fallback, sweep×2, resume, manual retries)
  // passed whatever stale `store` snapshot was sitting in scope from
  // many seconds earlier. The diagnostic was also outside the function,
  // so a stale-snapshot dispatch from a non-primary path produced no
  // `[dispatch #1515]` log line — making the bug invisible by
  // construction. Pushing both the freshness re-read AND the diagnostic
  // INSIDE this function means every path benefits, every path is logged.
  // #1534 — SLIM dispatch read.
  //
  // Pre-#1534, this was `const store = await readStore()` which fetched
  // ALL rows with ALL columns (3.2 MB, 470–880 ms p95 steady-state, then
  // climbing as the task table grew). buildDispatchMessage only needs
  // prompt-construction text fields (title/description/doneWhen/
  // constraints/testPlan/devHandoff) on the dispatch target agent's
  // tasks — typically 5–20 rows out of ~1400. Every other task it
  // touches (cross-agent dispatch-gate signal, project lookups, settings)
  // only needs the slim shape.
  //
  // So: slim-read for projects/settings/cross-agent gate signal +
  // per-agent full-fetch for this agent's prompt-construction fields,
  // then splice the full rows back into store.tasks so the in-place
  // bucket filters in buildDispatchMessage see them.
  //
  // Expected wire footprint: 3.2 MB → ~900 KB + ~50 KB. p95 readMs:
  // 600 ms → ~80–120 ms.
  //
  // Reversibility (per ticket constraint): single git revert restores
  // the full readStore() call — the merge step is the only structural
  // change; the rest of fireOneShot is untouched.
  const readStartedAt = Date.now();
  const provider = getStoreProviderAllWorkspaces() as any;
  const slimStore = (typeof provider.readSlim === 'function'
    ? await provider.readSlim()
    : await readStore()) as StoreData;

  // Resolve agent name BEFORE the per-agent fetch (matcher requires both).
  const agentName = getAgentName(slimStore, loop.agentId);

  // Per-agent full-row fetch. Optional on FileStoreProvider; fall back
  // to the slim rows already in scope (file mode has the full text in
  // them already — file readSlim() === read()).
  const fullAgentTasks: any[] = typeof provider.getTasksForAgent === 'function'
    ? await provider.getTasksForAgent(agentName, loop.agentId)
    : [];

  // Merge: replace any slim row whose id matches a full row, keep all
  // others (other agents' tasks stay slim — dispatch-gate signal works
  // off status/projectId/sectionId/version which slim already has).
  // Iteration order preserved (Map keyed by id) so buildDispatchMessage's
  // ORDER-BY-created_at-ASC bucket lists stay stable.
  const store: StoreData =
    fullAgentTasks.length > 0
      ? (() => {
          const fullById = new Map(fullAgentTasks.map((t: any) => [t.id, t]));
          const mergedTasks = (slimStore.tasks || []).map((t: any) =>
            fullById.has(t.id) ? fullById.get(t.id) : t,
          );
          return { ...slimStore, tasks: mergedTasks };
        })()
      : slimStore;

  const readMs = Date.now() - readStartedAt;

  const agentRole = getAgentRole(store, loop.agentId);

  // #1521 — fingerprint actionable / awareness-only ticket states for
  // this agent at the snapshot we're about to dispatch from. Cheap;
  // computed once per dispatch.
  const nameLower = (agentName || '').toLowerCase();
  const agentIdLower = (loop.agentId || '').toLowerCase();
  const agentTicketStatuses = (store.tasks || [])
    .filter((t: any) => {
      const a = (t.assignee || '').toLowerCase();
      if (!(a === nameLower || a === agentIdLower) || t.isArchived) return false;
      // 'done'/'planning' aren't dispatched so they're noise here.
      return ['in-progress', 'backlog', 'qa', 'blocked'].includes(t.status);
    })
    .map((t: any) => `${t.ticketNumber ?? '?'}:${t.status}`)
    .slice(0, 20)
    .join(',');
  console.info(
    `[dispatch #1515 src=${source}] agent=${loop.agentId} ` +
      `readMs=${readMs} tickets=[${agentTicketStatuses}]`,
  );

  // #1641 — ledger writes are fire-and-forget; capture the shared fields
  // once so every outcome branch below records with identical context.
  const ledgerBase = {
    agentId: loop.agentId,
    source,
    readMs,
    ticketFingerprint: agentTicketStatuses,
    concurrentDispatchCount: getInFlightAgents().length,
  };

  // Prevent duplicate dispatch if agent is already in-flight
  if (isInFlight(loop.agentId)) {
    console.log(`[Dispatch src=${source}] skipping ${agentName} — already in-flight`);
    recordDispatch({ ...ledgerBase, outcome: 'skipped-in-flight' as LedgerOutcome });
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
    recordDispatch({ ...ledgerBase, outcome: 'no-work' as LedgerOutcome });
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

    // #1641 — ledger row keyed by idempotencyKey so the outbox-drain
    // completion callback can close it out (duration_ms).
    recordDispatch({
      ...ledgerBase,
      dispatchId: idempotencyKey,
      outcome: 'enqueued' as LedgerOutcome,
    });

    return sessionKey;
  } catch (e: any) {
    console.error(`fireOneShot: enqueueOutbox failed for ${agentName}:`, e?.message || e);
    recordDispatch({
      ...ledgerBase,
      outcome: 'enqueue-failed' as LedgerOutcome,
      triggerReason: String(e?.message || e).slice(0, 200),
    });
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
          await fireOneShot(freshStore, freshLoop, 'cron-retry');
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

        // #1633 — push-based dispatch: enabling a loop NO LONGER creates a
        // recurring `Scheduler: <agent>` cron with a full agentTurn payload
        // (the old heavyweight LLM loop tax). Dispatch is event-driven: the
        // store route calls `{ action: 'trigger', agentId }` when work lands
        // in backlog, and `fireOneShot` pushes a focused message. That path
        // keys off `loop.enabled`, NOT `cronJobId`, so enabling is now just a
        // flag flip. We also clear any stale cronJobId so a later `sync` won't
        // think there's a live heavy cron to reconcile.
        //
        // No gateway check is required to enable — the event `trigger` path
        // does its own gateway/outbox handling at dispatch time. Removing the
        // gateway gate also means enabling a loop never 503s just because the
        // runtime is momentarily unreachable.
        const { setEnabled } = planEnable();
        updateLoopInStore(store, loopId, { enabled: setEnabled, cronJobId: undefined });
        await writeLoops(store); // #1497: targeted settings write, not full-store rewrite

        return NextResponse.json({ ok: true, mode: 'push', dispatch: 'event-driven' });
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
        await writeLoops(freshStore); // #1497: targeted settings write

        return NextResponse.json({ ok: true });
      }

      case 'runNow': {
        if (!loopId) return NextResponse.json({ error: 'Missing loopId' }, { status: 400 });

        const store = await readStore();
        const loop = getLoop(store, loopId);
        if (!loop) return NextResponse.json({ error: 'Loop not found' }, { status: 404 });

        // #1633 — manual trigger ALWAYS fires a direct one-shot via the same
        // push path the event-driven dispatcher uses. We no longer route
        // through `cron.run` on a recurring `Scheduler:` job (those heavy crons
        // are being removed). `fireOneShot` re-reads the store, builds a
        // focused dispatch message, and enqueues to the outbox — so this works
        // whether or not any cron job exists. If a stale cronJobId is still on
        // the loop, opportunistically clear it so `sync` has nothing to chase.
        const { fireOneShot: shouldFire } = planRunNow();
        if (shouldFire) {
          await fireOneShot(store, loop, 'manual');
        }

        // Update lastRun (and clear any stale cronJobId left from the old model)
        const freshStore = await readStore();
        const lastRunUpdate: Partial<AgentLoop> = { lastRun: Date.now() };
        if (loop.cronJobId) lastRunUpdate.cronJobId = undefined;
        updateLoopInStore(freshStore, loopId, lastRunUpdate);
        await writeLoops(freshStore); // #1497: targeted settings write

        return NextResponse.json({ ok: true, dispatched: shouldFire, method: 'one-shot' });
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
        // #1633 — `sync` is now a CLEANUP pass, not a (re)creation pass.
        //
        // The old behavior recreated a recurring `Scheduler: <agent>` cron
        // (full agentTurn LLM payload, fires every intervalMinutes) for any
        // enabled loop whose cron was missing. That is exactly the heavyweight
        // autonomous loop tax #1633 removes — and because it ran on every sync,
        // it would silently resurrect the heavy crons even after they were
        // deleted. Dispatch is event-driven now (see `case 'trigger'`), keyed
        // off `loop.enabled`, so no per-agent cron is needed at all.
        //
        // This pass instead TEARS DOWN legacy scheduler crons and clears their
        // stored references. It never calls `cron.add`, so a sync can't
        // recreate the tax. Planning is delegated to the pure `planSync` policy
        // (unit-tested in scheduler-dispatch-policy.test.ts).
        const store = await readStore();
        const loops: AgentLoop[] = store.settings?.loops || [];

        // Check gateway availability (we still need it to list/remove crons).
        const hasGateway = await checkGateway();
        if (!hasGateway) {
          return NextResponse.json(
            { error: 'Agent runtime not connected. Set GATEWAY_URL and GATEWAY_TOKEN in .env.local to sync scheduling.', code: 'NO_GATEWAY' },
            { status: 503 }
          );
        }

        // Get all cron jobs from Gateway so we can find legacy Scheduler crons
        // to remove (both loop-referenced and orphaned). includeDisabled:true
        // is required — legacy `Scheduler:` jobs are often left DISABLED, and
        // a default cron.list hides them, which would let sync clear the store
        // ref while leaving the disabled job orphaned on the Gateway forever.
        let cronJobs: any[] = [];
        try {
          const result = await rpc('cron.list', { includeDisabled: true });
          cronJobs = result?.jobs || [];
        } catch (e: any) {
          return NextResponse.json({ error: 'Failed to list cron jobs: ' + (e?.message || e) }, { status: 502 });
        }

        const plan = planSync(
          loops.map((l) => ({ id: l.id, agentId: l.agentId, enabled: l.enabled, cronJobId: l.cronJobId })),
          cronJobs.map((j: any) => ({ id: j.id, name: j.name })),
        );

        let removed = 0;
        let cleared = 0;
        let freshStore = await readStore();

        // 1. Per-loop steps: remove the live cron (if any) and clear the stored ref.
        for (const step of plan.loopSteps) {
          if (step.removeCronId) {
            try {
              await rpc('cron.remove', { id: step.removeCronId });
              removed++;
            } catch (e: any) {
              console.warn(`[sync #1633] cron.remove warning for ${step.removeCronId}:`, e?.message || e);
            }
          }
          if (step.clearStoredCronJobId) {
            freshStore = await readStore();
            updateLoopInStore(freshStore, step.loopId, { cronJobId: undefined });
            await writeLoops(freshStore); // #1497: targeted settings write
            cleared++;
          }
        }

        // 2. Orphaned legacy `Scheduler:` crons that no loop references anymore.
        for (const orphan of plan.orphanSteps) {
          try {
            await rpc('cron.remove', { id: orphan.removeCronId });
            removed++;
            console.log(`[sync #1633] removed orphaned legacy scheduler cron "${orphan.name}" (${orphan.removeCronId})`);
          } catch (e: any) {
            console.warn(`[sync #1633] cron.remove warning for orphan ${orphan.removeCronId}:`, e?.message || e);
          }
        }

        // `synced` retained for UI back-compat (single count it renders).
        const synced = removed + cleared;
        return NextResponse.json({
          ok: true,
          synced,
          mode: 'cleanup',
          cronRemoved: removed,
          cronJobIdsCleared: cleared,
        });
      }

      case 'trigger': {
        // Event-driven trigger — called when a task lands in an agent's backlog.
        // Expects: { action: 'trigger', agentId: string, triggerSource?: TriggerSource }
        const { agentId } = body;
        if (!agentId) return NextResponse.json({ error: 'Missing agentId' }, { status: 400 });

        // #1526 — Shared memoized reader for this trigger invocation.
        // Every `.read(label)` in this case body goes through `reader`.
        // Between writes we call `reader.refresh()` to drop the cache so the
        // next read fetches a fresh snapshot (preserving #1515 freshness).
        //
        // #1529 — the dispatch-decision path now uses `.readSlim()` instead
        // of `.read()`. The slim shape excludes heavy text columns
        // (title/description/done_when/constraints/test_plan/review_notes)
        // and the inline comments JSONB, and projects overflow fields
        // (sectionId/taskType/isArchived/claim_*/blockedBy/waitsFor) as
        // scalars off the data column. End-to-end this drops the tasks
        // payload from ~3.2 MB to ~900 KB on prod-shape data (1369 tasks),
        // and the tasks query alone from 1124ms→143ms p95.
        //
        // Helpers in this case are all slim-safe:
        //   - hasActionableWork — reads status, assignee, loopPausedAt, version
        //   - sweepExpiredLeases — reads claim_*, statusHistory, id; uses
        //     provider.listComments for STOP-window checks (not inline)
        //   - detectAndIncrementLoops — reads status, assignee, loopCount,
        //     loopPausedAt, lastActivityAt, createdAt; uses
        //     provider.listCommentsForTasks for comment-based activity
        //   - diagnoseAgentBacklog/classifyBlocker — reads sectionId,
        //     taskType, version, waitsFor, projectId, isArchived,
        //     loopPausedAt (all in slim shape)
        //   - pauseStalledTasks — reads task.title for the alert Telegram;
        //     fetches title via provider.getTaskFull(id) per stalled task
        //     (typically 0–1 per tick, not in the hot loop)
        //
        // fireOneShot still does its OWN full readStore() internally — it
        // composes prompt text from title/description/doneWhen/etc and
        // that path is a separate followup (see #1534). Slimming the
        // pre-dispatch decision path is the win here.
        const reader = createMemoizedStoreReader();
        const store = await reader.readSlim('trigger-top');
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
          // #1526: cache HIT — between trigger-top and here we did only
          // read-only checks (cooldown, loop lookup, hasActionableWork). The
          // sweepStore can safely use the cached snapshot. After sweep
          // writes, we `.refresh()` so the next read is fresh.
          const sweepStore = await reader.readSlim('trigger-pre-sweep');
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
        // #1526: sweep above may have written (lease bounces / level-3
        // disables). Force a fresh read here so detectAndIncrementLoops
        // sees the post-sweep state. This is the original #1515 contract.
        reader.refresh();
        const freshStore = await reader.readSlim('trigger-post-sweep');
        const { stalled, incremented } = await detectAndIncrementLoops(freshStore, agentId);

        if (stalled.length > 0) {
          // Pause stalled tasks and send alerts instead of firing another loop
          // #1526: detectAndIncrementLoops wrote loopCount updates above;
          // refresh before pauseStalledTasks reads.
          reader.refresh();
          await pauseStalledTasks(await reader.readSlim('trigger-pre-pause'), agentId, stalled);
          
          // Check if there's still non-paused actionable work
          // #1526: pauseStalledTasks wrote loopPausedAt; refresh again.
          reader.refresh();
          const postPauseStore = await reader.readSlim('trigger-post-pause');
          if (!hasActionableWork(postPauseStore, agentId)) {
            return recordAndReturn(
              { 
                ok: true, skipped: true, 
                reason: `Stall detected: ${stalled.length} task(s) paused after ${MAX_LOOPS_BEFORE_ESCALATION}+ loops`,
                // #1529: slim tasks don't carry `title`; pauseStalledTasks
                // re-fetches the full task internally for the alert, but
                // here we only have the slim shape on hand. Surface ids
                // + loopCount; the full title lives in the alert + the
                // task itself, so this response is informational anyway.
                paused: stalled.map(t => ({ id: t.id, loopCount: t.loopCount })),
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
        //
        // #1521 — fireOneShot itself now re-reads the store immediately
        // before composing the dispatch summary, and emits the diagnostic
        // log line tagged with the source path. The outer per-handler
        // re-read + diagnostic block (added by #1515 and lived here as
        // ~25 lines) is gone: the in-function version covers EVERY
        // call site instead of only this one, which is the whole point
        // of #1521. Keep `recordTrigger` outside (cooldown bookkeeping
        // only — doesn't need fresh task state).
        const sessionKey = await fireOneShot(store, loop, 'primary');
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
                await fireOneShot(store, loop, 'sweep');
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
                await fireOneShot(store, loop, 'sweep');
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

        // ---- #1589 Domain Steward pass --------------------------------
        // A SYSTEM behavior (not a teammate): after the per-loop dispatch
        // checks above, sweep the whole store for tickets stuck on a
        // *reversible* reason and nudge the OWNER to own them; batch genuine
        // *irreversible* gates into ONE human summary. Idempotent via
        // lastStewardNudgeAt. Best-effort — never blocks the sweep response.

        // #1593 — shared precedent search fn (read-only org-memory lookup)
        // used to enrich Steward nudges + experiment proposals below. Backed
        // by searchMemory (#1592); returns [] on any failure so enrichment is
        // always best-effort and the sweep never breaks on a search miss.
        const memorySearchForPrecedent = async (
          query: string,
          filters: { projectId?: string; owner?: string; sourceTypes?: string[] },
          limit: number,
        ): Promise<MemoryHit[]> => {
          try {
            if (!process.env.DATABASE_URL) return [];
            const r = await searchMemory(query, filters as any, limit);
            return (r.results || []) as MemoryHit[];
          } catch {
            return [];
          }
        };

        let stewardNudged = 0;
        let stewardEscalated = 0;
        try {
          const nowS = Date.now();
          // Map assignee NAME (free text, e.g. "Mikey") -> agentId for dispatch.
          const teammates = (store.settings?.teammates || []) as any[];
          const nameToAgentId = (name: string): string | undefined => {
            const lower = (name || '').toLowerCase();
            const t = teammates.find(
              (tm) => (tm.name || '').toLowerCase() === lower || (tm.agentId || '').toLowerCase() === lower,
            );
            return t?.agentId;
          };

          // Build steward fixtures from the live rows. statusChangedAt comes
          // from the last statusHistory entry (same source the stuck-task
          // check uses); lastActivityAt is the comment/update clock.
          const stewardTasks: StewardTaskLike[] = store.tasks.map((t: any) => {
            const lastHist = t.statusHistory?.length
              ? t.statusHistory[t.statusHistory.length - 1]?.timestamp
              : t.createdAt || 0;
            return {
              id: t.id,
              ticketNumber: t.ticketNumber,
              title: t.title,
              status: t.status,
              assignee: t.assignee,
              blockedReasonType: t.blockedReasonType,
              blockedReason: t.blockedReason,
              blockedBy: t.blockedBy,
              statusChangedAt: lastHist,
              lastActivityAt: t.lastActivityAt,
              lastStewardNudgeAt: t.lastStewardNudgeAt ?? null,
            };
          });

          const plan = planStewardSweep(stewardTasks, nowS);
          const provider = getStoreProviderAllWorkspaces() as any;

          // (a) Owner nudges — push the owner to own, via sendToAgent.
          for (const nudge of plan.nudges) {
            const agentId = nameToAgentId(nudge.owner);
            if (!agentId) {
              console.warn(`[steward #1589] no agentId for owner='${nudge.owner}' on ${nudge.ticket.id} — skip nudge`);
              continue;
            }
            const msg = buildOwnerNudge(nudge.reason, nudge.ticket);
            // #1593 — precedent-aware enrichment (read-only). Appends prior
            // org-memory context (e.g. is this owner repeatedly abdicating the
            // same class of call?) so the nudge teaches instead of repeating.
            // Best-effort: search failure returns the base nudge unchanged.
            const enrichedMsg = await enrichStewardNudge(
              msg, nudge.reason, nudge.ticket, memorySearchForPrecedent,
            );
            try {
              await sendToAgent(agentId, enrichedMsg, {
                idempotencyKey: `steward-${nudge.ticket.id}-${nudge.reason}-${Math.floor(nowS / NUDGE_COOLDOWN_MS)}`,
              });
              // Stamp idempotency so we don't re-nudge within the cooldown.
              await provider.updateTask(nudge.ticket.id, { lastStewardNudgeAt: nowS });
              stewardNudged++;
            } catch (e: any) {
              console.warn(`[steward #1589] nudge failed for ${nudge.ticket.id}: ${e?.message || e}`);
            }
          }

          // (b) Human summary — ONE message for all irreversible gates.
          // Delivered via direct Telegram sendMessage to NOTIFY_CHAT_ID, the
          // same human-delivery path the store-route notifier uses. (rpc
          // 'chat.send' routes to an agent session, not a human chat.)
          const summary = buildHumanSummary(plan.humanEscalations);
          const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
          const TG_CHAT = process.env.TELEGRAM_CHAT_ID || NOTIFY_CHAT_ID;
          if (summary && TG_TOKEN && TG_CHAT) {
            try {
              await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: TG_CHAT, text: summary, parse_mode: 'Markdown' }),
              });
              stewardEscalated = plan.humanEscalations.length;
            } catch (e: any) {
              console.warn(`[steward #1589] human summary send failed: ${e?.message || e}`);
            }
          } else if (summary) {
            // No human channel configured — log so the gate is still visible.
            console.info(`[steward #1589] ${plan.humanEscalations.length} irreversible gate(s); no Telegram human channel set`);
            stewardEscalated = plan.humanEscalations.length;
          }

          if (stewardNudged > 0 || stewardEscalated > 0) {
            console.log(`[steward #1589] nudged=${stewardNudged} escalated=${stewardEscalated} (skipped=${plan.skipped.length})`);
          }
        } catch (stewardErr: any) {
          console.warn('[steward #1589] sweep failed (non-fatal):', stewardErr?.message || stewardErr);
        }
        // ---- end Domain Steward pass ----------------------------------

        // ---- #1585 Done-but-unmet nudge pass --------------------------
        // When every child ticket of an outcome-bound version is done but
        // the metric still misses target, nudge the OWNER once to propose
        // the next experiment (or conclude the hypothesis). On-demand,
        // summarize-once, idempotent (lastProposeNudgeAt). Never auto-spawns.
        let proposeNudged = 0;
        try {
          const nowP = Date.now();
          const teammatesP = (store.settings?.teammates || []) as any[];
          const nameToAgentIdP = (name: string): string | undefined => {
            const lower = (name || '').toLowerCase();
            const t = teammatesP.find(
              (tm) => (tm.name || '').toLowerCase() === lower || (tm.agentId || '').toLowerCase() === lower,
            );
            return t?.agentId;
          };
          // Resolve each version owner: explicit version.owner, else the
          // owning component's owner, else the project devOwner.
          const rvs = (store.roadmapVersions || []) as any[];
          const projForVersion = (store.projects || []) as any[];
          const defaultOwner = (p: any): string => {
            const comps = (p?.components && p.components.length ? p.components : p?.sections) || [];
            const primary = comps.find((c: any) => c.role !== 'qa' && c.role !== 'support') || comps[0];
            return (primary?.owner || p?.devOwner || '').toString();
          };
          const dunVersions: DoneUnmetVersionLike[] = rvs.map((v: any) => {
            const meta = v.meta && typeof v.meta === 'object' ? v.meta : {};
            const proj = projForVersion.find((p: any) => p.id === v.projectId || p.id === v.project_id);
            return {
              id: v.id,
              version: v.version,
              status: v.status,
              owner: (v.owner || (proj ? defaultOwner(proj) : '')) || '',
              successCriteria: meta.successCriteria ?? v.successCriteria,
              metricCurrent: meta.metricCurrent ?? v.metricCurrent,
              metricTarget: meta.metricTarget ?? v.metricTarget,
              metricComparator: meta.metricComparator ?? v.metricComparator,
              loopPaused: meta.loopPaused ?? v.loopPaused,
              items: v.items || [],
              lastProposeNudgeAt: meta.lastProposeNudgeAt ?? v.lastProposeNudgeAt ?? null,
            };
          });

          const proposePlan = planProposeSweep(dunVersions, nowP);
          for (const n of proposePlan.nudges) {
            const agentId = nameToAgentIdP(n.owner);
            if (!agentId) {
              console.warn(`[propose-next #1585] no agentId for owner='${n.owner}' on ${n.version.version} — skip`);
              continue;
            }
            try {
              // #1593 — precedent-aware: recall prior experiments toward this
              // goal (what was tried, what moved the metric) before asking the
              // owner to propose the next one. Read-only, best-effort.
              const proposeMsg = await enrichProposePrompt(
                buildProposeNextPrompt(n.version),
                { version: n.version.version, successCriteria: n.version.successCriteria ?? undefined, id: n.version.id, projectId: (n.version as any).projectId },
                memorySearchForPrecedent,
              );
              await sendToAgent(agentId, proposeMsg, {
                idempotencyKey: `propose-${n.version.id}-${Math.floor(nowP / PROPOSE_COOLDOWN_MS)}`,
              });
              proposeNudged++;
              // Best-effort idempotency stamp on the rv meta (no migration).
              // Failure here only risks a duplicate nudge next sweep, which the
              // idempotencyKey above still de-dupes within the cooldown bucket.
              try {
                const provider = getStoreProviderAllWorkspaces() as any;
                if (typeof provider.updateRoadmapVersionMeta === 'function') {
                  await provider.updateRoadmapVersionMeta(n.version.id, { lastProposeNudgeAt: nowP });
                }
              } catch { /* non-fatal */ }
            } catch (e: any) {
              console.warn(`[propose-next #1585] nudge failed for ${n.version.version}: ${e?.message || e}`);
            }
          }
          if (proposeNudged > 0) {
            console.log(`[propose-next #1585] nudged=${proposeNudged} (skipped=${proposePlan.skipped.length})`);
          }
        } catch (proposeErr: any) {
          console.warn('[propose-next #1585] sweep failed (non-fatal):', proposeErr?.message || proposeErr);
        }
        // ---- end Done-but-unmet pass ----------------------------------

        // ---- #1586 Assisted metric capture pass -----------------------
        // For each version with a configured metricSource (endpoint poll),
        // fetch the endpoint, extract the number, and write metricCurrent via
        // the roadmap API. Manual entry is untouched and always wins on the
        // next manual PATCH — this only populates when a source is configured.
        // Best-effort; a flaky endpoint never breaks the sweep.
        let metricsPolled = 0;
        try {
          const rvsM = (store.roadmapVersions || []) as any[];
          const projsM = (store.projects || []) as any[];
          // Basic SSRF guard: only public http(s) hosts. Blocks localhost,
          // link-local, and obvious private ranges. Not exhaustive, but stops
          // the foot-guns; a configured source is owner-supplied, not arbitrary.
          const isBlockedHost = (host: string): boolean => {
            const h = host.toLowerCase();
            if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0') return true;
            if (/^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
            if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
            return false;
          };
          const fetchJson = async (url: string) => {
            const u = new URL(url);
            if (isBlockedHost(u.hostname)) throw new Error('blocked host (private/loopback)');
            const ac = new AbortController();
            const to = setTimeout(() => ac.abort(), 8000);
            try {
              const resp = await fetch(url, { signal: ac.signal, headers: { Accept: 'application/json' } });
              if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
              return await resp.json();
            } finally {
              clearTimeout(to);
            }
          };

          for (const v of rvsM) {
            const meta = v.meta && typeof v.meta === 'object' ? v.meta : {};
            const rawSource = meta.metricSource ?? v.metricSource;
            if (!rawSource) continue;
            const valid = validateMetricSource(rawSource);
            if (!valid.ok) {
              console.warn(`[metric-capture #1586] ${v.version}: invalid source — ${valid.error}`);
              continue;
            }
            const result = await pollMetricSource(valid.source, fetchJson);
            if (!result.ok) {
              console.warn(`[metric-capture #1586] ${v.version}: poll failed — ${result.error}`);
              continue;
            }
            // Only write when the value actually changed (avoid noisy churn).
            const prev = meta.metricCurrent ?? v.metricCurrent;
            if (typeof prev === 'number' && prev === result.value) continue;
            const proj = projsM.find((p: any) => p.id === v.projectId || p.id === v.project_id);
            const projectId = proj?.id || v.projectId || v.project_id;
            if (!projectId) continue;
            try {
              await fetch(`http://127.0.0.1:${process.env.PORT || 4501}/api/roadmap/${projectId}`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${process.env.ORG_STUDIO_API_KEY || ''}`,
                },
                body: JSON.stringify({ action: 'upsert', version: v.version, metricCurrent: result.value }),
              });
              metricsPolled++;
            } catch (e: any) {
              console.warn(`[metric-capture #1586] ${v.version}: write failed — ${e?.message || e}`);
            }
          }
          if (metricsPolled > 0) {
            console.log(`[metric-capture #1586] updated metricCurrent on ${metricsPolled} version(s)`);
          }
        } catch (metricErr: any) {
          console.warn('[metric-capture #1586] pass failed (non-fatal):', metricErr?.message || metricErr);
        }
        // ---- end Assisted metric capture pass -------------------------

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

        return NextResponse.json({ ok: true, swept, steward: { nudged: stewardNudged, escalated: stewardEscalated }, proposeNext: { nudged: proposeNudged }, metricCapture: { polled: metricsPolled } });
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
          lastActivityAt: Date.now(),
        };

        // #1497: targeted UPDATE + addComment via the provider — no full-store rewrite.
        const provider = getStoreProviderAllWorkspaces();
        try {
          await provider.updateTask(taskId, {
            loopCount: 0,
            loopPausedAt: null,
            loopPauseReason: null,
            lastActivityAt: Date.now(),
          });
        } catch (e: any) {
          console.error('[resume #1497] updateTask failed:', e?.message);
          return NextResponse.json({ error: `updateTask failed: ${e?.message}` }, { status: 500 });
        }
        try {
          await provider.addComment(
            { kind: 'task', taskId },
            {
              id: `sys-resume-${Date.now()}-${taskId}`,
              author: 'System',
              content: '✅ **Loop resumed** — loopCount reset to 0. Agent will be re-triggered on next scheduler cycle.',
              createdAt: Date.now(),
              type: 'system',
            },
          );
        } catch (e: any) {
          console.warn('[resume #1497] addComment failed (non-fatal):', e?.message);
        }

        // Re-trigger the agent
        const assignee = task.assignee;
        if (assignee) {
          const agentId = assignee.toLowerCase();
          const loop = getLoopByAgent(store, agentId);
          if (loop) {
            try {
              await fireOneShot(store, loop, 'resume');
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
