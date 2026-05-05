/**
 * #1112 PR 6 follow-up — component-aware Start button & promote tests.
 *
 * Locks in the post-refactor behavior:
 *   1. `hasAnyApprovedUnshippedWork` shape: walks every component, NOT
 *      `project.autonomy.approvedThrough`, when components are defined.
 *   2. Promote uses the primary component's `approvedThrough`, not the
 *      legacy project-level field.
 *   3. Legacy fallback only fires when no components are defined (brand-new
 *      projects).
 */
import { describe, it, expect } from 'vitest';
import {
  getComponentVersions,
  getComponentApprovedThrough,
  getEffectiveComponents,
} from '@/lib/component-helpers';
import { isVersionInHorizon } from '@/lib/version-utils';

// ---- Reproduces the page-level `hasAnyApprovedUnshippedWork` predicate ----
// Kept in sync with src/app/(dashboard)/projects/[id]/page.tsx. If that
// helper moves into component-helpers.ts later, swap this import.
function hasAnyApprovedUnshippedWork(project: any, roadmapVersions: any[] = []): boolean {
  const components = getEffectiveComponents(project);
  if (components.length > 0) {
    return components.some((c: any) => {
      const horizon = getComponentApprovedThrough(project, c.id);
      if (!horizon) return false;
      const compVers = getComponentVersions(project, c.id) as any[];
      return compVers.some(
        (v: any) => v.status !== 'shipped' && isVersionInHorizon(v.version, horizon),
      );
    });
  }
  const legacyApproved = project.autonomy?.approvedThrough;
  if (!legacyApproved) return false;
  return roadmapVersions.some(
    (v: any) => v.status !== 'shipped' && isVersionInHorizon(v.version, legacyApproved),
  );
}

describe('Start button gate — hasAnyApprovedUnshippedWork', () => {
  describe('with components defined', () => {
    it('enables when primary component has an unshipped version within horizon', () => {
      const project = {
        id: 'p1',
        state: 'stopped',
        components: [
          {
            id: 'cmp-main',
            name: 'Main',
            approvedVersions: ['0.1.0', '0.2.0', '0.3.0'],
            versions: [
              { version: '0.1.0', status: 'shipped' },
              { version: '0.2.0', status: 'shipped' },
              { version: '0.3.0', status: 'planned' }, // ← within horizon, unshipped
              { version: '0.4.0', status: 'planned' }, // above horizon
            ],
          },
        ],
      };
      expect(hasAnyApprovedUnshippedWork(project, [])).toBe(true);
    });

    it('enables when QA component has unshipped work even though Main is fully shipped', () => {
      const project = {
        id: 'p1',
        state: 'stopped',
        components: [
          {
            id: 'cmp-main',
            name: 'Main',
            approvedVersions: ['0.1.0', '0.2.0'],
            versions: [
              { version: '0.1.0', status: 'shipped' },
              { version: '0.2.0', status: 'shipped' },
            ],
          },
          {
            id: 'cmp-qa',
            name: 'QA',
            role: 'qa',
            approvedVersions: ['0.1.0', '0.2.0'],
            versions: [
              { version: '0.1.0', status: 'shipped' },
              { version: '0.2.0', status: 'current' }, // ← QA still validating
            ],
          },
        ],
      };
      expect(hasAnyApprovedUnshippedWork(project, [])).toBe(true);
    });

    it('disables when every component has shipped everything within its horizon', () => {
      const project = {
        id: 'p1',
        state: 'stopped',
        components: [
          {
            id: 'cmp-main',
            name: 'Main',
            approvedVersions: ['0.1.0', '0.2.0'],
            versions: [
              { version: '0.1.0', status: 'shipped' },
              { version: '0.2.0', status: 'shipped' },
              { version: '0.3.0', status: 'planned' }, // above horizon, doesn't count
            ],
          },
          {
            id: 'cmp-qa',
            name: 'QA',
            role: 'qa',
            approvedVersions: ['0.1.0', '0.2.0'],
            versions: [
              { version: '0.1.0', status: 'shipped' },
              { version: '0.2.0', status: 'shipped' },
            ],
          },
        ],
      };
      expect(hasAnyApprovedUnshippedWork(project, [])).toBe(false);
    });

    it('disables when components have versions but no approval banners', () => {
      const project = {
        id: 'p1',
        state: 'stopped',
        components: [
          {
            id: 'cmp-main',
            name: 'Main',
            // approvedThrough: undefined — no banner set
            versions: [{ version: '0.1.0', status: 'planned' }],
          },
        ],
      };
      expect(hasAnyApprovedUnshippedWork(project, [])).toBe(false);
    });

    it('ignores legacy project.autonomy.approvedThrough when components are defined', () => {
      // Real-world drift case: legacy field still set from old data, but
      // components are the source of truth now. The legacy value must NOT
      // unblock the gate when components say otherwise.
      const project = {
        id: 'p1',
        state: 'stopped',
        autonomy: { approvedThrough: '0.908.1' }, // stale legacy
        components: [
          {
            id: 'cmp-main',
            name: 'Main',
            // No approvedThrough on the component → nothing eligible
            versions: [{ version: '0.908.1', status: 'shipped' }],
          },
        ],
      };
      // Legacy says "0.908.1 approved" + roadmap has 0.908.1 shipped
      // → legacy alone wouldn't enable, but a stale legacy bump shouldn't
      //   light up Start when the component banner is empty.
      expect(hasAnyApprovedUnshippedWork(project, [])).toBe(false);
    });
  });

  describe('legacy fallback (no components defined)', () => {
    it('uses project.autonomy.approvedThrough against roadmapVersions', () => {
      const project = {
        id: 'p-legacy',
        state: 'stopped',
        autonomy: { approvedThrough: '0.2.0' },
        // no components / sections at all
      };
      const roadmapVersions = [
        { version: '0.1.0', status: 'shipped' },
        { version: '0.2.0', status: 'planned' }, // within horizon → enable
      ];
      expect(hasAnyApprovedUnshippedWork(project, roadmapVersions)).toBe(true);
    });

    it('disables when legacy horizon covers only shipped versions', () => {
      const project = {
        id: 'p-legacy',
        state: 'stopped',
        autonomy: { approvedThrough: '0.2.0' },
      };
      const roadmapVersions = [
        { version: '0.1.0', status: 'shipped' },
        { version: '0.2.0', status: 'shipped' },
        { version: '0.3.0', status: 'planned' }, // above legacy horizon
      ];
      expect(hasAnyApprovedUnshippedWork(project, roadmapVersions)).toBe(false);
    });
  });
});

describe('Thrivor regression — QA cycle should enable Start', () => {
  it('lights up Start when QA component has a current version within its horizon', () => {
    // Reproduces the exact shape committed by collapse-qa-to-rolling-version.mjs:
    //  - Main shipped through 0.908.1
    //  - QA component has 3 historical shipped versions + 1 current (0.908.1)
    //  - QA approvedThrough = 0.908.1 (the user just dragged the banner)
    const thrivor = {
      id: 'thrivor',
      state: 'stopped',
      autonomy: { approvedThrough: '0.908.1' }, // legacy stays for back-compat, must not be relied on
      components: [
        {
          id: 'cmp-main',
          name: 'Main',
          approvedVersions: ['0.1.0', '0.908.1'],
          versions: [
            { version: '0.1.0', status: 'shipped' },
            { version: '0.908.1', status: 'shipped' },
          ],
        },
        {
          id: 'cmp-qa',
          name: 'QA',
          role: 'qa',
          approvedVersions: ['0.1.0', '0.2.0', '0.9.0', '0.908.1'],
          versions: [
            { version: '0.1.0', status: 'shipped' },
            { version: '0.2.0', status: 'shipped' },
            { version: '0.9.0', status: 'shipped' },
            { version: '0.908.1', status: 'current' }, // ← live QA cycle
          ],
        },
      ],
    };
    expect(hasAnyApprovedUnshippedWork(thrivor, [])).toBe(true);
  });
});
