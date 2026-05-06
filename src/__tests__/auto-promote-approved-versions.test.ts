/**
 * isVersionApproved + auto-promote horizon-gate invariants (#1222).
 *
 * Locks in the set-membership semantics for `approvedVersions[]`.
 *
 * Why this test exists:
 *   The 2026-05-04 Thrivor incident surfaced a class of bugs where
 *   non-contiguous approvals (tick 0.18, skip 0.19, tick 0.20) could
 *   accidentally let 0.19 promote through under `<=max` semantics.
 *   `approvedVersions[]` set membership is the ONLY correct gate.
 *
 *   `promoteProjectToNextVersion` (project-state.ts) and
 *   `checkAndAutoAdvance` (roadmap-sync.ts) both currently inline the
 *   set-membership check. This test guards the canonical helper
 *   `isVersionApproved` they delegate to so a future refactor can't
 *   silently regress to `<=` comparison.
 *
 * Scope: unit-level, no DB. The auto-promote/auto-advance happy paths
 * are exercised by integration tests under start-button-gate.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { isVersionApproved } from '../lib/component-helpers';

const COMP_ID = 'sec-main-test';

function makeProject(approvedVersions: string[] | undefined) {
  // Both shapes (`components` + legacy `sections`) are accepted.
  return {
    id: 'proj-test',
    components: [
      {
        id: COMP_ID,
        name: 'Main',
        role: null,
        ...(approvedVersions !== undefined ? { approvedVersions } : {}),
      },
    ],
  } as any;
}

describe('isVersionApproved — set-membership semantics (#1222)', () => {
  describe('basic membership', () => {
    it('returns true when version is in approvedVersions[]', () => {
      const proj = makeProject(['0.10', '0.11', '0.12']);
      expect(isVersionApproved(proj, COMP_ID, '0.11')).toBe(true);
    });

    it('returns false when version is NOT in approvedVersions[]', () => {
      const proj = makeProject(['0.10', '0.11']);
      expect(isVersionApproved(proj, COMP_ID, '0.12')).toBe(false);
    });

    it('returns false when approvedVersions[] is empty', () => {
      const proj = makeProject([]);
      expect(isVersionApproved(proj, COMP_ID, '0.10')).toBe(false);
    });

    it('returns false when approvedVersions[] is missing', () => {
      const proj = makeProject(undefined);
      expect(isVersionApproved(proj, COMP_ID, '0.10')).toBe(false);
    });
  });

  describe('non-contiguous approvals (the #1222 invariant)', () => {
    it('rejects a version that sits BETWEEN two approved versions', () => {
      // Tick 0.18 + 0.20, skip 0.19. Under a (broken) `<=max` rule,
      // 0.19 would slip through. Under set membership it must not.
      const proj = makeProject(['0.18', '0.20']);
      expect(isVersionApproved(proj, COMP_ID, '0.18')).toBe(true);
      expect(isVersionApproved(proj, COMP_ID, '0.20')).toBe(true);
      expect(isVersionApproved(proj, COMP_ID, '0.19')).toBe(false);
    });

    it('rejects a higher version even when lower ones are approved', () => {
      const proj = makeProject(['0.10', '0.11']);
      expect(isVersionApproved(proj, COMP_ID, '0.99')).toBe(false);
    });

    it('treats approval as a string match, not a numeric range', () => {
      // CalVer-style versions sit alongside semver in real data
      // (proj-mc / proj-org-studio uses dates). String equality is the
      // contract — no surprise lexicographic ranges.
      const proj = makeProject(['2026.04.18', '2026.04.20']);
      expect(isVersionApproved(proj, COMP_ID, '2026.04.18')).toBe(true);
      expect(isVersionApproved(proj, COMP_ID, '2026.04.19')).toBe(false);
      expect(isVersionApproved(proj, COMP_ID, '2026.04.20')).toBe(true);
    });
  });

  describe('component resolution', () => {
    it('returns false when component does not exist on the project', () => {
      const proj = makeProject(['0.10']);
      expect(isVersionApproved(proj, 'nonexistent-component', '0.10')).toBe(false);
    });

    it('falls back to legacy `sections` shape when `components` is empty', () => {
      const proj: any = {
        id: 'proj-test',
        components: [],
        sections: [
          { id: COMP_ID, name: 'Main', role: null, approvedVersions: ['0.10'] },
        ],
      };
      expect(isVersionApproved(proj, COMP_ID, '0.10')).toBe(true);
      expect(isVersionApproved(proj, COMP_ID, '0.11')).toBe(false);
    });
  });

  describe('legacy approvedThrough is NOT consulted (#1224)', () => {
    // Lock in the post-#1224 contract: even if a project still carries
    // an old `approvedThrough` value, set membership against
    // `approvedVersions[]` is the ONLY signal. No silent fallback.
    it('does not treat approvedThrough as approval', () => {
      const proj: any = {
        id: 'proj-test',
        components: [
          {
            id: COMP_ID,
            name: 'Main',
            approvedThrough: '0.99',         // legacy field, must be ignored
            approvedVersions: [],            // empty list = no approvals
          },
        ],
      };
      expect(isVersionApproved(proj, COMP_ID, '0.50')).toBe(false);
      expect(isVersionApproved(proj, COMP_ID, '0.99')).toBe(false);
    });

    it('does not treat approvedThrough as approval when approvedVersions is missing', () => {
      const proj: any = {
        id: 'proj-test',
        components: [
          {
            id: COMP_ID,
            name: 'Main',
            approvedThrough: '0.99',
          },
        ],
      };
      expect(isVersionApproved(proj, COMP_ID, '0.99')).toBe(false);
    });
  });
});

/**
 * Mirror tests for the inline horizon-gate predicate used by
 * promoteProjectToNextVersion and checkAndAutoAdvance. These are
 * intentionally identical in shape to the helper-level tests above —
 * if either ever drifts from the helper, the diff makes that obvious.
 */
describe('auto-promote horizon-gate predicate (#1222 inline check)', () => {
  // Mirror of the inline check in src/lib/project-state.ts and
  // src/lib/roadmap-sync.ts.
  function isPromoteAllowed(
    approvedVersions: string[] | undefined,
    target: string | null | undefined,
  ): boolean {
    if (!target) return false;
    if (!Array.isArray(approvedVersions) || approvedVersions.length === 0) return false;
    return approvedVersions.includes(target);
  }

  it('allows promotion to an approved version', () => {
    expect(isPromoteAllowed(['0.18', '0.20'], '0.20')).toBe(true);
  });

  it('blocks promotion to an unapproved version between two approved ones', () => {
    expect(isPromoteAllowed(['0.18', '0.20'], '0.19')).toBe(false);
  });

  it('blocks promotion when approvedVersions[] is empty', () => {
    expect(isPromoteAllowed([], '0.20')).toBe(false);
  });

  it('blocks promotion when approvedVersions[] is missing', () => {
    expect(isPromoteAllowed(undefined, '0.20')).toBe(false);
  });

  it('blocks promotion when target is missing', () => {
    expect(isPromoteAllowed(['0.20'], null)).toBe(false);
    expect(isPromoteAllowed(['0.20'], undefined)).toBe(false);
  });
});
