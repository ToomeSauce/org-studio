import type { ModelTier } from '@/lib/model-tier';

export interface TierRoutableTask {
  id: string;
  assignee?: string | null;
  modelTier?: ModelTier | null;
}

export interface TierRoutableWorker {
  id: string;
  tiers: ModelTier[];
}

export type TierRouteReason =
  | 'routed'
  | 'explicit-assignee'
  | 'no-tier'
  | 'no-worker-match'
  | 'worker-unavailable'
  | 'cas-lost'
  | 'cas-error';

export interface TierRouteDecision {
  reason: TierRouteReason;
  tier: ModelTier | null;
  workerId?: string;
  error?: string;
}

/**
 * Pure routing decision for generic worker dispatch.
 *
 * Explicit assignees always win. Config order is the cost order, so the first
 * worker that supports a tier is the cheapest eligible worker.
 */
export function routeTierTask(
  task: Pick<TierRoutableTask, 'assignee' | 'modelTier'>,
  workers: TierRoutableWorker[],
  genericAssignee = 'worker',
): TierRouteDecision {
  const assignee = (task.assignee || '').trim().toLowerCase();
  const generic = genericAssignee.trim().toLowerCase();
  const tier = task.modelTier || null;

  if (assignee !== generic) return { reason: 'explicit-assignee', tier };
  if (!tier) return { reason: 'no-tier', tier: null };

  const worker = workers.find((candidate) => candidate.tiers.includes(tier));
  if (!worker) return { reason: 'no-worker-match', tier };
  return { reason: 'routed', tier, workerId: worker.id };
}

export interface PersistTierRouteDeps<TSnapshot> {
  hasEnabledLoop(workerId: string): boolean;
  compareAndSetAssignee(taskId: string, expected: string, next: string): Promise<boolean>;
  refresh(): Promise<TSnapshot>;
}

export interface PersistTierRouteResult<TSnapshot> extends TierRouteDecision {
  snapshot?: TSnapshot;
}

/**
 * Persist a routing decision without stealing explicitly/race-reassigned work.
 * CAS loss/error fails open: the caller keeps today's requested assignment and
 * must not dispatch the selected worker. A successful CAS always returns a
 * refreshed snapshot so downstream actionable-work gates see the new assignee.
 */
export async function persistTierRoute<TSnapshot>(
  task: TierRoutableTask,
  workers: TierRoutableWorker[],
  deps: PersistTierRouteDeps<TSnapshot>,
): Promise<PersistTierRouteResult<TSnapshot>> {
  const decision = routeTierTask(task, workers);
  if (decision.reason !== 'routed' || !decision.workerId) return decision;
  if (!deps.hasEnabledLoop(decision.workerId)) {
    return { ...decision, reason: 'worker-unavailable' };
  }

  try {
    const updated = await deps.compareAndSetAssignee(
      task.id,
      task.assignee || '',
      decision.workerId,
    );
    if (!updated) return { ...decision, reason: 'cas-lost' };
    return { ...decision, snapshot: await deps.refresh() };
  } catch (error) {
    return {
      ...decision,
      reason: 'cas-error',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Return the tier of the first dispatchable task for #1515 diagnostics. */
export function diagnosticTier(
  tasks: Array<
    Pick<TierRoutableTask, 'assignee' | 'modelTier'> & {
      status?: string;
      sortOrder?: number;
      createdAt?: number;
    }
  >,
  assignees: string[],
): ModelTier | null {
  const accepted = new Set(assignees.map((value) => value.toLowerCase()));
  const task = tasks
    .filter(
      (candidate) =>
        accepted.has((candidate.assignee || '').toLowerCase()) &&
        ['in-progress', 'backlog'].includes(candidate.status || ''),
    )
    .sort(
      (a, b) =>
        (a.status === 'in-progress' ? -1 : 0) - (b.status === 'in-progress' ? -1 : 0) ||
        (a.sortOrder ?? Number.MAX_SAFE_INTEGER) -
          (b.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
        (a.createdAt ?? 0) - (b.createdAt ?? 0),
    )[0];
  return task?.modelTier || null;
}
