/**
 * schedule-registry.ts — #1642 (T2 observability: schedule registry + drift).
 *
 * One inventory of every recurring mechanism in the system, each entry
 * classified by cost class, plus a reconcile pass that flags:
 *
 *   ORPHANS — schedules the gateway runs that Org Studio didn't declare
 *             (exactly what #1633's manual cleanup found: legacy
 *             `Scheduler:` crons still firing heavy agentTurns).
 *   ZOMBIES — schedules Org Studio declares but that never fire
 *             (enabled loop with no heartbeat, dead interval).
 *
 * Sources inventoried:
 *   1. Org Studio loops (settings.loops) — logical dispatch loops.
 *   2. Gateway cron jobs (via rpc cron.list) — anything OpenClaw schedules.
 *   3. server.mjs internal intervals — declared STATICALLY below (they are
 *      code, not data; the registry mirrors what server.mjs starts). When
 *      adding a setInterval to server.mjs, add a row here. The drift test
 *      guards the inverse direction (removing one without updating here).
 *
 * Cost classes (#1633 taxonomy):
 *   no-op      — timer bookkeeping only (WS keepalive, lock checks)
 *   query      — DB/HTTP reads, no model call
 *   model-call — triggers agent turns / LLM inference. These are the
 *                expensive ones; by default there should be ZERO
 *                unconditional model-call schedules (#1633 invariant —
 *                dispatch loops are push-based; the sweep only fires
 *                dispatches when work exists).
 *
 * Constraint (ticket): the reconcile itself must be query-class — read-only
 * RPC + store reads, never a model call.
 */

import { rpc } from './gateway-rpc';
import { LEGACY_SCHEDULER_CRON_PREFIX } from './scheduler-dispatch-policy';

export type CostClass = 'no-op' | 'query' | 'model-call';

export interface ScheduleEntry {
  id: string;
  source: 'org-studio-loop' | 'gateway-cron' | 'server-interval';
  name: string;
  owner: string | null;
  intervalDescription: string;
  costClass: CostClass;
  enabled: boolean;
  lastFire: string | null; // ISO timestamp when known, else null
  detail?: string;
}

export interface DriftFinding {
  kind: 'orphan' | 'zombie';
  scheduleId: string;
  source: ScheduleEntry['source'];
  name: string;
  explanation: string;
}

export interface ScheduleRegistrySnapshot {
  generatedAt: string;
  entries: ScheduleEntry[];
  findings: DriftFinding[];
  gatewayReachable: boolean;
  /**
   * #1633 regression guard — counts enabled model-call schedules that ORG
   * STUDIO declares (loops, server intervals) or that drift analysis flagged
   * as scheduler orphans. Expected 0. Operator-owned gateway crons (trading
   * runs, email checks, reports) are model-call by design and are counted
   * separately in operatorModelCallCrons — informational, not a violation.
   */
  modelCallScheduleCount: number;
  operatorModelCallCrons: number;
}

/**
 * Static declaration of server.mjs internal intervals. Mirrors the
 * setInterval sites in server.mjs + lib/*.mjs. Keep in sync when adding
 * or removing timers there (test: schedule-registry-1642.test.ts pins
 * this list's cost-class invariant, not the line numbers).
 */
export const SERVER_INTERVALS: Omit<ScheduleEntry, 'lastFire'>[] = [
  { id: 'srv-pubsub-heartbeat', source: 'server-interval', name: 'Postgres LISTEN heartbeat', owner: 'system', intervalDescription: '30s', costClass: 'query', enabled: true, detail: 'NOTIFY keepalive on the LISTEN connection' },
  { id: 'srv-ws-keepalive', source: 'server-interval', name: 'WebSocket keepalive sweep', owner: 'system', intervalDescription: '30s', costClass: 'no-op', enabled: true },
  { id: 'srv-gateway-poll', source: 'server-interval', name: 'Gateway state poll (agents/cron broadcast)', owner: 'system', intervalDescription: '~30s', costClass: 'query', enabled: true },
  { id: 'srv-skill-drift-check', source: 'server-interval', name: 'Skill install-ping drift check (#861)', owner: 'system', intervalDescription: '1h', costClass: 'query', enabled: true },
  { id: 'srv-roadmap-reconcile', source: 'server-interval', name: 'Roadmap reconcile (#982)', owner: 'system', intervalDescription: '15m', costClass: 'query', enabled: true },
  { id: 'srv-daily-metrics', source: 'server-interval', name: 'Daily metrics compute', owner: 'system', intervalDescription: '24h (midnight)', costClass: 'query', enabled: true },
  { id: 'srv-watchdog', source: 'server-interval', name: 'Stale-task / vision-cycle watchdog', owner: 'system', intervalDescription: '30m', costClass: 'query', enabled: true, detail: 'Can TRIGGER dispatches (indirect model-call) when it finds stalls; the dispatch itself is ledgered (#1641)' },
  { id: 'srv-gateway-disconnect-monitor', source: 'server-interval', name: 'Gateway disconnect monitor', owner: 'system', intervalDescription: '5m', costClass: 'query', enabled: true },
  { id: 'srv-dead-letter-monitor', source: 'server-interval', name: 'Outbox dead-letter monitor', owner: 'system', intervalDescription: '5m', costClass: 'query', enabled: true },
  { id: 'srv-notify-prune', source: 'server-interval', name: 'Notification dedup/audit prune', owner: 'system', intervalDescription: '1h', costClass: 'query', enabled: true },
  { id: 'srv-listen-stale-monitor', source: 'server-interval', name: 'LISTEN stale monitor', owner: 'system', intervalDescription: '5m', costClass: 'query', enabled: true },
  { id: 'srv-outbox-drain', source: 'server-interval', name: 'Outbox drain worker', owner: 'system', intervalDescription: '~5s tick', costClass: 'query', enabled: true, detail: 'Delivers already-decided dispatch messages; the decision (model-call) is ledgered upstream' },
  { id: 'srv-outbox-prune', source: 'server-interval', name: 'Outbox sent-row prune', owner: 'system', intervalDescription: 'periodic', costClass: 'query', enabled: true },
  { id: 'srv-heartbeats-tick', source: 'server-interval', name: 'Agent heartbeat staleness tick (lib/heartbeats)', owner: 'system', intervalDescription: 'periodic', costClass: 'query', enabled: true, detail: 'Can TRIGGER restart dispatches; those are ledgered (#1641)' },
  { id: 'srv-schedule-drift-reconcile', source: 'server-interval', name: 'Schedule-drift reconcile (#1642)', owner: 'system', intervalDescription: '24h', costClass: 'query', enabled: true, detail: 'This registry\'s own daily tick — self-inventoried' },
];

/** Classify a gateway cron job's cost class from its payload shape. */
export function classifyGatewayCron(job: any): CostClass {
  const kind = job?.payload?.kind;
  if (kind === 'agentTurn') return 'model-call';
  if (kind === 'systemEvent') return 'query'; // injects text; the receiving heartbeat may act, but the cron itself is cheap
  return 'query';
}

/**
 * Drift analysis. Pure function over the three sources — testable without
 * a live gateway.
 */
export function analyzeDrift(args: {
  loops: Array<{ agentId: string; enabled: boolean; cronJobId?: string | null }>;
  gatewayJobs: Array<{ id: string; name?: string; enabled?: boolean; payload?: any }>;
  heartbeatsByAgent?: Record<string, { lastFire: string | null }>;
}): DriftFinding[] {
  const findings: DriftFinding[] = [];

  // ORPHANS — legacy `Scheduler:` crons on the gateway that no loop references
  // (#1633's exact failure shape). Any OTHER gateway cron is presumed
  // operator-owned (reminders etc.) and NOT flagged — we only police the
  // namespace Org Studio historically created.
  const referencedCronIds = new Set(
    args.loops.map((l) => l.cronJobId).filter(Boolean) as string[],
  );
  for (const job of args.gatewayJobs) {
    const name = job.name || '';
    if (name.startsWith(LEGACY_SCHEDULER_CRON_PREFIX) && !referencedCronIds.has(job.id)) {
      findings.push({
        kind: 'orphan',
        scheduleId: job.id,
        source: 'gateway-cron',
        name,
        explanation: `Legacy scheduler cron on the gateway not referenced by any Org Studio loop (the #1633 shape). Run scheduler sync to remove it.`,
      });
    }
    // Heavy agentTurn crons that Org Studio didn't create get surfaced as
    // orphans too when they carry the legacy prefix-less scheduler fingerprint.
    if (!name.startsWith(LEGACY_SCHEDULER_CRON_PREFIX) &&
        job?.payload?.kind === 'agentTurn' &&
        /SCHEDULER_LOOP|autonomous work cycle/i.test(String(job?.payload?.message || ''))) {
      findings.push({
        kind: 'orphan',
        scheduleId: job.id,
        source: 'gateway-cron',
        name: name || job.id,
        explanation: 'Gateway cron fires a full scheduler work-loop agentTurn outside Org Studio loop management — exactly the heavy pattern #1633 removed.',
      });
    }
  }

  // ZOMBIES — enabled loops that have not fired within a generous window.
  // Loops are push-based post-#1633, so "never fires" is only a zombie
  // signal when the agent HAS had backlog activity; without heartbeat data
  // we stay conservative and only flag loops with a recorded lastFire older
  // than 7 days (null lastFire = presumed push-idle, not flagged).
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  for (const loop of args.loops) {
    if (!loop.enabled) continue;
    const hb = args.heartbeatsByAgent?.[loop.agentId];
    if (hb?.lastFire) {
      const age = Date.now() - new Date(hb.lastFire).getTime();
      if (age > SEVEN_DAYS_MS) {
        findings.push({
          kind: 'zombie',
          scheduleId: `loop-${loop.agentId}`,
          source: 'org-studio-loop',
          name: `Loop: ${loop.agentId}`,
          explanation: `Enabled loop last fired ${Math.round(age / 86400000)}d ago. Either the agent has no work (fine) or dispatch to it is broken (check /api/dispatch-health/${loop.agentId}).`,
        });
      }
    }
  }

  return findings;
}

/**
 * Build the full registry snapshot. Query-class only: store read + one
 * gateway RPC + one heartbeat query. Never dispatches, never model-calls.
 */
export async function buildScheduleRegistry(deps: {
  loops: Array<{ agentId: string; enabled: boolean; intervalMinutes?: number; cronJobId?: string | null }>;
  heartbeatsByAgent?: Record<string, { lastFire: string | null }>;
  /** Injectable for tests; defaults to live gateway rpc. */
  listGatewayJobs?: () => Promise<any[]>;
}): Promise<ScheduleRegistrySnapshot> {
  let gatewayJobs: any[] = [];
  let gatewayReachable = true;
  try {
    const list = deps.listGatewayJobs
      ? await deps.listGatewayJobs()
      : (await rpc('cron.list', { includeDisabled: true }))?.jobs || [];
    gatewayJobs = Array.isArray(list) ? list : [];
  } catch {
    gatewayReachable = false;
  }

  const entries: ScheduleEntry[] = [];

  for (const loop of deps.loops) {
    const hb = deps.heartbeatsByAgent?.[loop.agentId];
    entries.push({
      id: `loop-${loop.agentId}`,
      source: 'org-studio-loop',
      name: `Dispatch loop: ${loop.agentId}`,
      owner: loop.agentId,
      intervalDescription: `push-based (sweep backstop ${loop.intervalMinutes ?? '?'}m)`,
      // The loop mechanism itself is query-class: push events + sweep checks.
      // Actual dispatches it decides to fire are model-call and ledgered (#1641).
      costClass: 'query',
      enabled: !!loop.enabled,
      lastFire: hb?.lastFire ?? null,
    });
  }

  for (const job of gatewayJobs) {
    entries.push({
      id: job.id,
      source: 'gateway-cron',
      name: job.name || job.id,
      owner: job.agentId || null,
      intervalDescription: describeGatewaySchedule(job.schedule),
      costClass: classifyGatewayCron(job),
      enabled: job.enabled !== false,
      lastFire: job.lastRunAt ? new Date(job.lastRunAt).toISOString() : null,
    });
  }

  for (const si of SERVER_INTERVALS) {
    entries.push({ ...si, lastFire: null });
  }

  const findings = analyzeDrift({
    loops: deps.loops,
    gatewayJobs,
    heartbeatsByAgent: deps.heartbeatsByAgent,
  });

  // #1633 guard scope: Org Studio's own declared schedules + orphaned
  // scheduler crons. Operator crons are model-call by design — informational.
  const orphanIds = new Set(findings.filter((f) => f.kind === 'orphan').map((f) => f.scheduleId));
  const modelCallScheduleCount = entries.filter(
    (e) =>
      e.costClass === 'model-call' &&
      e.enabled &&
      (e.source !== 'gateway-cron' || orphanIds.has(e.id)),
  ).length;
  const operatorModelCallCrons = entries.filter(
    (e) =>
      e.costClass === 'model-call' &&
      e.enabled &&
      e.source === 'gateway-cron' &&
      !orphanIds.has(e.id),
  ).length;

  return {
    generatedAt: new Date().toISOString(),
    entries,
    findings,
    gatewayReachable,
    modelCallScheduleCount,
    operatorModelCallCrons,
  };
}

function describeGatewaySchedule(schedule: any): string {
  if (!schedule) return 'unknown';
  if (schedule.kind === 'cron') return `cron ${schedule.expr}${schedule.tz ? ` (${schedule.tz})` : ''}`;
  if (schedule.kind === 'every') return `every ${Math.round((schedule.everyMs || 0) / 60000)}m`;
  if (schedule.kind === 'at') return `once at ${schedule.at}`;
  return 'unknown';
}

// ── Findings persistence ───────────────────────────────────────────

let _findingsPool: any = undefined;
let _findingsTableEnsured = false;

async function getFindingsPool(): Promise<any> {
  if (_findingsPool !== undefined) return _findingsPool;
  if (!process.env.DATABASE_URL) { _findingsPool = null; return null; }
  try {
    const pg = await import('pg');
    const Pool = (pg as any).default?.Pool || (pg as any).Pool;
    _findingsPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    return _findingsPool;
  } catch {
    _findingsPool = null;
    return null;
  }
}

/** Test hook. */
export function __setFindingsPoolForTest(pool: any): void {
  _findingsPool = pool;
  _findingsTableEnsured = true;
}

/**
 * Persist the latest reconcile result (full snapshot replace — findings are
 * a CURRENT-state view, not an event log; resolved findings disappear).
 * Fire-and-forget; additive DDL only.
 */
export function persistFindings(findings: DriftFinding[], generatedAt: string): void {
  void (async () => {
    try {
      const pool = await getFindingsPool();
      if (!pool) return;
      const client = await pool.connect();
      try {
        if (!_findingsTableEnsured) {
          await client.query(`
            CREATE TABLE IF NOT EXISTS org_studio_schedule_drift_findings (
              id BIGSERIAL PRIMARY KEY,
              kind TEXT NOT NULL,
              schedule_id TEXT NOT NULL,
              source TEXT NOT NULL,
              name TEXT NOT NULL,
              explanation TEXT,
              reconciled_at TIMESTAMPTZ NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_schedule_drift_reconciled
              ON org_studio_schedule_drift_findings (reconciled_at DESC);
          `);
          _findingsTableEnsured = true;
        }
        // Replace-current semantics: delete previous snapshot, insert new.
        // Transactional — two concurrent reconciles interleaving delete/insert
        // otherwise leave a partial findings set (observed on first deploy).
        await client.query('BEGIN');
        try {
          await client.query(`DELETE FROM org_studio_schedule_drift_findings`);
          for (const f of findings) {
            await client.query(
              `INSERT INTO org_studio_schedule_drift_findings
                 (kind, schedule_id, source, name, explanation, reconciled_at)
               VALUES ($1,$2,$3,$4,$5,$6)`,
              [f.kind, f.scheduleId, f.source, f.name, f.explanation, generatedAt],
            );
          }
          await client.query('COMMIT');
        } catch (txErr) {
          await client.query('ROLLBACK').catch(() => {});
          throw txErr;
        }
      } finally {
        client.release();
      }
    } catch (e: any) {
      console.error('[ScheduleRegistry] persistFindings failed:', e?.message || e);
    }
  })();
}
