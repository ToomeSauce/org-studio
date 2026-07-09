/**
 * #1689 — modelTier validation tests.
 *
 * The route-level integration (400 on bad values in addTask/updateTask) is
 * a thin application of this pure helper, so the helper carries the test
 * weight — same pattern as blocked-gate.test.ts (#1588).
 */
import { describe, it, expect } from 'vitest';
import { MODEL_TIERS, validateModelTier } from '@/lib/model-tier';

describe('MODEL_TIERS', () => {
  it('contains exactly the three tiers, in escalation order', () => {
    expect(MODEL_TIERS).toEqual(['trivial', 'standard', 'complex']);
  });
});

describe('validateModelTier', () => {
  it('accepts each valid tier and echoes it as value', () => {
    for (const tier of MODEL_TIERS) {
      const r = validateModelTier(tier);
      expect(r.ok).toBe(true);
      expect(r.value).toBe(tier);
    }
  });

  it('treats undefined as ok with no value (field absent = no-op)', () => {
    const r = validateModelTier(undefined);
    expect(r.ok).toBe(true);
    expect(r.value).toBeUndefined();
    expect('value' in r).toBe(false);
  });

  it('normalizes null and empty string to an explicit clear (value=null)', () => {
    for (const raw of [null, '']) {
      const r = validateModelTier(raw);
      expect(r.ok).toBe(true);
      expect(r.value).toBeNull();
    }
  });

  it('rejects unknown strings with a helpful error', () => {
    for (const raw of ['easy', 'TRIVIAL', 'Standard', 'complex ', 'medium']) {
      const r = validateModelTier(raw);
      expect(r.ok).toBe(false);
      expect(r.error).toContain('Invalid modelTier');
      expect(r.error).toContain('trivial, standard, complex');
    }
  });

  it('rejects non-string junk (numbers, objects, arrays, booleans)', () => {
    for (const raw of [1, 0, {}, [], ['trivial'], true, false, Symbol('x')]) {
      const r = validateModelTier(raw as unknown);
      expect(r.ok).toBe(false);
      expect(r.error).toBeTruthy();
    }
  });
});
