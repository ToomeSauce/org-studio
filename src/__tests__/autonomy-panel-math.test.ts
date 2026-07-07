/**
 * Tests for autonomy-panel-math.ts (#1655 Phase A-4).
 */
import { describe, it, expect } from 'vitest';
import {
  computeBurnBar,
  estimateMonthEndPace,
  monthToDateWindowDays,
} from '@/lib/autonomy-panel-math';

describe('#1655: computeBurnBar', () => {
  it('returns null without a ceiling', () => {
    expect(computeBurnBar(50, null)).toBeNull();
    expect(computeBurnBar(50, undefined)).toBeNull();
    expect(computeBurnBar(50, 0)).toBeNull();
    expect(computeBurnBar(50, -10)).toBeNull();
    expect(computeBurnBar(50, NaN)).toBeNull();
  });

  it('computes fill percent and clamps at 100', () => {
    expect(computeBurnBar(50, 200)!.fillPct).toBe(25);
    expect(computeBurnBar(300, 200)!.fillPct).toBe(100);
    expect(computeBurnBar(0, 200)!.fillPct).toBe(0);
  });

  it('treats unknown/invalid spend as zero', () => {
    expect(computeBurnBar(null, 200)!.fillPct).toBe(0);
    expect(computeBurnBar(undefined, 200)!.fillPct).toBe(0);
    expect(computeBurnBar(-5, 200)!.fillPct).toBe(0);
    expect(computeBurnBar(NaN, 200)!.fillPct).toBe(0);
  });

  it('mirrors budgetAlertState semantics: ok / warn / exceeded', () => {
    expect(computeBurnBar(100, 200)!.state).toBe('ok');       // 50% < 80%
    expect(computeBurnBar(160, 200)!.state).toBe('warn');     // exactly 80%
    expect(computeBurnBar(199, 200)!.state).toBe('warn');
    expect(computeBurnBar(200, 200)!.state).toBe('exceeded'); // at ceiling
    expect(computeBurnBar(250, 200)!.state).toBe('exceeded');
  });

  it('honors custom alertPct and defaults invalid values to 80', () => {
    expect(computeBurnBar(100, 200, 50)!.state).toBe('warn');   // 50% >= 50
    expect(computeBurnBar(100, 200, 50)!.alertPct).toBe(50);
    expect(computeBurnBar(100, 200, 0)!.alertPct).toBe(80);     // invalid → 80
    expect(computeBurnBar(100, 200, 150)!.alertPct).toBe(80);
    expect(computeBurnBar(100, 200, 79.5)!.alertPct).toBe(80);  // non-integer
    expect(computeBurnBar(100, 200, null)!.alertPct).toBe(80);
  });
});

describe('#1655: estimateMonthEndPace', () => {
  it('extrapolates linearly to month end', () => {
    // Jun 15 of a 30-day month, $50 spent → $100/mo pace
    const mid = new Date(2026, 5, 15); // June 2026 (30 days)
    expect(estimateMonthEndPace(50, mid)).toBe(100);
  });

  it('handles 31-day months', () => {
    const d = new Date(2026, 6, 10); // July 2026 (31 days)
    expect(estimateMonthEndPace(10, d)).toBeCloseTo(31, 5);
  });

  it('returns null for unknown/invalid spend', () => {
    expect(estimateMonthEndPace(null)).toBeNull();
    expect(estimateMonthEndPace(undefined)).toBeNull();
    expect(estimateMonthEndPace(NaN)).toBeNull();
    expect(estimateMonthEndPace(-1)).toBeNull();
  });

  it('zero spend paces to zero (not null)', () => {
    expect(estimateMonthEndPace(0, new Date(2026, 6, 10))).toBe(0);
  });
});

describe('#1655: monthToDateWindowDays', () => {
  it('is the day of month, min 1', () => {
    expect(monthToDateWindowDays(new Date(2026, 6, 7))).toBe(7);
    expect(monthToDateWindowDays(new Date(2026, 6, 1))).toBe(1);
    expect(monthToDateWindowDays(new Date(2026, 6, 31))).toBe(31);
  });
});
