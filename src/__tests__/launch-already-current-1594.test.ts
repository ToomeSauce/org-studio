/**
 * #1594 — Launch bug regression tests for promoteProjectToNextVersion.
 *
 * REPRO (2026-06-03, proj-org-studio): Basil made 2026.07.01 current and
 * approved it; its 6 planning tickets never moved to backlog despite
 * repeated Launch clicks. Three compounding gaps:
 *
 *   1. Launching an ALREADY-current version skipped over it looking for the
 *      next `planned` version, so its planning tickets were never swept.
 *   2. The explicit Launch button didn't populate approvedVersions[], so the
 *      horizon gate bailed ("no versions approved").
 *   3. Approve raced the single-current invariant, leaving two current
 *      versions.
 *
 * These tests drive promoteProjectToNextVersion against an in-memory fake
 * pg client that pattern-matches the queries it issues. No real DB.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { promoteProjectToNextVersion } from '@/lib/project-state';

const WS = 'default-workspace';
const PID = 'proj-test';

// ── In-memory fake pg client ────────────────────────────────────────────
// Models just enough of org_studio_projects / _roadmap_versions / _tasks for
// the promote path. Query routing is by substring match on the SQL text.
function makeFakeClient(initial: {
  project: any;
  versions: Array<{ version: string; status: string; sort_order: number; items: any[]; meta?: any }>;
  tasks: Array<{ id: string; version: string; status: string }>;
}) {
  const db = {
    project: JSON.parse(JSON.stringify(initial.project)),
    versions: JSON.parse(JSON.stringify(initial.versions)),
    tasks: JSON.parse(JSON.stringify(initial.tasks)),
  };

  const queries: string[] = [];
  const client = {
    db,
    queries,
    async query(sql: string, params: any[] = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      queries.push(s);

      // SELECT data FROM org_studio_projects
      if (/SELECT data FROM org_studio_projects/i.test(s)) {
        return { rows: [{ data: JSON.parse(JSON.stringify(db.project)) }] };
      }
      // UPDATE org_studio_projects SET data
      if (/UPDATE org_studio_projects SET data/i.test(s)) {
        db.project = JSON.parse(params[0]);
        return { rowCount: 1, rows: [] };
      }
      // SELECT sort_order FROM ... roadmap_versions WHERE version = $2
      if (/SELECT sort_order FROM org_studio_roadmap_versions/i.test(s)) {
        const v = db.versions.find((x: any) => x.version === params[1]);
        return { rows: v ? [{ sort_order: v.sort_order }] : [] };
      }
      // SELECT an already-current successor left by an interrupted promotion.
      if (/SELECT version, sort_order FROM org_studio_roadmap_versions/i.test(s) && /status = 'current'/i.test(s)) {
        const fromVersion = params[1];
        const floor = params[2];
        const next = db.versions
          .filter((x: any) => x.status === 'current' && x.version !== fromVersion && x.sort_order > floor)
          .sort((a: any, b: any) => a.sort_order - b.sort_order)[0];
        return { rows: next ? [{ version: next.version, sort_order: next.sort_order }] : [] };
      }
      // SELECT next planned version by sort_order
      if (/SELECT version, sort_order FROM org_studio_roadmap_versions/i.test(s) && /status = 'planned'/i.test(s)) {
        const floor = params[1];
        const next = db.versions
          .filter((x: any) => x.status === 'planned' && x.sort_order > floor)
          .sort((a: any, b: any) => a.sort_order - b.sort_order)[0];
        return { rows: next ? [{ version: next.version, sort_order: next.sort_order }] : [] };
      }
      // COUNT stranded planning tasks for a version
      if (/SELECT COUNT\(\*\)/i.test(s) && /org_studio_tasks/i.test(s)) {
        const [, ver] = params;
        const n = db.tasks.filter((t: any) => t.version === ver && t.status === 'planning').length;
        return { rows: [{ n }] };
      }
      // SELECT source status/meta FROM roadmap_versions
      if (/SELECT status, meta FROM org_studio_roadmap_versions/i.test(s)) {
        const v = db.versions.find((x: any) => x.version === params[1]);
        return { rows: v ? [{ status: v.status, meta: v.meta || {} }] : [] };
      }
      // SELECT id, items FROM roadmap_versions
      if (/SELECT id, items FROM org_studio_roadmap_versions/i.test(s)) {
        const v = db.versions.find((x: any) => x.version === params[1]);
        return { rows: v ? [{ id: `rv-${v.version}`, items: v.items }] : [] };
      }
      // Demote other current versions (single-current invariant)
      if (/UPDATE org_studio_roadmap_versions SET status = 'planned'/i.test(s) && /status = 'current'/i.test(s)) {
        for (const v of db.versions) {
          if (v.status === 'current' && v.version !== params[1]) v.status = 'planned';
        }
        return { rowCount: 1, rows: [] };
      }
      // Set target version current
      if (/UPDATE org_studio_roadmap_versions SET status = 'current' WHERE id = \$1/i.test(s)) {
        const id = params[0];
        const v = db.versions.find((x: any) => `rv-${x.version}` === id);
        if (v) v.status = 'current';
        return { rowCount: 1, rows: [] };
      }
      // SELECT id, status FROM tasks WHERE id = $1
      if (/SELECT id, status FROM org_studio_tasks/i.test(s)) {
        const t = db.tasks.find((x: any) => x.id === params[0]);
        return { rows: t ? [{ id: t.id, status: t.status }] : [] };
      }
      // UPDATE tasks SET status = $1 ... WHERE id = $4 AND status = $6
      if (/UPDATE org_studio_tasks SET status = \$1/i.test(s)) {
        const [newStatus, version, , taskId, , whereStatus] = params;
        const t = db.tasks.find((x: any) => x.id === taskId && x.status === whereStatus);
        if (t) { t.status = newStatus; t.version = version; return { rowCount: 1, rows: [] }; }
        return { rowCount: 0, rows: [] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return client;
}

function baseProject(approvedVersions?: string[]) {
  return {
    id: PID,
    state: 'active',
    currentVersion: '2026.07.01',
    components: [
      { id: 'cmp-main', name: 'Main', role: null, ...(approvedVersions ? { approvedVersions } : {}) },
    ],
    devOwner: 'Mikey',
  };
}

describe('#1594 — launch already-current version in place', () => {
  let client: any;
  beforeEach(() => {
    client = makeFakeClient({
      project: baseProject(), // NOTE: no approvedVersions — reproduces the bug
      versions: [
        { version: '2026.07.01', status: 'current', sort_order: 60701000, items: [
          { id: 'i1', taskId: 't1' }, { id: 'i2', taskId: 't2' },
        ] },
        { version: '2026.08.01', status: 'planned', sort_order: 60801000, items: [
          { id: 'i3', taskId: 't3' },
        ] },
      ],
      tasks: [
        { id: 't1', version: '2026.07.01', status: 'planning' },
        { id: 't2', version: '2026.07.01', status: 'planning' },
        { id: 't3', version: '2026.08.01', status: 'planning' },
      ],
    });
  });

  it('explicit launch of the current version sweeps ITS planning tickets to backlog', async () => {
    const res = await promoteProjectToNextVersion(PID, client, {
      targetVersion: '2026.07.01',
      explicitLaunch: true,
    });
    expect(res.promoted).toBe(true);
    expect(res.to).toBe('2026.07.01');
    expect(res.movedTasks).toBe(2);
    // 07.01 tickets moved; 08.01 untouched.
    expect(client.db.tasks.find((t: any) => t.id === 't1').status).toBe('backlog');
    expect(client.db.tasks.find((t: any) => t.id === 't2').status).toBe('backlog');
    expect(client.db.tasks.find((t: any) => t.id === 't3').status).toBe('planning');
  });

  it('explicit launch self-approves the target (populates approvedVersions[])', async () => {
    await promoteProjectToNextVersion(PID, client, {
      targetVersion: '2026.07.01',
      explicitLaunch: true,
    });
    const comp = client.db.project.components.find((c: any) => c.id === 'cmp-main');
    expect(comp.approvedVersions).toContain('2026.07.01');
  });

  it('preserves the single-current invariant: no second current version after launch', async () => {
    // Seed a stray second current version (the race in the repro).
    client.db.versions.push({ version: '2026.06.01', status: 'current', sort_order: 60601000, items: [] });
    await promoteProjectToNextVersion(PID, client, {
      targetVersion: '2026.07.01',
      explicitLaunch: true,
    });
    const currents = client.db.versions.filter((v: any) => v.status === 'current');
    expect(currents).toHaveLength(1);
    expect(currents[0].version).toBe('2026.07.01');
  });

  it('auto-mode (no targetVersion) falls back to launch-in-place when current has stranded planning tickets and no next planned', async () => {
    // Remove the planned 08.01 so there's no "next planned" to advance to.
    client.db.versions = client.db.versions.filter((v: any) => v.version !== '2026.08.01');
    client.db.tasks = client.db.tasks.filter((t: any) => t.id !== 't3');
    // approve 07.01 so the horizon gate passes in auto-mode (no explicitLaunch).
    client.db.project.components[0].approvedVersions = ['2026.07.01'];
    const res = await promoteProjectToNextVersion(PID, client, {});
    expect(res.promoted).toBe(true);
    expect(res.to).toBe('2026.07.01');
    expect(res.movedTasks).toBe(2);
  });

  it('without explicitLaunch and without approval, the horizon gate still blocks (no silent launch)', async () => {
    // No approvedVersions, no explicitLaunch → must NOT promote.
    const res = await promoteProjectToNextVersion(PID, client, {
      targetVersion: '2026.07.01',
    });
    expect(res.promoted).toBe(false);
    expect(res.reason).toMatch(/not approved|no versions approved/);
  });
});


describe('post-shipment outcome-gate recovery', () => {
  function recoveryClient(sourceStatus: 'current' | 'shipped', approved = true) {
    return makeFakeClient({
      project: {
        id: PID,
        state: 'active',
        currentVersion: '0.7.1',
        components: [{
          id: 'cmp-main',
          name: 'Main',
          role: null,
          approvedVersions: approved ? ['0.7.1', '0.7.2'] : ['0.7.1'],
        }],
        devOwner: 'Mikey',
      },
      versions: [
        {
          version: '0.7.1',
          status: sourceStatus,
          sort_order: 7001000,
          items: [{ id: 'done', taskId: 'done-task', done: true }],
          meta: { successCriteria: 'binary proof', metricCurrent: 0, metricTarget: 1, metricComparator: 'gte' },
        },
        {
          version: '0.7.2',
          status: 'planned',
          sort_order: 7002000,
          items: [{ id: 'next', taskId: 'next-task', done: false }],
        },
      ],
      tasks: [
        { id: 'done-task', version: '0.7.1', status: 'done' },
        { id: 'next-task', version: '0.7.2', status: 'planning' },
      ],
    });
  }

  it('advances past an explicitly shipped source even when its old metric is unmet', async () => {
    const client: any = recoveryClient('shipped');
    const result = await promoteProjectToNextVersion(PID, client);
    expect(result.promoted).toBe(true);
    expect(result.from).toBe('0.7.1');
    expect(result.to).toBe('0.7.2');
    expect(client.db.project.currentVersion).toBe('0.7.2');
    expect(client.db.tasks.find((t: any) => t.id === 'next-task').status).toBe('backlog');
  });

  it('still blocks unattended promotion while the source is current and its metric is unmet', async () => {
    const client: any = recoveryClient('current');
    const result = await promoteProjectToNextVersion(PID, client);
    expect(result.promoted).toBe(false);
    expect(result.reason).toBe('current version metric not met');
    expect(client.db.project.currentVersion).toBe('0.7.1');
    expect(client.db.tasks.find((t: any) => t.id === 'next-task').status).toBe('planning');
  });

  it('repairs an already-current immediate successor instead of skipping to a later planned version', async () => {
    const client: any = recoveryClient('shipped');
    client.db.versions.find((v: any) => v.version === '0.7.2').status = 'current';
    client.db.versions.push({
      version: '0.7.3',
      status: 'planned',
      sort_order: 7003000,
      items: [{ id: 'later', taskId: 'later-task', done: false }],
    });
    client.db.tasks.push({ id: 'later-task', version: '0.7.3', status: 'planning' });
    client.db.project.components[0].approvedVersions.push('0.7.3');

    const result = await promoteProjectToNextVersion(PID, client);

    expect(result.promoted).toBe(true);
    expect(result.to).toBe('0.7.2');
    expect(client.db.project.currentVersion).toBe('0.7.2');
    expect(client.db.tasks.find((t: any) => t.id === 'next-task').status).toBe('backlog');
    expect(client.db.tasks.find((t: any) => t.id === 'later-task').status).toBe('planning');
  });

  it('serializes the promote transaction before reading lifecycle state', async () => {
    const client: any = recoveryClient('shipped');
    await promoteProjectToNextVersion(PID, client);

    expect(client.queries[0]).toBe('BEGIN');
    expect(client.queries[1]).toMatch(/pg_advisory_xact_lock/);
    expect(client.queries.at(-1)).toBe('COMMIT');
  });

  it('does not let shipped status bypass the approval horizon', async () => {
    const client: any = recoveryClient('shipped', false);
    const result = await promoteProjectToNextVersion(PID, client);
    expect(result.promoted).toBe(false);
    expect(result.reason).toMatch(/not approved/);
  });
});
