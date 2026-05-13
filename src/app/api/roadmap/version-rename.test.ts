/**
 * #1267: Tests for the version-rename POST flow on
 * src/app/api/roadmap/[projectId]/route.ts and the pure
 * src/lib/roadmap-rename helper.
 *
 * The route handler is invoked directly. We mock:
 *   - `pg` (Pool / connect / query) so SQL goes nowhere real.
 *   - `@/lib/auth` so authenticateRequest returns null (no auth error).
 *   - `@/lib/store-provider` so the archive-check read() returns a stub.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { renameVersionInProjectData } from '@/lib/roadmap-rename';

// ---- pg mock ---------------------------------------------------------------
// Per-test we swap a `pgState` reference; the mock reads from it on each call.
type Row = Record<string, any>;
interface PgState {
  // Map of regex -> handler returning rows; checked in order.
  handlers: Array<(sql: string, params: any[]) => { rows: Row[]; rowCount?: number } | null>;
  queryLog: Array<{ sql: string; params: any[] }>;
}
const pgState: PgState = { handlers: [], queryLog: [] };

vi.mock('pg', () => {
  return {
    Pool: class {
      constructor(_: any) {}
      async connect() {
        return {
          query: async (sql: string, params?: any[]) => {
            pgState.queryLog.push({ sql, params: params || [] });
            for (const h of pgState.handlers) {
              const r = h(sql, params || []);
              if (r) return r;
            }
            return { rows: [], rowCount: 0 };
          },
          release: () => {},
        };
      }
      async end() {}
    },
  };
});

vi.mock('@/lib/auth', () => ({
  authenticateRequest: async () => null, // always allow
}));

vi.mock('@/lib/store-provider', () => ({
  getStoreProvider: () => ({
    read: async () => ({ projects: [], tasks: [], settings: {} }),
  }),
}));

// We import the route module AFTER the mocks above are registered.
// Lazy-required inside each test to avoid module-cache bleed.
let POST: any;
beforeEach(async () => {
  pgState.handlers = [];
  pgState.queryLog = [];
  process.env.DATABASE_URL = 'postgres://test/test';
  vi.resetModules();
  const mod = await import('@/app/api/roadmap/[projectId]/route');
  POST = mod.POST;
});

function makeReq(body: any): any {
  // Minimal NextRequest stand-in: the route only calls `await req.json()`
  // and reads via `authenticateRequest` (mocked). A plain object suffices.
  return {
    json: async () => body,
    headers: new Map(),
  };
}

function projectIdParam(id: string) {
  return { params: Promise.resolve({ projectId: id }) };
}

// ---- Pure helper tests -----------------------------------------------------

describe('#1267 renameVersionInProjectData (pure)', () => {
  test('rewrites component versions[] entry version + rv-derived id', () => {
    const data = {
      components: [
        {
          id: 'c1',
          versions: [
            { id: 'rv-p1-1-0-0', version: '1.0.0', title: 'old' },
            { id: 'rv-p1-2-0-0', version: '2.0.0', title: 'untouched' },
          ],
        },
      ],
    };
    const out = renameVersionInProjectData(data, 'p1', '1.0.0', '1.5.0');
    expect(out.componentsHits).toBe(1);
    const v = out.data.components[0].versions.find((x: any) => x.version === '1.5.0');
    expect(v).toBeDefined();
    expect(v.id).toBe('rv-p1-1-5-0');
    // Original input untouched.
    expect(data.components[0].versions[0].version).toBe('1.0.0');
  });

  test('preserves custom (non-rv-shaped) id when rewriting version', () => {
    const data = {
      components: [
        {
          versions: [{ id: 'legacy-1', version: '1.0.0' }],
        },
      ],
    };
    const out = renameVersionInProjectData(data, 'p1', '1.0.0', '1.5.0');
    expect(out.data.components[0].versions[0].id).toBe('legacy-1');
    expect(out.data.components[0].versions[0].version).toBe('1.5.0');
  });

  test('rewrites approvedVersions strings on components and sections', () => {
    const data = {
      components: [{ approvedVersions: ['0.9.0', '1.0.0'] }],
      sections: [{ approvedVersions: ['1.0.0'] }],
    };
    const out = renameVersionInProjectData(data, 'p1', '1.0.0', '1.5.0');
    expect(out.data.components[0].approvedVersions).toContain('1.5.0');
    expect(out.data.components[0].approvedVersions).not.toContain('1.0.0');
    expect(out.data.sections[0].approvedVersions).toEqual(['1.5.0']);
    expect(out.approvedVersionsHits).toBeGreaterThan(0);
  });

  test('rewrites autonomy.approvedThrough and currentVersion when matching', () => {
    const data = {
      autonomy: { approvedThrough: '1.0.0' },
      currentVersion: '1.0.0',
    };
    const out = renameVersionInProjectData(data, 'p1', '1.0.0', '1.5.0');
    expect(out.data.autonomy.approvedThrough).toBe('1.5.0');
    expect(out.data.currentVersion).toBe('1.5.0');
    expect(out.autonomyApprovedThrough).toBe(true);
    expect(out.currentVersion).toBe(true);
  });

  test('no-op when nothing references the original version', () => {
    const data = {
      components: [{ versions: [{ id: 'rv-p1-9-9-9', version: '9.9.9' }] }],
      currentVersion: '9.9.9',
    };
    const out = renameVersionInProjectData(data, 'p1', '1.0.0', '1.5.0');
    expect(out.componentsHits).toBe(0);
    expect(out.currentVersion).toBe(false);
    expect(out.data.currentVersion).toBe('9.9.9');
  });
});

// ---- Route-handler tests ---------------------------------------------------

describe('#1267 POST upsert with originalVersion (rename)', () => {
  test('happy path: rename succeeds, no tasks', async () => {
    pgState.handlers = [
      // Source SELECT -> exists
      (sql) =>
        /FROM org_studio_roadmap_versions[\s\S]*FOR UPDATE/i.test(sql)
          ? { rows: [{ id: 'rv-p1-1-0-0', title: 'T', status: 'planned', items: [], version_type: 'outcome', owner: null }] }
          : null,
      // Target SELECT 1 -> empty
      (sql) =>
        /SELECT 1 FROM org_studio_roadmap_versions/i.test(sql) ? { rows: [] } : null,
      // UPDATE rv row
      (sql) =>
        /^\s*UPDATE org_studio_roadmap_versions/i.test(sql) ? { rows: [], rowCount: 1 } : null,
      // UPDATE tasks -> 0 rows
      (sql) =>
        /UPDATE org_studio_tasks/i.test(sql) ? { rows: [], rowCount: 0 } : null,
      // SELECT data FROM org_studio_projects -> minimal data
      (sql) =>
        /SELECT data FROM org_studio_projects/i.test(sql)
          ? { rows: [{ data: { components: [] } }] }
          : null,
      // UPDATE org_studio_projects
      (sql) =>
        /^\s*UPDATE org_studio_projects/i.test(sql) ? { rows: [], rowCount: 1 } : null,
    ];
    const res = await POST(
      makeReq({ action: 'upsert', version: '2.0.0', title: 'New', status: 'planned', items: [], originalVersion: '1.0.0' }),
      projectIdParam('p1'),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.action).toBe('renamed');
    expect(body.tasksMigrated).toBe(0);
    expect(body.id).toBe('rv-p1-2-0-0');
    expect(body.originalVersion).toBe('1.0.0');
    expect(body.version).toBe('2.0.0');
  });

  test('with tasks: tasksMigrated reflects rowCount', async () => {
    pgState.handlers = [
      (sql) =>
        /FROM org_studio_roadmap_versions[\s\S]*FOR UPDATE/i.test(sql)
          ? { rows: [{ id: 'rv-p1-1-0-0', title: 'T', status: 'planned', items: [], version_type: 'outcome', owner: null }] }
          : null,
      (sql) =>
        /SELECT 1 FROM org_studio_roadmap_versions/i.test(sql) ? { rows: [] } : null,
      (sql) =>
        /^\s*UPDATE org_studio_roadmap_versions/i.test(sql) ? { rows: [], rowCount: 1 } : null,
      (sql) =>
        /UPDATE org_studio_tasks/i.test(sql) ? { rows: [], rowCount: 3 } : null,
      (sql) =>
        /SELECT data FROM org_studio_projects/i.test(sql)
          ? { rows: [{ data: {} }] }
          : null,
      (sql) =>
        /^\s*UPDATE org_studio_projects/i.test(sql) ? { rows: [], rowCount: 1 } : null,
    ];
    const res = await POST(
      makeReq({ action: 'upsert', version: '2.0.0', title: 'New', status: 'planned', items: [], originalVersion: '1.0.0' }),
      projectIdParam('p1'),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.tasksMigrated).toBe(3);
  });

  test('conflict: target version already exists -> 409', async () => {
    pgState.handlers = [
      (sql) =>
        /FROM org_studio_roadmap_versions[\s\S]*FOR UPDATE/i.test(sql)
          ? { rows: [{ id: 'rv-p1-1-0-0', title: 'T', status: 'planned', items: [], version_type: 'outcome', owner: null }] }
          : null,
      (sql) =>
        /SELECT 1 FROM org_studio_roadmap_versions/i.test(sql)
          ? { rows: [{ '?column?': 1 }] }
          : null,
    ];
    const res = await POST(
      makeReq({ action: 'upsert', version: '2.0.0', title: 'New', status: 'planned', items: [], originalVersion: '1.0.0' }),
      projectIdParam('p1'),
    );
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error).toBe('rename_target_exists');
  });

  test('source missing: original version not found -> 404', async () => {
    pgState.handlers = [
      (sql) =>
        /FROM org_studio_roadmap_versions[\s\S]*FOR UPDATE/i.test(sql)
          ? { rows: [] }
          : null,
    ];
    const res = await POST(
      makeReq({ action: 'upsert', version: '2.0.0', title: 'New', status: 'planned', items: [], originalVersion: '9.9.9' }),
      projectIdParam('p1'),
    );
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error).toBe('rename_source_missing');
  });

  test('no-op rename: originalVersion === version falls through to upsert', async () => {
    pgState.handlers = [
      // Plain INSERT ... ON CONFLICT
      (sql) =>
        /INSERT INTO org_studio_roadmap_versions/i.test(sql)
          ? { rows: [], rowCount: 1 }
          : null,
    ];
    const res = await POST(
      makeReq({ action: 'upsert', version: '1.0.0', title: 'Same', status: 'planned', items: [], originalVersion: '1.0.0' }),
      projectIdParam('p1'),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.action).toBe('upserted');
    // Did NOT take the rename path. The rename branch is uniquely
    // identified by an UPDATE against org_studio_tasks (to retag
    // version strings on existing tasks) — the upsert branch never
    // touches that table. (#1314: stopped asserting absence of
    // SELECT ... FOR UPDATE; the upsert path now legitimately locks
    // the project row to keep section/component shadows in sync.)
    const sawTasksRetag = pgState.queryLog.some((q) =>
      /UPDATE org_studio_tasks/i.test(q.sql),
    );
    expect(sawTasksRetag).toBe(false);
  });
});
