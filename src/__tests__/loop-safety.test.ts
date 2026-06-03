/**
 * #1587 — Visible loop safety caps: pure-logic regression tests.
 *
 * These lock the count helpers to the SAME basis the enforcement sites use:
 *   - open = in-progress tasks per (project, section, version)  [dispatch-gate]
 *   - daily = spike tasks created same-UTC-day per (project, version) [store route]
 */
import { describe, it, expect } from 'vitest';
import {
  countOpenExperiments,
  countCreatedToday,
  summarizeLoopSafety,
  MAX_OPEN_EXPERIMENTS,
  MAX_AUTO_TASKS_PER_VERSION_PER_DAY,
  type CapTaskLike,
} from '@/lib/loop-safety';

const SCOPE = { projectId: 'p1', sectionId: 's1', version: '2026.07.01' };
// A fixed "now" mid-UTC-day so we can place tasks before/after start-of-day.
const NOW = Date.UTC(2026, 6, 1, 14, 0, 0); // 2026-07-01T14:00Z
const START_OF_DAY = Date.UTC(2026, 6, 1);

const t = (p: Partial<CapTaskLike>): CapTaskLike => ({
  projectId: 'p1', sectionId: 's1', version: '2026.07.01', status: 'backlog', taskType: 'spike', ...p,
});

describe('#1587 countOpenExperiments (mirrors dispatch-gate)', () => {
  it('counts only in-progress in this project/section/version', () => {
    const tasks = [
      t({ status: 'in-progress' }),
      t({ status: 'in-progress' }),
      t({ status: 'done' }),                      // not open
      t({ status: 'in-progress', version: '2026.08.01' }), // other version
      t({ status: 'in-progress', sectionId: 's2' }),       // other section
      t({ status: 'in-progress', projectId: 'p2' }),       // other project
    ];
    expect(countOpenExperiments(tasks, SCOPE)).toBe(2);
  });
  it('empty → 0', () => expect(countOpenExperiments([], SCOPE)).toBe(0));
});

describe('#1587 countCreatedToday (mirrors store route — project+version, spike, UTC day)', () => {
  it('counts spike tasks created today for this project+version', () => {
    const tasks = [
      t({ createdAt: NOW }),
      t({ createdAt: START_OF_DAY }),             // exactly start-of-day counts
      t({ createdAt: START_OF_DAY - 1 }),         // yesterday → excluded
      t({ createdAt: NOW, taskType: 'feature' }), // non-spike → excluded
      t({ createdAt: NOW, version: '2026.08.01' }), // other version → excluded
      t({ createdAt: NOW, projectId: 'p2' }),     // other project → excluded
      t({ createdAt: NOW, sectionId: 's2' }),     // section NOT scoped here → still counts
    ];
    expect(countCreatedToday(tasks, SCOPE, NOW)).toBe(3);
  });
  it('missing createdAt → treated as epoch (excluded)', () => {
    expect(countCreatedToday([t({ createdAt: undefined })], SCOPE, NOW)).toBe(0);
  });
});

describe('#1587 summarizeLoopSafety', () => {
  it('rolls up caps, at-cap flags, and horizon membership', () => {
    const tasks = [
      ...Array.from({ length: MAX_OPEN_EXPERIMENTS }, () => t({ status: 'in-progress' })),
      ...Array.from({ length: MAX_AUTO_TASKS_PER_VERSION_PER_DAY }, () => t({ createdAt: NOW })),
    ];
    const s = summarizeLoopSafety({
      tasks, scope: SCOPE, loopPaused: true,
      approvedVersions: ['2026.07.01'], now: NOW,
    });
    expect(s.loopPaused).toBe(true);
    expect(s.openExperiments).toBe(MAX_OPEN_EXPERIMENTS);
    expect(s.openAtCap).toBe(true);
    expect(s.createdToday).toBe(MAX_AUTO_TASKS_PER_VERSION_PER_DAY);
    expect(s.dailyAtCap).toBe(true);
    expect(s.withinHorizon).toBe(true);
  });
  it('under caps, outside horizon', () => {
    const s = summarizeLoopSafety({
      tasks: [t({ status: 'in-progress' })], scope: SCOPE,
      loopPaused: false, approvedVersions: ['2026.06.01'], now: NOW,
    });
    expect(s.openAtCap).toBe(false);
    expect(s.dailyAtCap).toBe(false);
    expect(s.withinHorizon).toBe(false);
    expect(s.approvedVersions).toEqual(['2026.06.01']);
  });
  it('no approvedVersions → empty horizon, not within', () => {
    const s = summarizeLoopSafety({ tasks: [], scope: SCOPE, now: NOW });
    expect(s.approvedVersions).toEqual([]);
    expect(s.withinHorizon).toBe(false);
  });
});
