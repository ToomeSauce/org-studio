/**
 * Tests for #1186 — `approvedVersions` (explicit list) replacing
 * `approvedThrough` (contiguous-prefix string).
 *
 * Verifies the transitional helpers in component-helpers.ts:
 *   - getComponentApprovedThrough() → max() of approvedVersions when present
 *   - getComponentApprovedVersions() → returns the list (or [] if legacy-only)
 *   - isVersionApproved() → list-includes when present, prefix-fallback otherwise
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

describe('#1186: approvedVersions list (transitional)', () => {
  describe('getComponentApprovedThrough', () => {
    it('returns max() of approvedVersions when list is set', () => {
      const proj = baseProject({
        approvedVersions: ['1.0.0', '1.1.0', '1.2.0'],
        approvedThrough: '0.5.0', // legacy stale; list takes precedence
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

    it('falls back to legacy approvedThrough when list is empty/missing', () => {
      const proj = baseProject({ approvedThrough: '0.7.0' });
      expect(getComponentApprovedThrough(proj as any, 'cmp1')).toBe('0.7.0');
    });

    it('falls back to legacy approvedThrough when list is empty array', () => {
      const proj = baseProject({
        approvedVersions: [],
        approvedThrough: '0.7.0',
      });
      expect(getComponentApprovedThrough(proj as any, 'cmp1')).toBe('0.7.0');
    });

    it('returns undefined when neither field is set', () => {
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

    it('returns empty array when only legacy approvedThrough is set', () => {
      const proj = baseProject({ approvedThrough: '0.5.0' });
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
    it('uses list inclusion when approvedVersions is set', () => {
      const proj = baseProject({
        approvedVersions: ['1.0.0', '1.2.0'], // note: 1.1.0 is NOT approved
      });
      expect(isVersionApproved(proj as any, 'cmp1', '1.0.0')).toBe(true);
      expect(isVersionApproved(proj as any, 'cmp1', '1.1.0')).toBe(false); // gap allowed
      expect(isVersionApproved(proj as any, 'cmp1', '1.2.0')).toBe(true);
      expect(isVersionApproved(proj as any, 'cmp1', '1.3.0')).toBe(false);
    });

    it('falls back to prefix semantics when only legacy approvedThrough is set', () => {
      const proj = baseProject({ approvedThrough: '1.2.0' });
      expect(isVersionApproved(proj as any, 'cmp1', '1.0.0')).toBe(true);
      expect(isVersionApproved(proj as any, 'cmp1', '1.1.0')).toBe(true);
      expect(isVersionApproved(proj as any, 'cmp1', '1.2.0')).toBe(true);
      expect(isVersionApproved(proj as any, 'cmp1', '1.3.0')).toBe(false);
    });

    it('returns false when neither field is set', () => {
      const proj = baseProject({});
      expect(isVersionApproved(proj as any, 'cmp1', '1.0.0')).toBe(false);
    });

    it('returns false for unknown component', () => {
      const proj = baseProject({ approvedVersions: ['1.0.0'] });
      expect(isVersionApproved(proj as any, 'bad-id', '1.0.0')).toBe(false);
    });
  });
});
