import { describe, it, expect } from 'vitest';
import {
  checkPackageVersion,
  checkStoreVersions,
  runVersionGuard,
  formatViolations,
  type StoreShape,
} from './version-guard';

describe('version-guard — package.json (semver surface)', () => {
  it('accepts valid semver', () => {
    expect(checkPackageVersion('0.4.0')).toHaveLength(0);
    expect(checkPackageVersion('1.2.3')).toHaveLength(0);
    expect(checkPackageVersion('10.0.11')).toHaveLength(0);
  });

  it('rejects a deliberately-malformed semver (bare 2-part)', () => {
    const v = checkPackageVersion('0.4');
    expect(v).toHaveLength(1);
    expect(v[0].expected).toBe('semver');
  });

  it('rejects a v-prefixed string', () => {
    expect(checkPackageVersion('v0.4.0').length).toBeGreaterThan(0);
  });

  it('rejects missing/non-string', () => {
    expect(checkPackageVersion(undefined).length).toBeGreaterThan(0);
    expect(checkPackageVersion(42 as unknown).length).toBeGreaterThan(0);
  });
});

describe('version-guard — store (per-project scheme consistency)', () => {
  const good: StoreShape = {
    projects: [
      {
        id: 'proj-org-studio',
        currentVersion: '2026.05.07',
        sections: [
          { id: 'sec-main', name: 'Main', approvedVersions: ['2026.03.15', '2026.04.18.2', '2026.05.07'] },
        ],
      },
      // A deliberately semver-roadmap project (e.g. Thrivor) must NOT be flagged.
      { id: 'proj-thrivor', currentVersion: '0.18.20' },
    ],
    tasks: [
      { id: 't1', ticketNumber: 1, projectId: 'proj-org-studio', version: '2026.05.07' },
      { id: 't2', ticketNumber: 2, projectId: 'proj-org-studio' }, // unset version is allowed
      { id: 't3', ticketNumber: 3, projectId: 'proj-thrivor', version: '0.18.19' },
      { id: 't4', ticketNumber: 4, projectId: 'proj-thrivor', version: '0.18.20' },
    ],
  };

  it('passes a clean mixed-project store (calver project + semver project)', () => {
    expect(checkStoreVersions(good)).toHaveLength(0);
  });

  it('does NOT flag a project merely for choosing semver over calver', () => {
    const semverProj: StoreShape = {
      projects: [{ id: 'p', currentVersion: '1.2.0' }],
      tasks: [{ id: 't', projectId: 'p', version: '1.3.0' }],
    };
    expect(checkStoreVersions(semverProj)).toHaveLength(0);
  });

  it('flags intra-project scheme mixing (minority entry)', () => {
    const mixed: StoreShape = {
      projects: [{ id: 'p', currentVersion: '2026.05.07' }],
      tasks: [
        { id: 'a', projectId: 'p', version: '2026.05.07' },
        { id: 'b', projectId: 'p', version: '2026.05.08' },
        { id: 'c', projectId: 'p', version: '0.4.0' }, // the semver odd-one-out
      ],
    };
    const v = checkStoreVersions(mixed);
    expect(v).toHaveLength(1);
    expect(v[0].value).toBe('0.4.0');
    expect(v[0].reason).toMatch(/mixed scheme/);
  });

  it('rejects 99.99.x sentinel junk regardless of project scheme', () => {
    const bad: StoreShape = {
      projects: [{ id: 'p', currentVersion: '1.0.0' }],
      tasks: [{ id: 't', ticketNumber: 9, projectId: 'p', version: '99.99.99' }],
    };
    const v = checkStoreVersions(bad);
    expect(v.length).toBeGreaterThan(0);
    expect(v.some((x) => /sentinel/.test(x.reason))).toBe(true);
  });

  it('rejects a malformed hybrid label', () => {
    const bad: StoreShape = {
      projects: [{ id: 'p', currentVersion: '1.0.0' }],
      tasks: [{ id: 't', projectId: 'p', version: '2026.06-platform-hardening' }],
    };
    expect(checkStoreVersions(bad).length).toBeGreaterThan(0);
  });

  it('rejects an impossible calver date in a calver project', () => {
    const bad: StoreShape = {
      projects: [{ id: 'p', currentVersion: '2026.05.07' }],
      tasks: [
        { id: 'a', projectId: 'p', version: '2026.05.07' },
        { id: 't', projectId: 'p', version: '2026.13.40' },
      ],
    };
    expect(checkStoreVersions(bad).length).toBeGreaterThan(0);
  });

  it('scans section.versions[].version (the canonical roadmap list)', () => {
    // A semver odd-one-out hiding in versions[] of a calver project must be caught.
    const bad: StoreShape = {
      projects: [
        {
          id: 'p',
          currentVersion: '2026.05.07',
          sections: [
            { id: 's', versions: [{ version: '2026.05.07' }, { version: '2026.05.13' }, { version: '0.4.0' }] },
          ],
        },
      ],
    };
    const v = checkStoreVersions(bad);
    expect(v.some((x) => x.value === '0.4.0' && /versions\[\]/.test(x.surface))).toBe(true);
  });

  it('exempts an explicitly-marked named umbrella in versions[]', () => {
    // Mirrors catpilot: three calvers + a Basil-owned "2026-Q2-sprint" umbrella.
    const ok: StoreShape = {
      projects: [
        {
          id: 'proj-catpilot',
          currentVersion: '2026.05.23',
          sections: [
            {
              id: 's',
              approvedVersions: ['2026.05.23'],
              versions: [
                { version: '2026.05.07' },
                { version: '2026.05.13' },
                { version: '2026.05.23' },
                { version: '2026-Q2-sprint', kind: 'umbrella' }, // exempt
              ],
            },
          ],
        },
      ],
    };
    expect(checkStoreVersions(ok)).toHaveLength(0);
  });

  it('still flags an UNMARKED non-parseable version in versions[]', () => {
    const bad: StoreShape = {
      projects: [
        {
          id: 'p',
          currentVersion: '2026.05.07',
          sections: [{ id: 's', versions: [{ version: '2026.05.07' }, { version: '2026-Q2-sprint' }] }],
        },
      ],
    };
    const v = checkStoreVersions(bad);
    expect(v.some((x) => x.value === '2026-Q2-sprint')).toBe(true);
  });

  it('accepts isUmbrella:true and scheme:"named" markers too', () => {
    const ok: StoreShape = {
      projects: [
        {
          id: 'p',
          currentVersion: '2026.05.07',
          sections: [
            {
              id: 's',
              versions: [
                { version: '2026.05.07' },
                { version: 'Q3-bigbet', isUmbrella: true },
                { version: 'launch-window', scheme: 'named' },
              ],
            },
          ],
        },
      ],
    };
    expect(checkStoreVersions(ok)).toHaveLength(0);
  });
});

describe('version-guard — combined runner', () => {
  it('aggregates violations across both surfaces', () => {
    const violations = runVersionGuard({
      packageVersion: '0.4', // bad semver
      store: { projects: [{ id: 'p', currentVersion: '1.0.0' }], tasks: [{ id: 't', projectId: 'p', version: '99.99.99' }] }, // sentinel junk
    });
    expect(violations.length).toBe(2);
    expect(formatViolations(violations)).toMatch(/FAIL/);
  });

  it('reports PASS when everything conforms', () => {
    const violations = runVersionGuard({
      packageVersion: '0.4.0',
      store: { projects: [{ id: 'p', currentVersion: '2026.05.07' }] },
    });
    expect(violations).toHaveLength(0);
    expect(formatViolations(violations)).toMatch(/PASS/);
  });
});
