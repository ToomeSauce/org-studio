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
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { rpc } from '@/lib/gateway-rpc';
import { buildLoopPrompt } from '@/lib/scheduler';
import type { AgentLoop } from '@/lib/store';
import { authenticateRequest } from '@/lib/auth';

const STORE_PATH = join(process.cwd(), 'data', 'store.json');
const DEFAULT_MODEL = 'foundry-openai-chat/gpt-5.4';

// Minimum seconds between event-driven triggers for the same agent (debounce)
const TRIGGER_COOLDOWN_MS = 60_000; // 1 minute
const lastTriggerByAgent: Record<string, number> = {};

interface StoreData {
  projects: any[];
  tasks: any[];
  settings?: Record<string, any>;
}

function readStore(): StoreData {
  if (!existsSync(STORE_PATH)) {
    return { projects: [], tasks: [] };
  }
  return JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
}

function writeStore(data: StoreData) {
  writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
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
    writeStore(store);
  }
}

function getAgentName(store: StoreData, agentId: string): string {
  const teammates = store.settings?.teammates || [];
  const t = teammates.find((tm: any) => tm.agentId === agentId);
  return t?.name || agentId;
}

/** Check if an agent has actionable work (backlog or in-progress tasks assigned to them). */
function hasActionableWork(store: StoreData, agentId: string): boolean {
  const agentName = getAgentName(store, agentId);
  const nameLower = agentName.toLowerCase();
  return store.tasks.some(t => {
    const assignee = (t.assignee || '').toLowerCase();
    const status = (t.status || '').toLowerCase();
    return (assignee === nameLower || assignee === agentId) &&
           (status === 'backlog' || status === 'in-progress');
  });
}

/** Fire a one-shot cron job for the given loop. Used by both runNow and event triggers. */
async function fireOneShot(store: StoreData, loop: AgentLoop): Promise<string | undefined> {
  const agentName = getAgentName(store, loop.agentId);
  const globalPreamble = store.settings?.loopPreamble || '';
  const prompt = buildLoopPrompt(loop, agentName, globalPreamble);
  const at = new Date(Date.now() + 5_000).toISOString();
  const result = await rpc('cron.add', {
    name: `Scheduler: ${agentName} (triggered)`,
    agentId: loop.agentId,
    sessionTarget: 'isolated',
    schedule: { kind: 'at', at },
    payload: {
      kind: 'agentTurn',
      message: prompt,
      model: loop.model || DEFAULT_MODEL,
      timeoutSeconds: 300,
    },
    delivery: { mode: 'announce' },
    deleteAfterRun: true,
  });
  return result?.id || result?.jobId || result?.job?.id;
}

export async function POST(request: NextRequest) {
  const authError = authenticateRequest(request);
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

        const store = readStore();
        const loop = getLoop(store, loopId);
        if (!loop) return NextResponse.json({ error: 'Loop not found' }, { status: 404 });

        const agentName = getAgentName(store, loop.agentId);
        const globalPreamble = store.settings?.loopPreamble || '';
        const prompt = buildLoopPrompt(loop, agentName, globalPreamble);

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
          delivery: { mode: 'announce' },
        });

        const cronJobId = result?.id || result?.jobId || result?.job?.id;
        if (!cronJobId) {
          console.error('cron.add response missing id:', result);
          return NextResponse.json({ error: 'cron.add did not return a job ID', detail: result }, { status: 502 });
        }

        // Persist back to store
        updateLoopInStore(store, loopId, { enabled: true, cronJobId });

        return NextResponse.json({ ok: true, cronJobId });
      }

      case 'disable': {
        if (!loopId) return NextResponse.json({ error: 'Missing loopId' }, { status: 400 });

        const store = readStore();
        const loop = getLoop(store, loopId);
        if (!loop) return NextResponse.json({ error: 'Loop not found' }, { status: 404 });

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
        const freshStore = readStore();
        updateLoopInStore(freshStore, loopId, { enabled: false, cronJobId: undefined });

        return NextResponse.json({ ok: true });
      }

      case 'runNow': {
        if (!loopId) return NextResponse.json({ error: 'Missing loopId' }, { status: 400 });

        const store = readStore();
        const loop = getLoop(store, loopId);
        if (!loop) return NextResponse.json({ error: 'Loop not found' }, { status: 404 });

        if (loop.cronJobId) {
          // Trigger existing cron job, force even if stuck
          try {
            await rpc('cron.run', { id: loop.cronJobId, runMode: 'force' });
          } catch (e: any) {
            // If the cron job doesn't exist anymore, clear it and fire a one-shot
            console.error('cron.run error:', e?.message || e);
            const freshStore2 = readStore();
            updateLoopInStore(freshStore2, loopId, { cronJobId: undefined });
            await fireOneShot(store, loop);
          }
        } else {
          await fireOneShot(store, loop);
        }

        // Update lastRun
        const freshStore = readStore();
        updateLoopInStore(freshStore, loopId, { lastRun: Date.now() });

        return NextResponse.json({ ok: true });
      }

      case 'runHistory': {
        if (!loopId) return NextResponse.json({ error: 'Missing loopId' }, { status: 400 });

        const store = readStore();
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
        const store = readStore();
        const loops: AgentLoop[] = store.settings?.loops || [];

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
        let freshStore = readStore();

        for (const loop of loops) {
          if (loop.enabled && loop.cronJobId && !cronIds.has(loop.cronJobId)) {
            // Enabled loop but cron job missing — recreate
            const agentName = getAgentName(freshStore, loop.agentId);
            const globalPreamble = freshStore.settings?.loopPreamble || '';
            const prompt = buildLoopPrompt(loop, agentName, globalPreamble);
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
                delivery: { mode: 'announce' },
              });
              const newId = result?.id || result?.jobId || result?.job?.id;
              freshStore = readStore();
              updateLoopInStore(freshStore, loop.id, { cronJobId: newId });
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
            freshStore = readStore();
            updateLoopInStore(freshStore, loop.id, { cronJobId: undefined });
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

        const store = readStore();
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

        lastTriggerByAgent[agentId] = now;

        // If the agent's cron job exists, force-run it
        if (loop.cronJobId) {
          try {
            await rpc('cron.run', { id: loop.cronJobId, runMode: 'force' });
            return NextResponse.json({ ok: true, triggered: true, method: 'cron.run' });
          } catch (e: any) {
            console.warn('trigger: cron.run failed, falling back to one-shot:', e?.message);
          }
        }

        // Fallback: fire a one-shot
        await fireOneShot(store, loop);
        return NextResponse.json({ ok: true, triggered: true, method: 'one-shot' });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (e: any) {
    const msg = typeof e === 'string' ? e : e?.message || JSON.stringify(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
