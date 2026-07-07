/**
 * Worker lane configuration (#1657, W-2 of Execution Workers).
 *
 * Workers are configured via settings/env, and each worker defines a LANE:
 * the (taskType, projectId) allowlist that routes tickets to it. Anything
 * outside the lane refuses dispatch with a clear error — the dogfood
 * starts narrow (chore/bug on OSS repos) and widens by config, not code.
 *
 * v1 config source: WORKER_RUNTIME_CONFIG env (JSON) or the defaults
 * below gated by WORKER_RUNTIME_ENABLED=true. Settings-UI storage comes
 * later — env-first keeps the surface reversible and cloud-friendly
 * (Container Apps env vars).
 */

export interface WorkerLane {
  /** Allowed taskTypes (lowercase). Empty = allow all types. */
  taskTypes: string[];
  /** Allowed projectIds. Empty = allow all projects. */
  projectIds: string[];
}

export interface WorkerConfig {
  /** Board identity — appears as a teammate/assignee (e.g. "worker-codex"). */
  id: string;
  name: string;
  engine: 'codex'; // claude-code adapter later; keep the union narrow for now
  model: string;
  /** Execution mode — v1 implements local-process; other rungs land in W-5. */
  mode: 'local-process' | 'local-container' | 'gh-actions' | 'vm';
  lane: WorkerLane;
  /** Hard wall-clock cap per job (ms). */
  timeoutMs: number;
  /** HostProfile id (#1659) — resolves against settings.hostProfiles, then
   *  presets. Unset = no host constraints (W-2 behavior). */
  hostId?: string;
}

export const DEFAULT_WORKERS: WorkerConfig[] = [
  {
    id: 'worker-codex',
    name: 'Worker (Codex)',
    engine: 'codex',
    model: 'gpt-5.3-codex',
    mode: 'local-process',
    lane: {
      taskTypes: ['chore', 'bug'],
      projectIds: [],
    },
    timeoutMs: 15 * 60 * 1000,
  },
];

export function workersEnabled(): boolean {
  return process.env.WORKER_RUNTIME_ENABLED === 'true';
}

export function getWorkerConfigs(): WorkerConfig[] {
  if (!workersEnabled()) return [];
  const raw = process.env.WORKER_RUNTIME_CONFIG;
  if (!raw) return DEFAULT_WORKERS;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_WORKERS;
    return parsed
      .filter((w: any) => w && typeof w.id === 'string' && w.id.startsWith('worker-'))
      .map((w: any) => ({
        id: w.id,
        name: typeof w.name === 'string' ? w.name : w.id,
        engine: w.engine === 'codex' ? 'codex' : 'codex',
        model: typeof w.model === 'string' ? w.model : 'gpt-5.3-codex',
        mode: ['local-process', 'local-container', 'gh-actions', 'vm'].includes(w.mode)
          ? w.mode
          : 'local-process',
        lane: {
          taskTypes: Array.isArray(w.lane?.taskTypes)
            ? w.lane.taskTypes.map((t: any) => String(t).toLowerCase())
            : [],
          projectIds: Array.isArray(w.lane?.projectIds) ? w.lane.projectIds.map(String) : [],
        },
        timeoutMs:
          Number.isFinite(w.timeoutMs) && w.timeoutMs > 0 ? w.timeoutMs : 15 * 60 * 1000,
        hostId: typeof w.hostId === 'string' && w.hostId ? w.hostId : undefined,
      }));
  } catch {
    console.warn('[workers] WORKER_RUNTIME_CONFIG is not valid JSON — using defaults');
    return DEFAULT_WORKERS;
  }
}

export interface LaneCheckTask {
  ticketNumber?: number;
  taskType?: string;
  projectId?: string;
}

export type LaneCheckResult = { ok: true } | { ok: false; reason: string };

/**
 * Pure lane gate — is this task allowed on this worker's lane?
 * Refusals carry a human-readable reason (surfaces in dispatch errors
 * and ticket comments).
 */
export function checkLane(worker: WorkerConfig, task: LaneCheckTask): LaneCheckResult {
  const tt = (task.taskType || '').toLowerCase();
  if (worker.lane.taskTypes.length > 0 && !worker.lane.taskTypes.includes(tt)) {
    return {
      ok: false,
      reason:
        `Task #${task.ticketNumber ?? '?'} (taskType=${task.taskType || 'none'}) is outside ` +
        `${worker.id}'s lane [${worker.lane.taskTypes.join(', ')}]. Route it to an agent runtime ` +
        `or widen the lane in WORKER_RUNTIME_CONFIG.`,
    };
  }
  if (worker.lane.projectIds.length > 0 && !worker.lane.projectIds.includes(task.projectId || '')) {
    return {
      ok: false,
      reason:
        `Task #${task.ticketNumber ?? '?'} (project=${task.projectId || 'none'}) is outside ` +
        `${worker.id}'s project lane [${worker.lane.projectIds.join(', ')}].`,
    };
  }
  return { ok: true };
}
