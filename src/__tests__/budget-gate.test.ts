/**
 * #1653 Phase A-2 — budget gate unit tests.
 *
 * Covers the pure predicates in src/lib/budget-gate.ts plus rule-6 wiring
 * in dispatch-gate.ts (optional spendSnapshot param; omitted = pre-#1653
 * behavior).
 */
import { describe, expect, it } from 'vitest';
import {
  budgetAlertState,
  currentMonthKey,
  isProjectBudgetExceeded,
  shouldSendBudgetAlert,
  type BudgetAlertsMarker,
} from '@/lib/budget-gate';
import { isTaskAdhocDispatchEligible } from '@/lib/dispatch-gate';

const project = (over: any = {}) => ({ id: 'p1', ...over });
const budgeted = (ceiling: number, alertPct?: number, over: any = {}) =>
  project({ budget: { ceilingUsdMonth: ceiling, ...(alertPct != null ? { alertPct } : {}) }, ...over });

describe('isProjectBudgetExceeded (#1653 rule 6 core)', () => {
  it('blocks when metered spend >= ceiling', () => {
    expect(isProjectBudgetExceeded(budgeted(100), { p1: 100 })).toBe(true);
    expect(isProjectBudgetExceeded(budgeted(100), { p1: 150.5 })).toBe(true);
  });

  it('passes under ceiling', () => {
    expect(isProjectBudgetExceeded(budgeted(100), { p1: 99.99 })).toBe(false);
  });

  it('no budget configured → never blocks', () => {
    expect(isProjectBudgetExceeded(project(), { p1: 9999 })).toBe(false);
    expect(isProjectBudgetExceeded(project({ budget: {} }), { p1: 9999 })).toBe(false);
  });

  it('null/undefined snapshot → never blocks (fail-open)', () => {
    expect(isProjectBudgetExceeded(budgeted(100), null)).toBe(false);
    expect(isProjectBudgetExceeded(budgeted(100), undefined)).toBe(false);
  });

  it('project missing from snapshot → never blocks', () => {
    expect(isProjectBudgetExceeded(budgeted(100), { other: 500 })).toBe(false);
  });

  it('garbage inputs → never blocks', () => {
    expect(isProjectBudgetExceeded(budgeted(-5), { p1: 100 })).toBe(false);
    expect(isProjectBudgetExceeded(budgeted(NaN as any), { p1: 100 })).toBe(false);
    expect(isProjectBudgetExceeded(budgeted(100), { p1: NaN as any })).toBe(false);
    expect(isProjectBudgetExceeded(null, { p1: 100 })).toBe(false);
  });
});

describe('budgetAlertState', () => {
  it('default alertPct 80 warn boundary', () => {
    expect(budgetAlertState(budgeted(100), { p1: 79.99 })).toBe('none');
    expect(budgetAlertState(budgeted(100), { p1: 80 })).toBe('warn');
    expect(budgetAlertState(budgeted(100), { p1: 99.99 })).toBe('warn');
    expect(budgetAlertState(budgeted(100), { p1: 100 })).toBe('exceeded');
  });

  it('custom alertPct honored', () => {
    expect(budgetAlertState(budgeted(100, 50), { p1: 49 })).toBe('none');
    expect(budgetAlertState(budgeted(100, 50), { p1: 50 })).toBe('warn');
  });

  it('invalid alertPct falls back to 80', () => {
    expect(budgetAlertState(budgeted(100, 0 as any), { p1: 79 })).toBe('none');
    expect(budgetAlertState(budgeted(100, 0 as any), { p1: 80 })).toBe('warn');
  });

  it('absent data → none', () => {
    expect(budgetAlertState(project(), { p1: 999 })).toBe('none');
    expect(budgetAlertState(budgeted(100), null)).toBe('none');
    expect(budgetAlertState(budgeted(100), {})).toBe('none');
  });
});

describe('shouldSendBudgetAlert (alert-once dedup)', () => {
  const M = '2026-07';

  it('sends warn once, then dedups', () => {
    expect(shouldSendBudgetAlert(undefined, 'warn', M)).toBe(true);
    expect(shouldSendBudgetAlert({}, 'warn', M)).toBe(true);
    const after: BudgetAlertsMarker = { [M]: { warnedAt: 1 } };
    expect(shouldSendBudgetAlert(after, 'warn', M)).toBe(false);
  });

  it('warn → exceeded escalation still notifies; exceeded dedups', () => {
    const warned: BudgetAlertsMarker = { [M]: { warnedAt: 1 } };
    expect(shouldSendBudgetAlert(warned, 'exceeded', M)).toBe(true);
    const both: BudgetAlertsMarker = { [M]: { warnedAt: 1, exceededAt: 2 } };
    expect(shouldSendBudgetAlert(both, 'exceeded', M)).toBe(false);
  });

  it('exceeded suppresses later warn in same month', () => {
    const exceeded: BudgetAlertsMarker = { [M]: { exceededAt: 2 } };
    expect(shouldSendBudgetAlert(exceeded, 'warn', M)).toBe(false);
  });

  it('fresh month resets', () => {
    const july: BudgetAlertsMarker = { '2026-07': { warnedAt: 1, exceededAt: 2 } };
    expect(shouldSendBudgetAlert(july, 'warn', '2026-08')).toBe(true);
  });

  it("state 'none' never sends", () => {
    expect(shouldSendBudgetAlert(undefined, 'none', M)).toBe(false);
  });
});

describe('currentMonthKey', () => {
  it('formats YYYY-MM (UTC)', () => {
    expect(currentMonthKey(new Date(Date.UTC(2026, 6, 7)))).toBe('2026-07');
    expect(currentMonthKey(new Date(Date.UTC(2026, 11, 31)))).toBe('2026-12');
  });
});

describe('dispatch-gate rule 6 wiring (adhoc lane)', () => {
  // Adhoc lane has the fewest prerequisites — ideal for isolating rule 6.
  const store: any = {
    projects: [{ id: 'p1', state: 'active', budget: { ceilingUsdMonth: 100 } }],
    tasks: [],
  };
  const task: any = {
    id: 't1',
    projectId: 'p1',
    assignee: 'mikey',
    status: 'backlog',
    taskType: 'chore',
  };

  it('omitted snapshot → pre-#1653 behavior (eligible)', () => {
    expect(isTaskAdhocDispatchEligible(store, task)).toBe(true);
    expect(isTaskAdhocDispatchEligible(store, task, undefined)).toBe(true);
    expect(isTaskAdhocDispatchEligible(store, task, null)).toBe(true);
  });

  it('under-ceiling snapshot → eligible', () => {
    expect(isTaskAdhocDispatchEligible(store, task, { p1: 50 })).toBe(true);
  });

  it('exceeded snapshot → not eligible', () => {
    expect(isTaskAdhocDispatchEligible(store, task, { p1: 100 })).toBe(false);
  });

  it('project without budget ignores snapshot', () => {
    const s: any = { projects: [{ id: 'p1', state: 'active' }], tasks: [] };
    expect(isTaskAdhocDispatchEligible(s, task, { p1: 99999 })).toBe(true);
  });
});
