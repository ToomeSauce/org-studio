/**
 * #1531 — status_history must be appended whenever the typed `status`
 * column is mutated, even via direct SQL.
 *
 * The bug:
 *   `promoteProjectToNextVersion` flipped task.status planning→backlog
 *   with a hand-rolled UPDATE that skipped status_history. Scheduler
 *   queries see backlog (truth); UI/history shows planning (stale).
 *   Two sources of truth diverged.
 *
 * This test is a regression guard: it shape-checks the SQL emitted by
 * `promoteProjectToNextVersion` to ensure the planning→backlog UPDATE
 * always touches BOTH typed `status` AND `status_history`.
 *
 * No live DB. We stub the pg `client` and capture every query.
 */

import { describe, it, expect } from 'vitest';
import { promoteProjectToNextVersion } from '../lib/project-state';

type CapturedQuery = { sql: string; values?: any[] };

function makeFakeClient(rows: Record<string, any[]>) {
  const captured: CapturedQuery[] = [];
  return {
    captured,
    query: async (sql: string, values?: any[]) => {
      captured.push({ sql, values });
      // Pick a matching canned response by first-table-or-keyword
      const norm = sql.replace(/\s+/g, ' ').trim();
      if (/FROM org_studio_projects/i.test(norm)) return { rows: rows.projects || [] };
      if (/FROM org_studio_roadmap_versions/i.test(norm)) return { rows: rows.versions || [] };
      if (/FROM org_studio_tasks/i.test(norm)) return { rows: rows.taskSelect || [] };
      if (/^UPDATE/i.test(norm)) return { rowCount: 1 };
      return { rows: [] };
    },
  };
}

describe('#1531 — promoteProjectToNextVersion writes status_history atomically', () => {
  it('planning→backlog UPDATE references both `status = \'backlog\'` AND `status_history`', async () => {
    const projData = {
      id: 'proj-test',
      currentVersion: '0.1',
      devOwner: 'TestAgent',
      state: 'active',
      components: [
        { id: 'sec-main-proj-test', name: 'Main', role: null, approvedVersions: ['0.1', '0.2'] },
      ],
    };
    const versionRow = {
      id: 'ver-target',
      version: '0.2',
      items: [{ id: 'item-1', taskId: 'task-1' }],
    };
    const taskRow = { id: 'task-1', status: 'planning' };

    const fake = makeFakeClient({
      projects: [{ data: projData }],
      versions: [versionRow],
      taskSelect: [taskRow],
    });

    const result = await promoteProjectToNextVersion('proj-test', fake as any, {
      targetVersion: '0.2',
      workspaceId: 'default-workspace',
    });

    // Find the task UPDATE that flips status. Match the UPDATE that
    // also touches `status_history` (the bug fingerprint) — the helper
    // now writes status as $1 rather than the literal 'backlog', so we
    // identify the right UPDATE by its structural signature.
    const taskUpdate = fake.captured.find(
      q =>
        /UPDATE org_studio_tasks/i.test(q.sql) &&
        /SET\s+status\s*=\s*\$1/i.test(q.sql) &&
        /status_history/i.test(q.sql),
    );
    expect(taskUpdate, 'expected planning→backlog UPDATE on org_studio_tasks').toBeTruthy();

    // The $1 parameter value must be 'backlog' — the helper computes it.
    expect(taskUpdate!.values?.[0]).toBe('backlog');

    // PRIMARY REGRESSION GUARD: status_history must be touched in the same UPDATE.
    expect(
      taskUpdate!.sql,
      'status_history MUST be appended in the same UPDATE that flips typed status (#1531)',
    ).toMatch(/status_history/i);

    // Bonus: lastActivityAt should bump and loop counters should reset
    // (mirrors the route.ts behavior — keeps stalled-task detection accurate).
    expect(taskUpdate!.sql).toMatch(/last_activity_at/i);
    expect(taskUpdate!.sql).toMatch(/loop_count\s*=\s*0/i);

    // #1535 — claim lease must be cleared on transition OUT of in-progress.
    expect(taskUpdate!.sql).toMatch(/claim_started_at\s*=\s*NULL/i);
    expect(taskUpdate!.sql).toMatch(/claim_lease_expires_at\s*=\s*NULL/i);

    // And the result reports the move.
    expect(result.promoted).toBe(true);
    expect(result.movedTasks).toBe(1);
  });
});
