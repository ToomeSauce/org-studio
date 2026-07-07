import { describe, it, expect } from 'vitest';
import {
  DEFAULT_BOUNDARIES,
  validateBoundaries,
  validateBudget,
} from '@/lib/autonomy-budget';

describe('autonomy budget/boundaries helpers (#1652)', () => {
  describe('validateBudget', () => {
    it('accepts a valid budget and applies default alertPct=80 when omitted', () => {
      const res = validateBudget({ ceilingUsdMonth: 1200, ceilingUsdVersion: 5000 });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toEqual({
          ceilingUsdMonth: 1200,
          ceilingUsdVersion: 5000,
          alertPct: 80,
        });
      }
    });

    it('rejects negative/zero/NaN ceilings', () => {
      const bad = [
        { ceilingUsdMonth: -1 },
        { ceilingUsdMonth: 0 },
        { ceilingUsdMonth: Number.NaN },
        { ceilingUsdVersion: -10 },
        { ceilingUsdVersion: 0 },
        { ceilingUsdVersion: Number.NaN },
      ];

      for (const input of bad) {
        const res = validateBudget(input);
        expect(res.ok).toBe(false);
      }
    });

    it('rejects alertPct 0/100/1.5, accepts integer 1..99', () => {
      for (const bad of [0, 100, 1.5]) {
        const res = validateBudget({ alertPct: bad });
        expect(res.ok).toBe(false);
      }

      for (const good of [1, 50, 99]) {
        const res = validateBudget({ alertPct: good });
        expect(res.ok).toBe(true);
        if (res.ok) expect(res.value.alertPct).toBe(good);
      }
    });

    it('rejects unknown budget keys with a clear error', () => {
      const res = validateBudget({ ceilingUsdMonth: 100, mysteryKey: true } as any);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toMatch(/unknown key/);
        expect(res.error).toMatch(/mysteryKey/);
      }
    });
  });

  describe('validateBoundaries', () => {
    it('rejects boundaries with an empty-string entry', () => {
      const res = validateBoundaries({
        freeToDecide: ['Ship copy tweaks'],
        mustAsk: ['   '],
      });
      expect(res.ok).toBe(false);
    });
  });

  it('DEFAULT_BOUNDARIES has the expected shape', () => {
    expect(Array.isArray(DEFAULT_BOUNDARIES.freeToDecide)).toBe(true);
    expect(Array.isArray(DEFAULT_BOUNDARIES.mustAsk)).toBe(true);
    expect(DEFAULT_BOUNDARIES.freeToDecide.length).toBeGreaterThan(0);
    expect(DEFAULT_BOUNDARIES.mustAsk.length).toBeGreaterThan(0);
    for (const entry of [...DEFAULT_BOUNDARIES.freeToDecide, ...DEFAULT_BOUNDARIES.mustAsk]) {
      expect(typeof entry).toBe('string');
      expect(entry.trim().length).toBeGreaterThan(0);
    }
  });
});
