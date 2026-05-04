/**
 * #1125: store-provider hydrates component.versions[] from the canonical
 * org_studio_roadmap_versions table on every read(). Verifies the merge
 * semantics so the shadow roadmap can no longer drift from the rv-table.
 */

import { describe, test, expect } from 'vitest';
import { PostgresStoreProvider } from './store-provider';

// Build a fake pg client/pool whose query() returns canned rows based on the
// SQL it sees. We only need to satisfy the queries read() issues:
//   1) SELECT * FROM org_studio_projects ...
//   2) SELECT * FROM org_studio_tasks ...
//   3) SELECT data FROM org_studio_settings ...
//   4) SELECT ... FROM org_studio_roadmap_versions ... (the new hydration query)
function makeFakePool(opts: {
  projects: any[]; // shape: rows for org_studio_projects (data jsonb already deserialized)
  rvRows: any[];
}) {
  const client = {
    query: async (sql: string, _params?: any[]) => {
      if (/FROM org_studio_projects/i.test(sql)) {
        return { rows: opts.projects };
      }
      if (/FROM org_studio_tasks/i.test(sql)) {
        return { rows: [] };
      }
      if (/FROM org_studio_settings/i.test(sql)) {
        return { rows: [] };
      }
      if (/FROM org_studio_roadmap_versions/i.test(sql)) {
        return { rows: opts.rvRows };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  return {
    connect: async () => client,
  };
}

// Subclass that lets us inject the fake pool without touching real pg.
class TestProvider extends PostgresStoreProvider {
  constructor(public fakePool: any) {
    super('postgres://test/test', 'default-workspace');
  }
}
// Patch the prototype so the override wins (the parent's getPool is private).
(TestProvider.prototype as any).getPool = async function () {
  return (this as any).fakePool;
};

// Build a project row in the shape rowToObject expects. The simplest way
// is to put everything in `data` jsonb and rely on reconstructProject
// merging it. Required columns: id, name, data.
function projectRow(id: string, components: any[]) {
  return {
    id,
    name: id,
    data: { components },
  };
}

function rvRow(projectId: string, version: string, extras: Partial<any> = {}) {
  return {
    project_id: projectId,
    id: extras.id ?? `rv-${projectId}-${version.replace(/\./g, '-')}`,
    version,
    title: extras.title ?? `v${version}`,
    status: extras.status ?? 'planned',
    items: extras.items ?? [],
    sort_order: extras.sort_order ?? 0,
    version_type: extras.version_type ?? 'outcome',
    owner: extras.owner ?? null,
    shipped_at: extras.shipped_at ?? null,
    created_at: extras.created_at ?? null,
  };
}

describe('#1125 hydrateComponentVersions on read()', () => {
  test('populates primary.versions from rv-table when component.versions is empty', async () => {
    const projects = [
      projectRow('p1', [{ id: 'c1', name: 'Main', versions: [] }]),
    ];
    const rvRows = [
      rvRow('p1', '1.0', { sort_order: 1, status: 'shipped' }),
      rvRow('p1', '1.1', { sort_order: 2, status: 'in-progress' }),
    ];
    const provider = new TestProvider(makeFakePool({ projects, rvRows }));
    const store = await provider.read();

    const p = store.projects.find((x: any) => x.id === 'p1');
    expect(p).toBeDefined();
    const primary = p.components[0];
    expect(primary.versions).toHaveLength(2);
    expect(primary.versions.map((v: any) => v.version).sort()).toEqual(['1.0', '1.1']);
    expect(primary.versions[0].version_type).toBe('outcome');
  });

  test('preserves existing component.versions entries that have no rv-table row', async () => {
    const projects = [
      projectRow('p2', [
        {
          id: 'c1',
          name: 'Main',
          versions: [
            { id: 'legacy-x', version: 'legacy-x', status: 'shipped', items: [] },
            { id: 'legacy-2', version: '1.0', status: 'old-stale', items: [] },
          ],
        },
      ]),
    ];
    const rvRows = [
      rvRow('p2', '1.0', { status: 'shipped', sort_order: 1 }), // overlaps with legacy-2
      rvRow('p2', '2.0', { status: 'planned', sort_order: 2 }),
    ];
    const provider = new TestProvider(makeFakePool({ projects, rvRows }));
    const store = await provider.read();
    const primary = store.projects.find((x: any) => x.id === 'p2').components[0];

    // legacy-x preserved (no rv row matches), legacy-2 superseded by rv 1.0
    const versions = primary.versions;
    expect(versions.map((v: any) => v.version).sort()).toEqual(['1.0', '2.0', 'legacy-x']);
    const v10 = versions.find((v: any) => v.version === '1.0');
    expect(v10.status).toBe('shipped'); // rv-table value, not 'old-stale'
    const legacyX = versions.find((v: any) => v.version === 'legacy-x');
    expect(legacyX).toBeDefined();
  });

  test('does not touch QA-component versions[]', async () => {
    const qaSeed = [{ id: 'qa-seed', version: '1.0', status: 'planned', items: [] }];
    const projects = [
      projectRow('p3', [
        { id: 'main', name: 'Main', role: 'core', versions: [] },
        { id: 'qa1', name: 'QA', role: 'qa', versions: qaSeed },
      ]),
    ];
    const rvRows = [
      rvRow('p3', '1.0', { status: 'shipped' }),
      rvRow('p3', '1.1', { status: 'in-progress' }),
    ];
    const provider = new TestProvider(makeFakePool({ projects, rvRows }));
    const store = await provider.read();
    const comps = store.projects.find((x: any) => x.id === 'p3').components;
    const main = comps.find((c: any) => c.id === 'main');
    const qa = comps.find((c: any) => c.id === 'qa1');

    expect(main.versions.map((v: any) => v.version).sort()).toEqual(['1.0', '1.1']);
    // QA untouched: still the original single seed entry
    expect(qa.versions).toEqual(qaSeed);
  });

  test('rv-table rows take precedence on overlapping version strings', async () => {
    const projects = [
      projectRow('p4', [
        {
          id: 'c1',
          name: 'Main',
          versions: [
            { id: 'old-1', version: '1.0', status: 'stale-status', items: [{ id: 'x' }] },
          ],
        },
      ]),
    ];
    const rvRows = [
      rvRow('p4', '1.0', { id: 'rv-canonical', status: 'shipped', items: [{ id: 'fresh' }] }),
    ];
    const provider = new TestProvider(makeFakePool({ projects, rvRows }));
    const store = await provider.read();
    const primary = store.projects.find((x: any) => x.id === 'p4').components[0];

    expect(primary.versions).toHaveLength(1);
    expect(primary.versions[0].id).toBe('rv-canonical');
    expect(primary.versions[0].status).toBe('shipped');
    expect(primary.versions[0].items).toEqual([{ id: 'fresh' }]);
  });

  test('falls back to sections[] when components[] is missing/empty', async () => {
    // Mirrors real Thrivor-style data: sections[] is populated, components[] is absent.
    const projects = [
      {
        id: 'p6',
        name: 'p6',
        data: {
          sections: [{ id: 's1', name: 'Main', versions: [] }],
        },
      },
    ];
    const rvRows = [
      rvRow('p6', '0.9.9', { sort_order: 1, status: 'shipped' }),
      rvRow('p6', '0.9.14', { sort_order: 2, status: 'in-progress' }),
    ];
    const provider = new TestProvider(makeFakePool({ projects, rvRows }));
    const store = await provider.read();
    const p = store.projects.find((x: any) => x.id === 'p6');
    const primary = p.sections[0];
    expect(primary.versions).toHaveLength(2);
    expect(primary.versions.map((v: any) => v.version).sort()).toEqual(['0.9.14', '0.9.9']);
  });

  test('idempotent: running read() twice produces the same result', async () => {
    const projects = [
      projectRow('p5', [{ id: 'c1', name: 'Main', versions: [] }]),
    ];
    const rvRows = [
      rvRow('p5', '1.0'),
      rvRow('p5', '1.1'),
    ];
    const provider = new TestProvider(makeFakePool({ projects, rvRows }));
    const a = await provider.read();
    const b = await provider.read();
    const va = a.projects[0].components[0].versions;
    const vb = b.projects[0].components[0].versions;
    expect(vb).toEqual(va);
  });

  // #1214: rv-table `owner` round-trips into component.versions[i].owner.
  test('owner field round-trips from rv-table to component.versions[i].owner', async () => {
    const projects = [
      projectRow('p7', [{ id: 'c1', name: 'Main', owner: 'mikey', versions: [] }]),
    ];
    const rvRows = [
      rvRow('p7', '1.0', { owner: 'ana' }),       // version-level override
      rvRow('p7', '1.1', { owner: null }),         // null → falls through to component.owner via getEffectiveOwner
    ];
    const provider = new TestProvider(makeFakePool({ projects, rvRows }));
    const store = await provider.read();
    const primary = store.projects.find((x: any) => x.id === 'p7').components[0];
    const v10 = primary.versions.find((v: any) => v.version === '1.0');
    const v11 = primary.versions.find((v: any) => v.version === '1.1');
    expect(v10.owner).toBe('ana');
    // null in DB → undefined on the model (per hydration)
    expect(v11.owner).toBeUndefined();
  });
});
