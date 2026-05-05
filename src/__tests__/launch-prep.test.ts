/**
 * #1229 — launch-prep unit tests.
 *
 * Covers:
 *   1. buildStubVisionDoc — pure builder
 *   2. mirrorMissingRoadmapVersions — only inserts missing rows
 *   3. ensureVisionDoc — only inserts when none exists
 *   4. ensureLaunchPreconditions — orchestrates both, idempotent
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildStubVisionDoc,
  ensureLaunchPreconditions,
  ensureVisionDoc,
  mirrorMissingRoadmapVersions,
} from '@/lib/launch-prep';

// ---- fake pg pool ---------------------------------------------------

interface FakeRows { [key: string]: any[] }

function mkFakePool(initial: { rvRows?: any[]; visionRows?: any[] } = {}) {
  const rvRows: any[] = [...(initial.rvRows || [])];
  const visionRows: any[] = [...(initial.visionRows || [])];
  const queries: { sql: string; params: any[] }[] = [];

  const client = {
    async query(sql: string, params: any[] = []) {
      queries.push({ sql, params });

      // SELECT 1 FROM org_studio_roadmap_versions WHERE project_id = $1 AND version = $2 ...
      if (/FROM org_studio_roadmap_versions/i.test(sql) && /SELECT 1/i.test(sql)) {
        const [pid, ver] = params;
        const found = rvRows.find((r) => r.project_id === pid && r.version === ver);
        return { rows: found ? [{ '?column?': 1 }] : [] };
      }

      // INSERT INTO org_studio_roadmap_versions ...
      if (/INSERT INTO org_studio_roadmap_versions/i.test(sql)) {
        const [id, project_id, version, title, status, itemsJson, sort_order, created_at, version_type, workspace_id, owner] = params;
        // Honor ON CONFLICT (project_id, version) DO NOTHING
        const dup = rvRows.find((r) => r.project_id === project_id && r.version === version);
        if (!dup) {
          rvRows.push({
            id, project_id, version, title, status,
            items: typeof itemsJson === 'string' ? JSON.parse(itemsJson) : itemsJson,
            sort_order, created_at, version_type, workspace_id, owner,
          });
        }
        return { rows: [], rowCount: dup ? 0 : 1 };
      }

      // SELECT 1 FROM org_studio_vision_docs ...
      if (/FROM org_studio_vision_docs/i.test(sql) && /SELECT 1/i.test(sql)) {
        const [pid] = params;
        const found = visionRows.find((r) => r.project_id === pid);
        return { rows: found ? [{ '?column?': 1 }] : [] };
      }

      // INSERT INTO org_studio_vision_docs ...
      if (/INSERT INTO org_studio_vision_docs/i.test(sql)) {
        const [project_id, content, updated_at, workspace_id] = params;
        const dup = visionRows.find((r) => r.project_id === project_id);
        if (!dup) {
          visionRows.push({ project_id, content, updated_at, workspace_id });
        }
        return { rows: [], rowCount: dup ? 0 : 1 };
      }

      throw new Error(`unmocked query: ${sql.slice(0, 80)}`);
    },
    release() { /* noop */ },
  };

  const pool: any = {
    async connect() { return client; },
    _state: { rvRows, visionRows, queries },
  };
  return pool;
}

// ---- fixtures -------------------------------------------------------

function mkProject(overrides: any = {}) {
  return {
    id: 'proj-test',
    name: 'Test Project',
    description: 'A project for testing launch-prep',
    owner: 'Henry',
    devOwner: 'Henry',
    sections: [
      {
        id: 'sec-main-proj-test',
        name: 'Main',
        owner: 'Henry',
        versions: [
          {
            id: 'v-test-0-1',
            version: '0.1.0',
            title: 'First version',
            status: 'planned',
            items: [{ id: 'ri-1', title: 'Do the thing', taskId: 't-1', done: false }],
            sort_order: 1000,
            version_type: 'outcome',
            createdAt: 1700000000000,
          },
        ],
      },
    ],
    ...overrides,
  };
}

// ---- 1. buildStubVisionDoc -----------------------------------------

describe('buildStubVisionDoc', () => {
  it('includes name, owner, and description', () => {
    const proj = mkProject();
    const doc = buildStubVisionDoc(proj);
    expect(doc).toContain('# Test Project — Vision');
    expect(doc).toContain('**Henry**');
    expect(doc).toContain('A project for testing launch-prep');
    expect(doc).toContain('## 0.1.0');
  });

  it('falls back to placeholders when fields are missing', () => {
    const doc = buildStubVisionDoc({});
    expect(doc).toContain('Untitled Project');
    expect(doc).toContain('**TBD**');
    expect(doc).toContain('_No description provided._');
    // Default version placeholder when no roadmap exists
    expect(doc).toContain('## 0.1.0');
  });

  it('uses currentVersion if set', () => {
    const proj = mkProject({ currentVersion: '0.5.2' });
    const doc = buildStubVisionDoc(proj);
    expect(doc).toContain('## 0.5.2');
  });

  it('uses components[] when sections[] is absent', () => {
    const proj = {
      id: 'p',
      name: 'P',
      components: [{ versions: [{ version: '2026.05.01' }] }],
    };
    const doc = buildStubVisionDoc(proj);
    expect(doc).toContain('## 2026.05.01');
  });
});

// ---- 2. mirrorMissingRoadmapVersions -------------------------------

describe('mirrorMissingRoadmapVersions', () => {
  it('inserts missing rv rows for embedded versions', async () => {
    const pool = mkFakePool();
    const proj = mkProject();
    const minted = await mirrorMissingRoadmapVersions('proj-test', proj, pool, 'default-workspace');
    expect(minted).toEqual(['0.1.0']);
    expect(pool._state.rvRows).toHaveLength(1);
    expect(pool._state.rvRows[0]).toMatchObject({
      project_id: 'proj-test',
      version: '0.1.0',
      title: 'First version',
      status: 'planned',
      version_type: 'outcome',
      owner: 'Henry',
    });
  });

  it('skips versions that already exist in rv-table', async () => {
    const pool = mkFakePool({
      rvRows: [{ project_id: 'proj-test', version: '0.1.0', items: [], status: 'shipped' }],
    });
    const proj = mkProject();
    const minted = await mirrorMissingRoadmapVersions('proj-test', proj, pool, 'default-workspace');
    expect(minted).toEqual([]);
    // Status should NOT be overwritten — we only insert, never update
    expect(pool._state.rvRows[0].status).toBe('shipped');
  });

  it('handles projects with neither sections nor components', async () => {
    const pool = mkFakePool();
    const minted = await mirrorMissingRoadmapVersions('p', { id: 'p', name: 'P' }, pool, 'default-workspace');
    expect(minted).toEqual([]);
  });

  it('auto-mints item ids when items lack one', async () => {
    const pool = mkFakePool();
    const proj = mkProject({
      sections: [
        {
          id: 'sec',
          versions: [
            { version: '0.1.0', items: [{ title: 'no id', taskId: 't1' }] },
          ],
        },
      ],
    });
    await mirrorMissingRoadmapVersions('proj-test', proj, pool, 'default-workspace');
    expect(pool._state.rvRows[0].items[0].id).toMatch(/^item-/);
  });
});

// ---- 3. ensureVisionDoc --------------------------------------------

describe('ensureVisionDoc', () => {
  it('inserts a stub when none exists', async () => {
    const pool = mkFakePool();
    const minted = await ensureVisionDoc('proj-test', mkProject(), pool, 'default-workspace');
    expect(minted).toBe(true);
    expect(pool._state.visionRows).toHaveLength(1);
    expect(pool._state.visionRows[0].content).toContain('# Test Project — Vision');
  });

  it('is a noop when a doc already exists', async () => {
    const pool = mkFakePool({
      visionRows: [{ project_id: 'proj-test', content: 'existing', updated_at: 0, workspace_id: 'default-workspace' }],
    });
    const minted = await ensureVisionDoc('proj-test', mkProject(), pool, 'default-workspace');
    expect(minted).toBe(false);
    expect(pool._state.visionRows[0].content).toBe('existing');
  });
});

// ---- 4. ensureLaunchPreconditions ----------------------------------

describe('ensureLaunchPreconditions', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgres://fake'; // pretend Postgres mode
  });

  it('mints both rv row and vision doc on a fresh project', async () => {
    const pool = mkFakePool();
    const res = await ensureLaunchPreconditions('proj-test', mkProject(), { pool });
    expect(res.ok).toBe(true);
    expect(res.mintedDoc).toBe(true);
    expect(res.mintedVersions).toEqual(['0.1.0']);
  });

  it('is idempotent on a second call', async () => {
    const pool = mkFakePool();
    await ensureLaunchPreconditions('proj-test', mkProject(), { pool });
    const second = await ensureLaunchPreconditions('proj-test', mkProject(), { pool });
    expect(second.ok).toBe(true);
    expect(second.mintedDoc).toBe(false);
    expect(second.mintedVersions).toEqual([]);
  });

  it('mints only the doc when rv rows already exist', async () => {
    const pool = mkFakePool({
      rvRows: [{ project_id: 'proj-test', version: '0.1.0', items: [], status: 'planned' }],
    });
    const res = await ensureLaunchPreconditions('proj-test', mkProject(), { pool });
    expect(res.ok).toBe(true);
    expect(res.mintedDoc).toBe(true);
    expect(res.mintedVersions).toEqual([]);
  });

  it('mints only the rv row when a doc already exists', async () => {
    const pool = mkFakePool({
      visionRows: [{ project_id: 'proj-test', content: 'existing', updated_at: 0, workspace_id: 'default-workspace' }],
    });
    const res = await ensureLaunchPreconditions('proj-test', mkProject(), { pool });
    expect(res.ok).toBe(true);
    expect(res.mintedDoc).toBe(false);
    expect(res.mintedVersions).toEqual(['0.1.0']);
  });

  it('returns ok with no-ops in file-store mode (no DATABASE_URL)', async () => {
    delete process.env.DATABASE_URL;
    const res = await ensureLaunchPreconditions('proj-test', mkProject());
    expect(res.ok).toBe(true);
    expect(res.mintedDoc).toBe(false);
    expect(res.mintedVersions).toEqual([]);
  });
});
