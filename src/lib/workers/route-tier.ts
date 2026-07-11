import type { ModelTier } from '@/lib/model-tier';
import type { WorkerConfig } from './config';

interface RouteTierInput {
  assignee?: string | null;
  modelTier?: ModelTier | null;
  workers: Array<Pick<WorkerConfig, 'id' | 'tiers'>>;
}

export interface RouteTierDecision {
  assignee: string;
  tier: ModelTier | null;
  routedWorkerId?: string;
  reason:
    | 'non-generic-assignee'
    | 'missing-tier'
    | 'no-match'
    | 'tier-routed';
}

function isGenericWorkerAssignee(raw: string): boolean {
  return raw.trim().toLowerCase() === 'worker';
}

/**
 * Pure routing decision for generic worker tickets with modelTier.
 *
 * Rules:
 * - explicit assignees win (only assignee='worker' is routable)
 * - missing tier or no tier-match fails open (keeps original assignee)
 * - first configured match wins (config order = cheapest-first)
 */
export function routeTieredWorker(input: RouteTierInput): RouteTierDecision {
  const assignee = String(input.assignee || '');
  const tier = input.modelTier ?? null;

  if (!isGenericWorkerAssignee(assignee)) {
    return {
      assignee,
      tier,
      reason: 'non-generic-assignee',
    };
  }

  if (!tier) {
    return {
      assignee,
      tier: null,
      reason: 'missing-tier',
    };
  }

  const routed = (input.workers || []).find(
    (worker) => worker.id.startsWith('worker-') && Array.isArray(worker.tiers) && worker.tiers.includes(tier),
  );

  if (!routed) {
    return {
      assignee,
      tier,
      reason: 'no-match',
    };
  }

  return {
    assignee: routed.id,
    tier,
    routedWorkerId: routed.id,
    reason: 'tier-routed',
  };
}
