/**
 * dispatch-attempts.ts — #1184 dispatch fizzle visibility.
 *
 * Logs every /api/scheduler { trigger } call to Postgres so the dashboard
 * can answer "why is this ticket sitting in backlog?". One row per call.
 * Retention: 7 days rolling, pruned opportunistically on write.
 *
 * Failure mode coverage:
 *   - Adhoc/no-version tickets       → top_blocker = 'no-section-version'
 *   - Stopped projects                → top_blocker = 'project-stopped'
 *   - Above approval horizon          → top_blocker = 'above-horizon'
 *   - Unsatisfied waitsFor edges      → top_blocker = 'waitsfor'
 *   - Prior version unshipped         → top_blocker = 'prior-version-unshipped'
 *
 * Read path: /api/dispatch-health/{agentId} (60min outcome breakdown).
 */

import {
  isTaskAnyDispatchEligible,
  isTaskWaiting,
} from './dispatch-gate';

let _pool: any = undefined;

async function getPool(): Promise<any> {
  if (_pool !== undefined) return _pool;
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    _pool = null;
    return null;
  }
  try {
    const pg = await import('pg');
    const Pool = (pg as any).default?.Pool || (pg as any).Pool;
    _pool = new Pool({ connectionString: dbUrl, max: 3 });
    return _pool;
  } catch (e: any) {
    console.error('[DispatchAttempts] Failed to create pool:', e.message);
    _pool = null;
    return null;
  }
}

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS org_studio_dispatch_attempts (
    id BIGSERIAL PRIMARY KEY,
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    agent_id TEXT NOT NULL,
    trigger_source TEXT NOT NULL,
    outcome TEXT NOT NULL,
    reason TEXT,
    task_count_backlog INTEGER NOT NULL DEFAULT 0,
    task_count_blocked_by_gate INTEGER NOT NULL DEFAULT 0,
    top_blocker TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_dispatch_attempts_agent_time
    ON org_studio_dispatch_attempts (agent_id, attempted_at DESC);
`;

/**
 * Stable enum of fizzle reasons. Anything mapping to one of these is
 * actionable on the dashboard. Add new enum members here and keep the
 * dashboard's reason-label map in sync (src/components/DispatchHealth.tsx).
 */
export const TRIGGER_SOURCES = [
  'addTask',
  'listen',
  'sweep',
  'watchdog',
  'manual',
  'unknown',
] as const;
export type TriggerSource = (typeof TRIGGER_SOURCES)[number];

export const OUTCOMES = ['dispatched', 'skipped'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const SKIP_REASONS = [
  'cooldown',
  'no-actionable-work',
  'in-flight',
  'gateway-down',
  'stalled-paused',
  'loop-disabled',
  'unknown',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export const TOP_BLOCKERS = [
  'project-stopped',
  'no-section-version',
  'above-horizon',
  'waitsfor',
  'prior-version-unshipped',
  'no-backlog',
  'unassigned',
  'archived-or-paused',
  'unknown',
] as const;
export type TopBlocker = (typeof TOP_BLOCKERS)[number];

export interface DispatchAttempt {
  agentId: string;
  triggerSource: TriggerSource;
  outcome: Outcome;
  reason?: SkipReason;
  taskCountBacklog: number;
  taskCountBlockedByGate: number;
  topBlocker?: TopBlocker;
}

interface StoreLike {
  projects?: any[];
  tasks?: any[];
}

/**
 * Diagnose the top reason an agent's backlog isn't dispatching. Returns
 * counts + the most-common blocker. Designed to be cheap (no DB calls):
 * runs over the in-memory store snapshot the caller already has.
 */
export function diagnoseAgentBacklog(
  store: StoreLike,
  agentId: string,
  agentName: string,
): {
  taskCountBacklog: number;
  taskCountBlockedByGate: number;
  topBlocker: TopBlocker;
  blockerBreakdown: Record<TopBlocker, number>;
} {
  const nameLower = (agentName || '').toLowerCase();
  const idLower = (agentId || '').toLowerCase();

  const breakdown: Record<TopBlocker, number> = {
    'project-stopped': 0,
    'no-section-version': 0,
    'above-horizon': 0,
    waitsfor: 0,
    'prior-version-unshipped': 0,
    'no-backlog': 0,
    unassigned: 0,
    'archived-or-paused': 0,
    unknown: 0,
  };

  const myBacklog = (store.tasks || []).filter((t: any) => {
    const a = (t.assignee || '').toLowerCase();
    if (!(a === nameLower || a === idLower)) return false;
    if (t.status !== 'backlog') return false;
    return true;
  });

  if (myBacklog.length === 0) {
    breakdown['no-backlog'] = 1;
    return {
      taskCountBacklog: 0,
      taskCountBlockedByGate: 0,
      topBlocker: 'no-backlog',
      blockerBreakdown: breakdown,
    };
  }

  let blockedByGate = 0;
  for (const t of myBacklog) {
    if (isTaskAnyDispatchEligible(store as any, t)) continue; // not blocked

    blockedByGate++;
    const reason = classifyBlocker(store, t);
    breakdown[reason]++;
  }

  // Pick the blocker with highest count (deterministic — first key in
  // declaration order wins ties).
  let topBlocker: TopBlocker = 'unknown';
  let topCount = 0;
  for (const key of Object.keys(breakdown) as TopBlocker[]) {
    if (breakdown[key] > topCount) {
      topCount = breakdown[key];
      topBlocker = key;
    }
  }

  return {
    taskCountBacklog: myBacklog.length,
    taskCountBlockedByGate: blockedByGate,
    topBlocker,
    blockerBreakdown: breakdown,
  };
}

/**
 * Classify why a single backlog task isn't dispatching. Mirrors the
 * order of guards in isTaskDispatchEligible() / isTaskAdhocDispatchEligible()
 * so the reason is actionable.
 */
export function classifyBlocker(store: StoreLike, task: any): TopBlocker {
  if (!task?.assignee) return 'unassigned';
  if (task.isArchived || task.loopPausedAt) return 'archived-or-paused';
  if (!task.projectId) return 'no-section-version';

  const proj = (store.projects || []).find((p: any) => p.id === task.projectId);
  if (!proj) return 'unknown';

  // #1185 rename: 'stopped' → 'inactive'. The top_blocker enum value
  // 'project-stopped' is intentionally preserved as a stable data identifier
  // (already written to org_studio_dispatch_attempts rows). UI translates.
  // Project is dispatchable when state is 'active' or legacy 'started'; any
  // other value (including undefined) is treated as inactive for safety.
  const projState = (proj as any).state;
  if (projState !== 'active' && projState !== 'started') return 'project-stopped';

  // Adhoc lane: needs taskType ∈ ADHOC. If not adhoc and missing version
  // info, that's the gap.
  const ADHOC = new Set(['bug', 'chore', 'spike', 'followup']);
  if (task.taskType && ADHOC.has(task.taskType)) {
    // Adhoc on started project should be eligible — if we got here something
    // upstream is wrong. Default to unknown so it shows up for triage.
    return 'unknown';
  }

  if (!task.sectionId || !task.version) return 'no-section-version';

  // Component-level horizon check
  const components = (proj as any).components || (proj as any).sections || [];
  const cmp = components.find((c: any) => c.id === task.sectionId);
  if (!cmp) return 'no-section-version';

  const approvedThrough = cmp.approvedThrough || cmp.approved_through;
  if (!approvedThrough) return 'above-horizon';

  // Check waitsFor before climbing the version queue (keep classification
  // narrow — if waitsFor is the gate, surface that).
  const waitsFor = task.waitsFor || task.waits_for;
  if (Array.isArray(waitsFor) && waitsFor.length > 0) {
    const tasks = store.tasks || [];
    const unsatisfied = waitsFor.some((w: any) => {
      const dep = tasks.find((d: any) => d.id === w);
      return !dep || dep.status !== 'done';
    });
    if (unsatisfied) return 'waitsfor';
  }

  // Compare task.version vs approvedThrough using a tolerant numeric sort
  // (semver-ish). If task.version > approvedThrough → above-horizon.
  if (compareVersionsTolerant(task.version, approvedThrough) > 0) {
    return 'above-horizon';
  }

  // If we got here, version is in horizon → must be prior-version
  // unshipped.
  return 'prior-version-unshipped';
}

function compareVersionsTolerant(a: string, b: string): number {
  const pa = String(a).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/**
 * Record one dispatch attempt. Best-effort: never throws to the caller
 * (logging is observability, not load-bearing).
 */
export async function recordDispatchAttempt(
  attempt: DispatchAttempt,
): Promise<{ ok: boolean; reason?: string }> {
  const p = await getPool();
  if (!p) return { ok: false, reason: 'no-db' };

  const insert = async () => {
    await p.query(
      `INSERT INTO org_studio_dispatch_attempts
       (agent_id, trigger_source, outcome, reason,
        task_count_backlog, task_count_blocked_by_gate, top_blocker)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        attempt.agentId,
        attempt.triggerSource,
        attempt.outcome,
        attempt.reason || null,
        attempt.taskCountBacklog,
        attempt.taskCountBlockedByGate,
        attempt.topBlocker || null,
      ],
    );
  };

  try {
    await insert();
  } catch (e: any) {
    if (/does not exist|relation/i.test(e?.message || '')) {
      try {
        await p.query(CREATE_TABLE);
        await insert();
      } catch (e2: any) {
        console.error('[DispatchAttempts] insert failed:', e2.message);
        return { ok: false, reason: e2.message };
      }
    } else {
      console.error('[DispatchAttempts] insert failed:', e.message);
      return { ok: false, reason: e.message };
    }
  }

  // Opportunistic 7-day retention prune. Cheap when the index exists; we
  // run it ~5% of the time to avoid contention.
  if (Math.random() < 0.05) {
    try {
      await p.query(
        `DELETE FROM org_studio_dispatch_attempts
         WHERE attempted_at < NOW() - INTERVAL '7 days'`,
      );
    } catch (e: any) {
      console.warn('[DispatchAttempts] prune skipped:', e.message);
    }
  }

  return { ok: true };
}

/**
 * Returns last 60min outcome breakdown for an agent. Used by
 * /api/dispatch-health/{agentId} and the dashboard banner.
 */
export interface DispatchHealth {
  agentId: string;
  windowMinutes: number;
  totalAttempts: number;
  dispatched: number;
  skipped: number;
  bySkipReason: Record<string, number>;
  byTopBlocker: Record<string, number>;
  lastAttempt: { at: string; outcome: Outcome; reason?: string } | null;
  lastDispatch: { at: string } | null;
  staleBacklog: boolean; // true if backlog ≥1 AND zero dispatches in window
}

export async function getDispatchHealth(
  agentId: string,
  windowMinutes = 60,
): Promise<DispatchHealth | null> {
  const p = await getPool();
  if (!p) return null;

  try {
    const rows = await p.query(
      `SELECT attempted_at, outcome, reason, top_blocker, task_count_backlog
       FROM org_studio_dispatch_attempts
       WHERE agent_id = $1 AND attempted_at >= NOW() - ($2 || ' minutes')::INTERVAL
       ORDER BY attempted_at DESC`,
      [agentId, String(windowMinutes)],
    );

    const lastAttempt = rows.rows[0]
      ? {
          at: rows.rows[0].attempted_at.toISOString(),
          outcome: rows.rows[0].outcome as Outcome,
          reason: rows.rows[0].reason || undefined,
        }
      : null;

    const lastDispatchRow = rows.rows.find((r: any) => r.outcome === 'dispatched');
    const lastDispatch = lastDispatchRow
      ? { at: lastDispatchRow.attempted_at.toISOString() }
      : null;

    const bySkipReason: Record<string, number> = {};
    const byTopBlocker: Record<string, number> = {};
    let dispatched = 0;
    let skipped = 0;
    let lastBacklogSeen = 0;
    let nonMutedSkips = 0; // skips that aren't user-intentional silencings

    for (const r of rows.rows) {
      if (r.outcome === 'dispatched') dispatched++;
      else {
        skipped++;
        const reason = r.reason || 'unknown';
        bySkipReason[reason] = (bySkipReason[reason] || 0) + 1;
        // 'loop-disabled' is intentional muting (operator action), not a
        // dispatch failure. Don't count it toward staleBacklog — we'd be
        // alerting on a state the operator just set themselves.
        if (reason !== 'loop-disabled') nonMutedSkips++;
      }
      if (r.top_blocker) {
        byTopBlocker[r.top_blocker] = (byTopBlocker[r.top_blocker] || 0) + 1;
      }
      if (typeof r.task_count_backlog === 'number') {
        lastBacklogSeen = Math.max(lastBacklogSeen, r.task_count_backlog);
      }
    }

    const staleBacklog =
      lastBacklogSeen >= 1 && dispatched === 0 && nonMutedSkips >= 1;

    return {
      agentId,
      windowMinutes,
      totalAttempts: rows.rows.length,
      dispatched,
      skipped,
      bySkipReason,
      byTopBlocker,
      lastAttempt,
      lastDispatch,
      staleBacklog,
    };
  } catch (e: any) {
    if (/does not exist|relation/i.test(e?.message || '')) {
      // Table not yet created → no health data.
      return {
        agentId,
        windowMinutes,
        totalAttempts: 0,
        dispatched: 0,
        skipped: 0,
        bySkipReason: {},
        byTopBlocker: {},
        lastAttempt: null,
        lastDispatch: null,
        staleBacklog: false,
      };
    }
    console.error('[DispatchAttempts] getDispatchHealth failed:', e.message);
    return null;
  }
}

/**
 * Stale-backlog check across all agents. Returns agents whose backlog has
 * been idle ≥ thresholdMinutes (default 24h for Telegram escalation).
 */
export async function findStaleBacklogAgents(
  thresholdMinutes = 24 * 60,
): Promise<Array<{ agentId: string; lastDispatchAt: string | null; backlogCount: number }>> {
  const p = await getPool();
  if (!p) return [];

  try {
    const rows = await p.query(
      `WITH latest AS (
         SELECT DISTINCT ON (agent_id) agent_id, attempted_at, outcome, task_count_backlog
         FROM org_studio_dispatch_attempts
         WHERE attempted_at >= NOW() - INTERVAL '7 days'
         ORDER BY agent_id, attempted_at DESC
       ),
       last_dispatch AS (
         SELECT DISTINCT ON (agent_id) agent_id, attempted_at AS last_dispatch_at
         FROM org_studio_dispatch_attempts
         WHERE outcome = 'dispatched'
         ORDER BY agent_id, attempted_at DESC
       )
       SELECT l.agent_id,
              ld.last_dispatch_at,
              l.task_count_backlog
       FROM latest l
       LEFT JOIN last_dispatch ld ON ld.agent_id = l.agent_id
       WHERE l.task_count_backlog >= 1
         AND (ld.last_dispatch_at IS NULL
              OR ld.last_dispatch_at < NOW() - ($1 || ' minutes')::INTERVAL)`,
      [String(thresholdMinutes)],
    );

    return rows.rows.map((r: any) => ({
      agentId: r.agent_id,
      lastDispatchAt: r.last_dispatch_at ? r.last_dispatch_at.toISOString() : null,
      backlogCount: r.task_count_backlog || 0,
    }));
  } catch (e: any) {
    if (/does not exist|relation/i.test(e?.message || '')) return [];
    console.error('[DispatchAttempts] findStaleBacklogAgents failed:', e.message);
    return [];
  }
}
