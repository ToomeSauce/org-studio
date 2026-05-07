/**
 * resolve-section-id (#1269).
 *
 * Pure unit tests for the sectionId auto-resolution helper used by
 * /api/store addTask and updateTask. Covers all four branches of the
 * helper plus the integration shape (resolved=false on passthrough,
 * resolved=true on auto-fill).
 */

import { describe, it, expect } from 'vitest';
import { resolveSectionId } from '../lib/resolve-section-id';

const singleSectionProject = {
  id: 'proj-voice',
  sections: [{ id: 'sec-main-proj-voice', name: 'Main' }],
};

const multiSectionProject = {
  id: 'proj-multi',
  sections: [
    { id: 'sec-main-proj-multi', name: 'Main' },
    { id: 'sec-frontend-proj-multi', name: 'Frontend' },
    { id: 'sec-backend-proj-multi', name: 'Backend' },
  ],
};

const multiNoMainProject = {
  id: 'proj-weird',
  sections: [
    { id: 'sec-frontend-proj-weird', name: 'Frontend' },
    { id: 'sec-backend-proj-weird', name: 'Backend' },
  ],
};

const componentsProject = {
  id: 'proj-comp',
  sections: [],
  components: [{ id: 'cmp-main', name: 'Main' }],
};

const emptyProject = { id: 'proj-empty', sections: [], components: [] };

describe('resolveSectionId (#1269)', () => {
  describe('passthrough — caller already supplied sectionId', () => {
    it('returns it unchanged with resolved=false', () => {
      const r = resolveSectionId(singleSectionProject, 'proj-voice', 'some-explicit-id');
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.sectionId).toBe('some-explicit-id');
        expect(r.resolved).toBe(false);
      }
    });

    it('does NOT validate that the supplied sectionId actually exists on the project', () => {
      // By design — caller may be doing cross-project moves; existence
      // checks live downstream. Helper only fills blanks.
      const r = resolveSectionId(singleSectionProject, 'proj-voice', 'sec-bogus');
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.sectionId).toBe('sec-bogus');
        expect(r.resolved).toBe(false);
      }
    });

    it('treats whitespace-only sectionId as missing', () => {
      const r = resolveSectionId(singleSectionProject, 'proj-voice', '   ');
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.sectionId).toBe('sec-main-proj-voice');
        expect(r.resolved).toBe(true);
      }
    });
  });

  describe('single-section project — auto-fill', () => {
    it('resolves to the only section when sectionId is missing', () => {
      const r = resolveSectionId(singleSectionProject, 'proj-voice', undefined);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.sectionId).toBe('sec-main-proj-voice');
        expect(r.resolved).toBe(true);
      }
    });

    it('handles null sectionId same as undefined', () => {
      const r = resolveSectionId(singleSectionProject, 'proj-voice', null);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.sectionId).toBe('sec-main-proj-voice');
    });

    it('falls back to components[] when sections[] is empty', () => {
      const r = resolveSectionId(componentsProject, 'proj-comp', undefined);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.sectionId).toBe('cmp-main');
        expect(r.resolved).toBe(true);
      }
    });
  });

  describe('multi-section project — convention-based default', () => {
    it('resolves to sec-main-<projectId> when present', () => {
      const r = resolveSectionId(multiSectionProject, 'proj-multi', undefined);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.sectionId).toBe('sec-main-proj-multi');
        expect(r.resolved).toBe(true);
      }
    });

    it('returns 400 with validSectionIds when no sec-main-* exists', () => {
      const r = resolveSectionId(multiNoMainProject, 'proj-weird', undefined);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(400);
        expect(r.validSectionIds).toEqual([
          'sec-frontend-proj-weird',
          'sec-backend-proj-weird',
        ]);
        expect(r.error).toContain('proj-weird');
        expect(r.error).toContain('multiple sections');
      }
    });
  });

  describe('error cases', () => {
    it('returns 400 when project is null/undefined', () => {
      const r = resolveSectionId(null, 'proj-missing', undefined);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(400);
        expect(r.error).toContain('proj-missing');
      }
    });

    it('returns 400 when project has no sections AND no components', () => {
      const r = resolveSectionId(emptyProject, 'proj-empty', undefined);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(400);
        expect(r.error).toContain('no sections or components');
        expect(r.validSectionIds).toEqual([]);
      }
    });

    it('passthrough still works even on a project with no sections', () => {
      // Caller supplied an explicit id — helper trusts the caller.
      const r = resolveSectionId(emptyProject, 'proj-empty', 'sec-something');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.resolved).toBe(false);
    });
  });
});
