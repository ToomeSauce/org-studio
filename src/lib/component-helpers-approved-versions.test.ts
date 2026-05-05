/**
 * Tests for #1224 — `approvedVersions[]` (explicit list) is the only
 * source of truth for per-component approval. The legacy `approvedThrough`
 * scalar (and its contiguous-prefix semantics) was removed in this ticket.
 *
 * Verifies the helpers in component-helpers.ts:
 *   - getComponentApprovedThrough() → max() of approvedVersions, or undefined
 *   - getComponentApprovedVersions() → returns the list (or [] when unset)
 *   - isVersionApproved() → set membership against approvedVersions[]
 */

import { describe, it, expect } from 'vitest';
import {
  getComponentApprovedThrough,
  getComponentApprovedVersions,
  isVersionApproved,
} from './component-helpers';

const baseProject = (componentOverrides: any = {}) => ({
  id: 'p1',
  name: 'P1',
  components: [
    {
      id: 'cmp1',
      name: 'Main',
      owner: 'mikey',
      ...componentOverrides,
    },
  ],
});

describe('#1224: approvedVersions list (sole source of truth)', () => {
  describe('getComponentApprovedThrough', () => {
    it('returns max() of approvedVersions when list is set', () => {
      const proj = baseProject({
        approvedVersions: ['1.0.0', '1.1.0', '1.2.0'],
      });
      expect(getComponentApprovedThrough(proj as any, 'cmp1')).toBe('1.2.0');
    });

    it('returns max() correctly with non-contiguous list', () => {
      const proj = baseProject({
        approvedVersions: ['1.0.0', '1.5.0', '1.2.0'],
      });
      // max should be 1.5.0 regardless of array order
      expect(getComponentApprovedThrough(proj as any, 'cmp1')).toBe('1.5.0');
    });

    it('returns undefined when approvedVersions is empty', () => {
      const proj = baseProject({ approvedVersions: [] });
      expect(getComponentApprovedThrough(proj as any, 'cmp1')).toBeUndefined();
    });

    it('returns undefined when approvedVersions is missing', () => {
      const proj = baseProject({});
      expect(getComponentApprovedThrough(proj as any, 'cmp1')).toBeUndefined();
    });

    it('handles numeric segment ordering correctly (10 > 9)', () => {
      const proj = baseProject({
        approvedVersions: ['0.9.0', '0.10.0', '0.2.0'],
      });
      expect(getComponentApprovedThrough(proj as any, 'cmp1')).toBe('0.10.0');
    });
  });

  describe('getComponentApprovedVersions', () => {
    it('returns a copy of the list when set', () => {
      const proj = baseProject({
        approvedVersions: ['1.0.0', '1.1.0'],
      });
      const result = getComponentApprovedVersions(proj as any, 'cmp1');
      expect(result).toEqual(['1.0.0', '1.1.0']);
      // Mutating the result should not affect the project
      result.push('1.2.0');
      expect(getComponentApprovedVersions(proj as any, 'cmp1')).toEqual([
        '1.0.0',
        '1.1.0',
      ]);
    });

    it('returns empty array when approvedVersions is unset', () => {
      const proj = baseProject({});
      expect(getComponentApprovedVersions(proj as any, 'cmp1')).toEqual([]);
    });

    it('returns empty array when component is not found', () => {
      const proj = baseProject({});
      expect(getComponentApprovedVersions(proj as any, 'nonexistent')).toEqual(
        [],
      );
    });
  });

  describe('isVersionApproved', () => {
    it('uses set membership against approvedVersions', () => {
      const proj = baseProject({
        approvedVersions: ['1.0.0', '1.2.0'], // note: 1.1.0 is NOT approved
      });
      expect(isVersionApproved(proj as any, 'cmp1', '1.0.0')).toBe(true);
      expect(isVersionApproved(proj as any, 'cmp1', '1.1.0')).toBe(false); // gap allowed
      expect(isVersionApproved(proj as any, 'cmp1', '1.2.0')).toBe(true);
      expect(isVersionApproved(proj as any, 'cmp1', '1.3.0')).toBe(false);
    });

    it('returns false when approvedVersions is unset', () => {
      const proj = baseProject({});
      expect(isVersionApproved(proj as any, 'cmp1', '1.0.0')).toBe(false);
    });

    it('returns false when approvedVersions is empty', () => {
      const proj = baseProject({ approvedVersions: [] });
      expect(isVersionApproved(proj as any, 'cmp1', '1.0.0')).toBe(false);
    });

    it('returns false for unknown component', () => {
      const proj = baseProject({ approvedVersions: ['1.0.0'] });
      expect(isVersionApproved(proj as any, 'bad-id', '1.0.0')).toBe(false);
    });
  });
});
