import type { ModelTier } from '@/lib/model-tier';

export interface TierRoutableTask {
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
  | 'no-worker-match';

export interface TierRouteDecision {
  reason: TierRouteReason;
  tier: ModelTier | null;
  workerId?: string;
}

/**
 * Pure routing decision for generic worker dispatch.
 *
 * Rules:
 * - Explicit assignee wins: only generic assignee (`worker`) is routable.
 * - Missing modelTier fails open (no route).
 * - Cheapest worker wins by config order (first match in `workers`).
 */
export function routeTierTask(
  task: TierRoutableTask,
  workers: TierRoutableWorker[],
  opts?: { genericAssignee?: string },
): TierRouteDecision {
  const generic = (opts?.genericAssignee || 'worker').toLowerCase();
  const assignee = (task.assignee || '').toLowerCase();
  const tier = task.modelTier || null;

  if (assignee !== generic) return { reason: 'explicit-assignee', tier };
  if (!tier) return { reason: 'no-tier', tier: null };

  const picked = workers.find((w) => Array.isArray(w.tiers) && w.tiers.includes(tier));
  if (!picked) return { reason: 'no-worker-match', tier };

  return { reason: 'routed', tier, workerId: picked.id };
}
