/**
 * Month-to-date metered spend per project (#1653, Phase A-2).
 *
 * IO companion to the pure budget-gate.ts. Queries the #1641 dispatch ledger
 * tables directly with a calendar-month-aligned window (getCostAnalytics's
 * windowDays is a rolling window — not month-aligned — so we reuse its
 * attribution JOIN shape but anchor at date_trunc('month', now())).
 *
 * Contract:
 *   - Returns { projectId: usd } for metered cost only (cost_estimate IS NOT
 *     NULL rows; unattributed calls are excluded — they surface in /usage,
 *     never in enforcement).
 *   - Returns null on ANY error or when Postgres is absent (fail-open:
 *     budget enforcement must never take down dispatch).
 *   - In-module 60s cache so per-pass callers stay cheap even if several
 *     scheduling passes overlap.
 */
import { DEFAULT_WORKSPACE_ID } from '@/lib/workspace-auth';
import type { ProjectSpendSnapshot } from '@/lib/budget-gate';

let poolPromise: Promise<any> | null = null;

async function getPool(): Promise<any> {
  if (!process.env.DATABASE_URL) return null;
  if (!poolPromise) {
    poolPromise = (async () => {
      const { Pool } = await import('pg');
      return new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    })();
  }
  return poolPromise;
}

interface CacheEntry {
  at: number;
  value: ProjectSpendSnapshot | null;
}

const CACHE_TTL_MS = 60_000;
let cache: CacheEntry | null = null;

/** Test hook — clears the cache and (optionally) injects a fake pool. */
export function __resetBudgetSpendForTest(fakePool?: any): void {
  cache = null;
  poolPromise = fakePool ? Promise.resolve(fakePool) : null;
}

export async function getMonthlyProjectSpend(
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<ProjectSpendSnapshot | null> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;

  try {
    const pool = await getPool();
    if (!pool) {
      cache = { at: now, value: null };
      return null;
    }

    // Same ticket_fingerprint → task → project attribution as the #1644
    // byProject rollup, but month-to-date instead of a rolling window.
    const result = await pool.query(
      `WITH attributed AS (
         SELECT
           mc.cost_estimate,
           NULLIF(split_part(split_part(l.ticket_fingerprint, ',', 1), ':', 1), '')::bigint AS ticket_number
         FROM org_studio_dispatch_model_calls mc
         JOIN org_studio_dispatch_ledger l ON l.dispatch_id = mc.dispatch_id
         WHERE mc.workspace_id = $1
           AND mc.called_at >= date_trunc('month', now())
           AND mc.cost_estimate IS NOT NULL
           AND l.ticket_fingerprint ~ '^[0-9]+:'
       )
       SELECT t.project_id, COALESCE(sum(a.cost_estimate), 0)::numeric AS cost
       FROM attributed a
       JOIN org_studio_tasks t
         ON t.ticket_number = a.ticket_number AND t.workspace_id = $1
       WHERE t.project_id IS NOT NULL
       GROUP BY t.project_id`,
      [workspaceId],
    );

    const snapshot: ProjectSpendSnapshot = {};
    for (const row of result.rows || []) {
      const cost = Number(row.cost);
      if (row.project_id && Number.isFinite(cost)) snapshot[row.project_id] = cost;
    }
    cache = { at: now, value: snapshot };
    return snapshot;
  } catch (e) {
    console.warn('[budget-spend] month-to-date rollup failed (fail-open, no enforcement this pass):', e);
    cache = { at: now, value: null };
    return null;
  }
}
