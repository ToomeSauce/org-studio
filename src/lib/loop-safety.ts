/**
 * #1587 — Visible loop safety caps (Phase D of experiment-loop legibility).
 *
 * Phase D adds NO new caps and NO new leash. It just makes the EXISTING
 * autonomy machinery legible on the version card:
 *   - loopPaused          — the human kill-switch (already enforced)
 *   - open-experiments cap — MAX_OPEN_EXPERIMENTS (5), enforced in dispatch-gate
 *   - daily-create cap     — MAX_AUTO_TASKS_PER_VERSION_PER_DAY (3), enforced in store route
 *   - approval horizon     — component.approvedVersions[] (the single leash, post-#1224)
 *
 * "One leash" rule (ticket constraint): the approval horizon
 * (component.approvedVersions[]) IS the single leash. The legacy
 * autonomy.approvedThrough scalar was retired by #1224 — we do NOT
 * reintroduce a second parallel leash. This module only COUNTS against the
 * existing caps for display; it never enforces anything.
 *
 * Pure: counting functions mirror the enforcement sites exactly so the card
 * shows the same numbers the gates use. No clock baked in — `now` injected.
 */

import { MAX_OPEN_EXPERIMENTS, MAX_AUTO_TASKS_PER_VERSION_PER_DAY } from './version-metric';

export { MAX_OPEN_EXPERIMENTS, MAX_AUTO_TASKS_PER_VERSION_PER_DAY };

export interface CapTaskLike {
  projectId?: string;
  sectionId?: string;
  version?: string;
  status?: string;
  taskType?: string;
  createdAt?: number;
}

export interface CapScope {
  projectId?: string;
  sectionId?: string;
  version?: string;
}

/**
 * Open-experiments count for a (project, section, version) scope. Mirrors the
 * dispatch-gate cap exactly: tasks in this version with status 'in-progress'.
 */
export function countOpenExperiments(tasks: CapTaskLike[], scope: CapScope): number {
  return (tasks || []).filter(
    (t) =>
      t.projectId === scope.projectId &&
      t.sectionId === scope.sectionId &&
      t.version === scope.version &&
      t.status === 'in-progress',
  ).length;
}

/**
 * Same-UTC-day created experiment (spike) count for a (project, version)
 * scope. Mirrors the store-route daily cap exactly (note: project+version
 * only — NOT section-scoped, matching the enforcement site). `now` injected.
 */
export function countCreatedToday(tasks: CapTaskLike[], scope: CapScope, now: number): number {
  const d = new Date(now);
  const startOfUtcDay = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return (tasks || []).filter((t) => {
    if (t.projectId !== scope.projectId) return false;
    if (t.version !== scope.version) return false;
    if (t.taskType !== 'spike') return false;
    const created = typeof t.createdAt === 'number' ? t.createdAt : 0;
    return created >= startOfUtcDay;
  }).length;
}

export interface LoopSafetySummary {
  loopPaused: boolean;
  openExperiments: number;
  openCap: number;
  openAtCap: boolean;
  createdToday: number;
  dailyCap: number;
  dailyAtCap: boolean;
  /** The approval horizon strings (component.approvedVersions[]) — the single leash. */
  approvedVersions: string[];
  /** True iff THIS version is within the approval horizon. */
  withinHorizon: boolean;
}

/**
 * Build the full at-a-glance safety summary for one version. Pure; reuses the
 * count helpers so the card never disagrees with the gates.
 */
export function summarizeLoopSafety(args: {
  tasks: CapTaskLike[];
  scope: CapScope;
  loopPaused?: boolean;
  approvedVersions?: string[];
  now: number;
}): LoopSafetySummary {
  const { tasks, scope, loopPaused, approvedVersions, now } = args;
  const open = countOpenExperiments(tasks, scope);
  const today = countCreatedToday(tasks, scope, now);
  const approved = approvedVersions || [];
  return {
    loopPaused: !!loopPaused,
    openExperiments: open,
    openCap: MAX_OPEN_EXPERIMENTS,
    openAtCap: open >= MAX_OPEN_EXPERIMENTS,
    createdToday: today,
    dailyCap: MAX_AUTO_TASKS_PER_VERSION_PER_DAY,
    dailyAtCap: today >= MAX_AUTO_TASKS_PER_VERSION_PER_DAY,
    approvedVersions: approved,
    withinHorizon: !!scope.version && approved.includes(scope.version),
  };
}
