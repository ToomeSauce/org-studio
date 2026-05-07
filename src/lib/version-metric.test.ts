/**
 * #1263 — pure helper tests for outcome-bound version logic.
 *
 * Covers `isVersionMetricMet` and `isVersionLoopPaused` from
 * src/lib/version-metric.ts. No DB, no I/O — pure predicates.
 */
import { describe, it, expect } from 'vitest';
import {
  isVersionMetricMet,
  isVersionLoopPaused,
  isRvRowMetricMet,
  isRvRowLoopPaused,
  MAX_OPEN_EXPERIMENTS,
  MAX_AUTO_TASKS_PER_VERSION_PER_DAY,
} from './version-metric';

describe('isVersionMetricMet — outcome-bound gate semantics', () => {
  it('returns true when no successCriteria is set (no gate)', () => {
    expect(isVersionMetricMet({})).toBe(true);
    expect(isVersionMetricMet({ successCriteria: '' })).toBe(true);
    expect(isVersionMetricMet({ successCriteria: '   ' })).toBe(true);
  });

  it('returns false when criteria is set but metricTarget is undefined', () => {
    expect(
      isVersionMetricMet({ successCriteria: 'beta MAU', metricCurrent: 5 }),
    ).toBe(false);
  });

  it('returns false when criteria + target set but metricCurrent is undefined', () => {
    expect(
      isVersionMetricMet({ successCriteria: 'beta MAU', metricTarget: 10 }),
    ).toBe(false);
  });

  it('uses gte by default when comparator is omitted', () => {
    expect(
      isVersionMetricMet({ successCriteria: 'x', metricCurrent: 10, metricTarget: 10 }),
    ).toBe(true);
    expect(
      isVersionMetricMet({ successCriteria: 'x', metricCurrent: 9, metricTarget: 10 }),
    ).toBe(false);
    expect(
      isVersionMetricMet({ successCriteria: 'x', metricCurrent: 11, metricTarget: 10 }),
    ).toBe(true);
  });

  it('honors lte comparator', () => {
    expect(
      isVersionMetricMet({ successCriteria: 'x', metricCurrent: 5, metricTarget: 10, metricComparator: 'lte' }),
    ).toBe(true);
    expect(
      isVersionMetricMet({ successCriteria: 'x', metricCurrent: 11, metricTarget: 10, metricComparator: 'lte' }),
    ).toBe(false);
  });

  it('honors eq comparator', () => {
    expect(
      isVersionMetricMet({ successCriteria: 'x', metricCurrent: 10, metricTarget: 10, metricComparator: 'eq' }),
    ).toBe(true);
    expect(
      isVersionMetricMet({ successCriteria: 'x', metricCurrent: 9, metricTarget: 10, metricComparator: 'eq' }),
    ).toBe(false);
  });

  it('falls back to gte for unknown comparator strings', () => {
    expect(
      isVersionMetricMet({ successCriteria: 'x', metricCurrent: 10, metricTarget: 10, metricComparator: 'wat' as any }),
    ).toBe(true);
  });

  it('rejects null/non-finite numbers', () => {
    expect(
      isVersionMetricMet({ successCriteria: 'x', metricCurrent: NaN, metricTarget: 10 }),
    ).toBe(false);
    expect(
      isVersionMetricMet({ successCriteria: 'x', metricCurrent: 10, metricTarget: Infinity }),
    ).toBe(false);
  });
});

describe('isVersionLoopPaused', () => {
  it('returns false by default', () => {
    expect(isVersionLoopPaused({})).toBe(false);
    expect(isVersionLoopPaused(undefined)).toBe(false);
  });

  it('returns true only when loopPaused === true', () => {
    expect(isVersionLoopPaused({ loopPaused: true })).toBe(true);
    expect(isVersionLoopPaused({ loopPaused: false })).toBe(false);
    expect(isVersionLoopPaused({ loopPaused: null as any })).toBe(false);
  });
});

describe('isRvRowMetricMet — reads from meta jsonb', () => {
  it('reads from meta.* fields', () => {
    expect(
      isRvRowMetricMet({ meta: { successCriteria: 'x', metricCurrent: 10, metricTarget: 10 } }),
    ).toBe(true);
    expect(
      isRvRowMetricMet({ meta: { successCriteria: 'x', metricCurrent: 5, metricTarget: 10 } }),
    ).toBe(false);
  });

  it('returns true when meta is absent or empty', () => {
    expect(isRvRowMetricMet({})).toBe(true);
    expect(isRvRowMetricMet({ meta: null })).toBe(true);
    expect(isRvRowMetricMet({ meta: {} })).toBe(true);
  });
});

describe('isRvRowLoopPaused — reads from meta jsonb', () => {
  it('reads loopPaused from meta', () => {
    expect(isRvRowLoopPaused({ meta: { loopPaused: true } })).toBe(true);
    expect(isRvRowLoopPaused({ meta: { loopPaused: false } })).toBe(false);
    expect(isRvRowLoopPaused({})).toBe(false);
  });
});

describe('module constants', () => {
  it('exposes the spec-defined caps', () => {
    expect(MAX_OPEN_EXPERIMENTS).toBe(5);
    expect(MAX_AUTO_TASKS_PER_VERSION_PER_DAY).toBe(3);
  });
});
