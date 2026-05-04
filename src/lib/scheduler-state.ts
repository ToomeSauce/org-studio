/**
 * scheduler-state.ts \u2014 process-memory state snapshot for the scheduler
 * (in-flight tracking, debounce map, last sweep summary).
 *
 * Source of truth is `src/app/api/scheduler/route.ts`. This module
 * exposes a *separate* state container only used as a shared sink the
 * scheduler route can write into and the read-only /api/scheduler/status
 * route can read from. Keeping it out of the route file avoids
 * route\u2194route imports (each Next route is its own module boundary).
 *
 * Per #983 constraint: no new tables, in-memory only.
 */

const lastTriggerByAgent: Record<string, number> = {};

export interface SweepResult {
  agentId: string;
  reason: string;
  triggered: boolean;
}

export interface SweepSummary {
  finishedAt: number;
  durationMs: number;
  checked: number;
  triggered: number;
  results: SweepResult[];
}

let lastSweep: SweepSummary | null = null;

let triggerCooldownMs = 60_000;

export function setTriggerCooldownMs(ms: number) {
  triggerCooldownMs = ms;
}

export function recordTrigger(agentId: string, ts: number = Date.now()): void {
  lastTriggerByAgent[agentId] = ts;
}

export function getLastTrigger(agentId: string): number {
  return lastTriggerByAgent[agentId] || 0;
}

export function recordSweep(summary: SweepSummary): void {
  lastSweep = summary;
}

export function getSchedulerStateSnapshot() {
  return {
    triggerCooldownMs,
    lastTriggerByAgent: { ...lastTriggerByAgent },
    lastSweep: lastSweep ? { ...lastSweep, results: lastSweep.results.slice() } : null,
  };
}
