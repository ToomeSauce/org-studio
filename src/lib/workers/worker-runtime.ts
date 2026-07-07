/**
 * WorkerRuntime — Execution Workers as a third runtime class (#1657, W-2).
 *
 * Implements the AgentRuntime interface so workers are dispatched exactly
 * like OpenClaw/Hermes agents: the scheduler calls registry.send() and
 * never knows the assignee is a worker pool. Design doc:
 * docs/design/execution-workers.md.
 *
 * ENQUEUE SEMANTICS (the W-2 contract): send() does NOT run the job
 * inline. It validates the dispatch (lane gate, repo checkout, single
 * flight), enqueues the job, and returns immediately — exactly like the
 * OpenClaw runtime's send() returns once the wake is delivered, not when
 * the agent finishes. The job runs in the background; `opts.onComplete`
 * fires when it finishes, which plugs straight into the outbox-drain
 * redispatch path (clearInFlightAgent → scheduler trigger) unchanged.
 * Running inline would pin the drain HTTP request open for the full
 * engine run (up to timeoutMs, default 15min) — that was the draft bug.
 *
 * v1 scope (this ticket):
 *   - discover(): one RuntimeAgent per configured worker (WORKER_RUNTIME_ENABLED)
 *   - send(): lane-gate → resolve ticket → enqueue codex engine job
 *     (local-process mode in the project's repo checkout) → ledger rows →
 *     closeout comment on job end.
 *   - Lane refusals throw with a clear reason (surfaces in scheduler logs
 *     AND as a ⛔ comment on the ticket).
 *
 * Deliberately NOT here (later tickets):
 *   - W-3: rich context assembly (comment threads, generated AGENTS.md)
 *   - W-4: HostProfile enforcement layers
 *   - W-5: remote provisioning (gh-actions/vm), GitHub App checkout, PR flow
 *
 * The v1 dispatch message IS the brief: the scheduler's buildDispatchMessage
 * output already contains ticket details; we pass it through plus the raw
 * ticket fields. W-3 replaces this with purpose-built assembly.
 */
import type { AgentRuntime, RuntimeAgent, AgentMetadata } from '../runtimes/types';
import { getWorkerConfigs, checkLane, workersEnabled, type WorkerConfig } from './config';
import { runCodexEngine, type WorkerRunResult, type EngineRunOpts } from './engine-codex';
import {
  assembleBrief,
  generateWorkerAgentsMd,
  extractAttemptSummary,
  renderStructuredCloseout,
  GENERATED_AGENTS_MD_MARKER,
  type BriefComment,
} from './context-assembler';
import {
  resolveHostProfile,
  toHostAdvisory,
  codexSandboxModeFor,
  buildOsWrapper,
  type HostProfile,
} from './host-profile';
import { tryAcquireHostSlot } from './host-semaphore';
import { GhActionsAdapter, type ProvisionJobSpec, type ProvisionResult } from './provisioning';
import { recordDispatch, recordModelCall } from '../dispatch-ledger';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { readFile, writeFile, unlink } from 'fs/promises';
import { join } from 'path';

/** Where a project's working checkout lives for local-process mode.
 *  v1: explicit map via WORKER_REPO_PATHS env (JSON: {projectId: absPath}).
 *  W-5 replaces this with real checkout provisioning. */
function resolveRepoPath(projectId: string | undefined): string | null {
  if (!projectId) return null;
  try {
    const map = JSON.parse(process.env.WORKER_REPO_PATHS || '{}');
    const p = map[projectId];
    return typeof p === 'string' && existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/** Target repo slug for remote provisioning modes.
 *  v1 gh-actions: explicit map via WORKER_REPO_SLUGS env
 *  (JSON: {projectId: "owner/name"}). */
function resolveRepoSlug(projectId: string | undefined): string | null {
  if (!projectId) return null;
  try {
    const map = JSON.parse(process.env.WORKER_REPO_SLUGS || '{}');
    const slug = map[projectId];
    return typeof slug === 'string' && slug.includes('/') ? slug : null;
  } catch {
    return null;
  }
}

const ORG_STUDIO_BASE = () => `http://localhost:${process.env.PORT || 4501}`;

let systemdRunAvailableCache: boolean | null = null;
function defaultSystemdRunAvailable(): boolean {
  if (systemdRunAvailableCache !== null) return systemdRunAvailableCache;
  try {
    execFileSync('systemd-run', ['--version'], { stdio: 'ignore', timeout: 3000 });
    systemdRunAvailableCache = true;
  } catch {
    systemdRunAvailableCache = false;
  }
  return systemdRunAvailableCache;
}

async function defaultFetchStore(): Promise<any | null> {
  try {
    const r = await fetch(`${ORG_STUDIO_BASE()}/api/store`, {
      headers: process.env.ORG_STUDIO_API_KEY
        ? { Authorization: `Bearer ${process.env.ORG_STUDIO_API_KEY}` }
        : {},
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function defaultPostComment(taskId: string, author: string, content: string): Promise<void> {
  try {
    await fetch(`${ORG_STUDIO_BASE()}/api/store`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.ORG_STUDIO_API_KEY
          ? { Authorization: `Bearer ${process.env.ORG_STUDIO_API_KEY}` }
          : {}),
      },
      body: JSON.stringify({
        action: 'addComment',
        taskId,
        comment: { author, content, type: 'comment' },
      }),
    });
  } catch (e: any) {
    console.warn('[worker] closeout comment failed:', e?.message);
  }
}

/** Full comment thread via the canonical listComments action (#1658).
 *  Best-effort: [] on any failure — the brief degrades, the job still runs. */
async function defaultFetchComments(taskId: string): Promise<BriefComment[]> {
  try {
    const r = await fetch(`${ORG_STUDIO_BASE()}/api/store`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.ORG_STUDIO_API_KEY
          ? { Authorization: `Bearer ${process.env.ORG_STUDIO_API_KEY}` }
          : {}),
      },
      body: JSON.stringify({ action: 'listComments', taskId, limit: 50 }),
    });
    if (!r.ok) return [];
    const data = await r.json();
    const list = Array.isArray(data?.comments) ? data.comments : [];
    // listComments returns newest-first; the brief wants oldest-first.
    return [...list].sort((a: any, b: any) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  } catch {
    return [];
  }
}

async function defaultRunRemote(spec: ProvisionJobSpec, _worker: WorkerConfig): Promise<ProvisionResult> {
  const token = process.env.WORKER_GH_TOKEN;
  if (!token) {
    throw new Error('WORKER_GH_TOKEN is required for worker mode=gh-actions');
  }
  const adapter = new GhActionsAdapter({
    token,
    workflowRepo: process.env.WORKER_WORKFLOW_REPO || 'ToomeSauce/org-studio',
  });
  return adapter.provision(spec);
}

/**
 * AGENTS.md handling for a SHARED checkout (v1 local-process mode — W-5
 * provisioning gives each job its own checkout and this simplifies to a
 * plain write). Save whatever AGENTS.md exists, write the generated one,
 * and return a restore function that puts the original back (or removes
 * ours) after the run. Restore runs in finally — a crashed job never
 * leaves a generated AGENTS.md behind for humans/agents to trip on.
 */
async function defaultWriteAgentsMd(
  repoRoot: string,
  content: string,
): Promise<() => Promise<void>> {
  const p = join(repoRoot, 'AGENTS.md');
  let original: string | null = null;
  try {
    original = await readFile(p, 'utf8');
  } catch {
    original = null; // no pre-existing AGENTS.md
  }
  // Merge: generated job context on top, existing repo AGENTS.md below —
  // repo conventions the maintainers wrote still reach the engine.
  const merged =
    original && !original.startsWith(GENERATED_AGENTS_MD_MARKER)
      ? `${content}\n---\n\n${original}`
      : content;
  await writeFile(p, merged, 'utf8');
  return async () => {
    try {
      if (original !== null && !original.startsWith(GENERATED_AGENTS_MD_MARKER)) {
        await writeFile(p, original, 'utf8');
      } else {
        await unlink(p);
      }
    } catch (e: any) {
      console.warn('[worker] AGENTS.md restore failed:', e?.message);
    }
  };
}

/** Injectable IO seams — production uses the defaults; tests stub them. */
export interface WorkerRuntimeDeps {
  fetchStore: () => Promise<any | null>;
  postComment: (taskId: string, author: string, content: string) => Promise<void>;
  fetchComments: (taskId: string) => Promise<BriefComment[]>;
  writeAgentsMd: (repoRoot: string, content: string) => Promise<() => Promise<void>>;
  runEngine: (opts: EngineRunOpts) => Promise<WorkerRunResult>;
  runRemote: (spec: ProvisionJobSpec, worker: WorkerConfig) => Promise<ProvisionResult>;
  recordDispatch: typeof recordDispatch;
  recordModelCall: typeof recordModelCall;
  /** #1659 — OS-backstop availability probe (systemd-run). */
  systemdRunAvailable: () => boolean;
  /** #1659 — per-host job semaphore (worker jobs only). */
  acquireHostSlot: typeof tryAcquireHostSlot;
}

const DEFAULT_DEPS: WorkerRuntimeDeps = {
  fetchStore: defaultFetchStore,
  postComment: defaultPostComment,
  fetchComments: defaultFetchComments,
  writeAgentsMd: defaultWriteAgentsMd,
  runEngine: runCodexEngine,
  runRemote: defaultRunRemote,
  recordDispatch,
  recordModelCall,
  systemdRunAvailable: defaultSystemdRunAvailable,
  acquireHostSlot: tryAcquireHostSlot,
};

export interface EnqueueResult {
  ok: true;
  enqueued: true;
  dispatchId: string;
  ticketNumber?: number;
}

export class WorkerRuntime implements AgentRuntime {
  id = 'worker';
  name = 'Execution Workers';

  /** Per-worker single flight — a worker runs ONE job at a time (mirrors
   *  the scheduler's per-agent serialization). Value = dispatchId. */
  private inFlight = new Map<string, string>();
  private deps: WorkerRuntimeDeps;

  constructor(deps?: Partial<WorkerRuntimeDeps>) {
    this.deps = { ...DEFAULT_DEPS, ...(deps || {}) };
  }

  async discover(): Promise<RuntimeAgent[]> {
    return getWorkerConfigs().map((w) => ({
      id: w.id,
      name: w.name,
      emoji: '🔧',
      runtime: 'worker',
      status: 'online' as const,
      metadata: {
        engine: w.engine,
        model: w.model,
        mode: w.mode,
        lane: w.lane,
        busy: this.inFlight.has(w.id),
      },
    }));
  }

  async health(): Promise<{ connected: boolean; detail?: string }> {
    if (!workersEnabled()) return { connected: false, detail: 'WORKER_RUNTIME_ENABLED not set' };
    const n = getWorkerConfigs().length;
    return {
      connected: n > 0,
      detail: `${n} worker(s) configured, ${this.inFlight.size} job(s) in flight`,
    };
  }

  async getAgentMetadata(agentId: string): Promise<AgentMetadata | undefined> {
    const w = getWorkerConfigs().find((x) => x.id === agentId);
    if (!w) return undefined;
    return { model: w.model, provider: 'worker:' + w.engine, mode: w.mode };
  }

  /**
   * Dispatch = ENQUEUE one job (see header). Validates synchronously
   * (lane gate, repo, single flight — all fast), then kicks the engine
   * run into the background and returns. Rejection = the dispatch did
   * not enqueue and the caller (outbox worker) should treat it as a
   * failed send. `opts.onComplete` fires when the background job ends,
   * success or failure — that drives the drain redispatch path.
   */
  async send(
    agentId: string,
    message: string,
    opts?: { sessionKey?: string; idempotencyKey?: string; onComplete?: (agentId: string) => void },
  ): Promise<EnqueueResult | { ok: true; skipped: string }> {
    const worker = getWorkerConfigs().find((w) => w.id === agentId);
    if (!worker) throw new Error(`Unknown worker: ${agentId}`);

    if (this.inFlight.has(agentId)) {
      throw new Error(
        `${agentId} already has job ${this.inFlight.get(agentId)} in flight — dispatch refused`,
      );
    }

    // Resolve the target ticket: highest-priority backlog/in-progress task
    // assigned to this worker. (The dispatcher decided to wake us; we confirm
    // against the store — same claim-from-board contract agents follow.)
    const store = await this.deps.fetchStore();
    if (!store) throw new Error('Worker dispatch aborted: store unreachable');
    const candidates = (store.tasks || [])
      .filter(
        (t: any) =>
          (t.assignee || '').toLowerCase() === agentId.toLowerCase() &&
          ['backlog', 'in-progress'].includes(t.status) &&
          !t.isArchived,
      )
      .sort((a: any, b: any) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    const task = candidates[0];
    if (!task) return { ok: true, skipped: 'no actionable work' };

    const laneCheck = checkLane(worker, task);
    if (!laneCheck.ok) {
      await this.deps.postComment(task.id, worker.id, `⛔ Lane refusal: ${laneCheck.reason}`);
      throw new Error(laneCheck.reason);
    }

    const repo =
      worker.mode === 'gh-actions' ? resolveRepoSlug(task.projectId) : resolveRepoPath(task.projectId);
    if (!repo) {
      const reason =
        worker.mode === 'gh-actions'
          ? `No repo slug configured for project ${task.projectId} (set WORKER_REPO_SLUGS={"${task.projectId}":"owner/name"}).`
          : `No repo checkout configured for project ${task.projectId} ` +
            `(set WORKER_REPO_PATHS={"${task.projectId}":"/abs/path"}). W-5 adds real provisioning.`;
      await this.deps.postComment(task.id, worker.id, `⛔ ${reason}`);
      throw new Error(reason);
    }

    const dispatchId = opts?.idempotencyKey || `wrk-${randomUUID()}`;
    this.inFlight.set(agentId, dispatchId);
    this.deps.recordDispatch({
      dispatchId,
      agentId: worker.id,
      source: 'worker',
      outcome: 'enqueued',
      ticketFingerprint: task.ticketNumber ? `${task.ticketNumber}:${task.status}` : undefined,
    });

    // Owning project — for the leash block in the brief (#1654 renderer).
    const project =
      (store.projects || []).find((p: any) => p.id === task.projectId) || null;

    // #1659 W-4: resolve the worker's HostProfile (settings → presets) and
    // take a per-host job slot BEFORE enqueueing. Worker jobs only — agent
    // dispatch for openclaw/hermes never touches this path.
    const profile: HostProfile | null = resolveHostProfile(store.settings, worker.hostId);
    let releaseSlot: (() => void) | null = null;
    if (profile) {
      const slot = this.deps.acquireHostSlot(profile.id, profile.maxConcurrentJobs);
      if (!slot.ok) {
        throw new Error(slot.reason); // dispatch fails cleanly; outbox/scheduler retries later
      }
      releaseSlot = slot.release;
    }

    // ENQUEUE: fire-and-forget the actual engine run. Errors are contained
    // inside runJob (closeout comment + console) — they must never become
    // an unhandled rejection.
    void this.runJob({ worker, task, project, profile, repo, message, dispatchId })
      .catch((e: any) => {
        console.error(`[worker] job ${dispatchId} crashed:`, e?.message || e);
      })
      .finally(() => {
        releaseSlot?.();
        this.inFlight.delete(agentId);
        try {
          opts?.onComplete?.(agentId);
        } catch (e: any) {
          console.warn('[worker] onComplete callback failed:', e?.message);
        }
      });

    return { ok: true, enqueued: true, dispatchId, ticketNumber: task.ticketNumber };
  }

  /** The background job: assemble context, run the engine, meter it,
   *  write the structured closeout back to the ticket (#1658). */
  private async runJob(job: {
    worker: WorkerConfig;
    task: any;
    project: any;
    profile: HostProfile | null;
    repo: string;
    message: string;
    dispatchId: string;
  }): Promise<void> {
    const { worker, task, project, profile, repo, message, dispatchId } = job;

    // --- ContextAssembler forward path (#1658) ---
    const comments = await this.deps.fetchComments(task.id);
    const brief = assembleBrief({
      dispatchMessage: message,
      task,
      comments,
      project,
    });
    if (worker.mode === 'gh-actions') {
      try {
        const ticketNumber = Number(task.ticketNumber || 0);
        const res = await this.deps.runRemote(
          {
            repo,
            ticketNumber,
            title: task.title,
            brief,
            model: worker.model,
            timeoutMs: worker.timeoutMs,
            smoke: process.env.WORKER_SMOKE_MODE === 'true',
          },
          worker,
        );

        this.deps.recordModelCall({
          dispatchId,
          agentId: worker.id,
          modelRequested: worker.model,
          modelServed: worker.model,
          provider: 'worker:' + worker.engine,
          tokensIn: res.usage?.inputTokens ?? null,
          tokensOut: res.usage?.outputTokens ?? null,
          cacheReadTokens: res.usage?.cachedInputTokens ?? null,
        });

        if (res.engineResult) {
          const summary = extractAttemptSummary(res.engineResult);
          await this.deps.postComment(
            task.id,
            worker.id,
            renderStructuredCloseout({
              dispatchId,
              engineLabel: `${worker.engine}/${worker.model}`,
              durationMs: res.engineResult.durationMs,
              summary,
              usage: res.usage || undefined,
            }),
          );
        } else {
          const lines = [
            `🤖 **Worker run** \`${dispatchId.slice(0, 12)}\` — ${res.ok ? '✅ succeeded' : '❌ failed'} on gh-actions runner`,
            '',
            `Detail: ${res.detail}`,
          ];
          if (res.prUrl) lines.push(`PR: ${res.prUrl}`);
          if (res.usage) {
            lines.push(`Usage: in ${res.usage.inputTokens ?? '?'} / out ${res.usage.outputTokens ?? '?'}`);
          }
          await this.deps.postComment(task.id, worker.id, lines.join('\n'));
        }
      } catch (e: any) {
        await this.deps.postComment(
          task.id,
          worker.id,
          `🤖 **Worker run** \`${dispatchId.slice(0, 12)}\` — ⚠️ failed to start: ${e?.message || e}`,
        );
        throw e;
      }
      return;
    }

    const agentsMd = generateWorkerAgentsMd({
      task,
      workerId: worker.id,
      // v1: conventions come from an env knob; W-5 wires per-checkout config.
      repoConventions: process.env.WORKER_REPO_CONVENTIONS || undefined,
      // #1659 W-4 advisory layer: the HostProfile renders into AGENTS.md.
      // No profile → conservative ci-only default (W-3 behavior).
      host: toHostAdvisory(profile) || { buildPolicy: 'ci-only' },
    });

    // #1659 W-4 layers 2+3: sandbox mode from buildPolicy; OS caps wrapper
    // (systemd-run scope) + profile timeout tightening.
    const wrapper = buildOsWrapper(profile, worker.timeoutMs, this.deps.systemdRunAvailable());

    let restoreAgentsMd: (() => Promise<void>) | null = null;
    try {
      restoreAgentsMd = await this.deps.writeAgentsMd(repo, agentsMd);

      const res = await this.deps.runEngine({
        cwd: repo,
        brief,
        model: worker.model,
        timeoutMs: wrapper.timeoutMs,
        sandboxMode: codexSandboxModeFor(profile),
        argvPrefix: wrapper.argvPrefix,
      });

      this.deps.recordModelCall({
        dispatchId,
        agentId: worker.id,
        modelRequested: worker.model,
        modelServed: worker.model,
        provider: 'worker:' + worker.engine,
        tokensIn: res.usage?.inputTokens ?? null,
        tokensOut: res.usage?.outputTokens ?? null,
        cacheReadTokens: res.usage?.cachedInputTokens ?? null,
      });

      // --- ContextAssembler reverse path: structured closeout (#1658) ---
      const summary = extractAttemptSummary(res);
      await this.deps.postComment(
        task.id,
        worker.id,
        renderStructuredCloseout({
          dispatchId,
          engineLabel: `${worker.engine}/${worker.model}`,
          durationMs: res.durationMs,
          summary,
          usage: res.usage,
        }),
      );
    } catch (e: any) {
      // Spawn-level failure (binary missing etc.) — post an honest failure
      // comment so the board shows what happened.
      await this.deps.postComment(
        task.id,
        worker.id,
        `🤖 **Worker run** \`${dispatchId.slice(0, 12)}\` — ⚠️ failed to start: ${e?.message || e}`,
      );
      throw e;
    } finally {
      // Never leave the generated AGENTS.md in a shared checkout.
      if (restoreAgentsMd) await restoreAgentsMd();
    }
  }

  dispose(): void {
    // No persistent connections in local-process mode. In-flight jobs
    // finish on their own (engine subprocess has its own timeout).
  }
}
