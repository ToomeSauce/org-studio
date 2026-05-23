/**
 * #1534 — unit coverage for PostgresStoreProvider.getTasksForAgent().
 *
 * No live DB. We stub the provider's underlying pool/client and capture
 * every query. The point is: assert the SQL shape (workspace filter,
 * lower(assignee) IN matcher, isArchived exclusion, created_at ORDER BY)
 * and assert the row-reconstruction matches a full-read row.
 *
 * The parity script (scripts/dispatch-parity-1534.ts) is the end-to-end
 * proof; this unit test is the fast feedback loop on the SQL itself.
 */

import { describe, it, expect, vi } from 'vitest';
import { PostgresStoreProvider } from '../lib/store-provider';

type Captured = { sql: string; params: any[] };

function makeFakeProvider(canned: any[]) {
  const captured: Captured[] = [];
  const fakeClient = {
    query: vi.fn(async (sql: string, params: any[]) => {
      captured.push({ sql, params });
      return { rows: canned };
    }),
    release: vi.fn(),
  };
  const fakePool = {
    connect: vi.fn(async () => fakeClient),
  };
  const provider = new PostgresStoreProvider('postgres://stub', 'default-workspace');
  // Inject the fake pool via the private getPool() path.
  (provider as any).pool = fakePool;
  (provider as any).getPool = async () => fakePool;
  return { provider, captured };
}

describe('#1534 — PostgresStoreProvider.getTasksForAgent()', () => {
  it('filters by workspace + lower(assignee) IN matcher + excludes archived', async () => {
    const { provider, captured } = makeFakeProvider([]);
    await (provider as any).getTasksForAgent('Mikey', 'mikey');

    expect(captured).toHaveLength(1);
    const q = captured[0];

    // workspace_id filter
    expect(q.sql).toMatch(/workspace_id\s*=\s*\$1/i);
    expect(q.params[0]).toBe('default-workspace');

    // lower(assignee) IN matcher
    expect(q.sql).toMatch(/lower\(assignee\)\s+IN\s*\(\s*\$2\s*,\s*\$3\s*\)/i);

    // Matcher values must be lowercased (case-insensitive task assignees).
    expect(q.params[1]).toBe('mikey'); // lowercased name
    expect(q.params[2]).toBe('mikey'); // lowercased id

    // isArchived exclusion — null-safe form, NOT TRUE matches the slim convention.
    expect(q.sql).toMatch(/isArchived'\)::boolean\s+IS\s+NOT\s+TRUE/i);

    // ORDER BY created_at — matches read()/readSlim() iteration order.
    expect(q.sql).toMatch(/ORDER BY\s+created_at/i);
  });

  it('matchers preserve case-folding when name differs from id', async () => {
    const { provider, captured } = makeFakeProvider([]);
    await (provider as any).getTasksForAgent('Mikey', 'mikey-prod-7');

    const p = captured[0].params;
    expect(p[1]).toBe('mikey');
    expect(p[2]).toBe('mikey-prod-7');
  });

  it('returns reconstructed row objects (not raw pg rows)', async () => {
    const cannedRow = {
      id: 't1',
      ticket_number: 1534,
      title: 'Slim fireOneShot',
      status: 'in-progress',
      project_id: 'proj-mc',
      assignee: 'Mikey',
      version: '0.18.0',
      sort_order: 1,
      loop_count: 0,
      loop_paused_at: null,
      last_activity_at: 1700000000000,
      created_at: 1699000000000,
      status_history: [],
      workspace_id: 'default-workspace',
      // typed columns the helper reconstructs (per TASK_COLUMNS)
      description: 'fast',
      done_when: 'p95<250ms',
      // anything else lives in the data JSONB overflow
      data: { sectionId: 'sec1' },
    };
    const { provider } = makeFakeProvider([cannedRow]);
    const rows = await (provider as any).getTasksForAgent('Mikey', 'mikey');

    expect(rows).toHaveLength(1);
    const t = rows[0];
    // Typed columns flattened to camelCase
    expect(t.id).toBe('t1');
    expect(t.ticketNumber).toBe(1534);
    expect(t.status).toBe('in-progress');
    expect(t.projectId).toBe('proj-mc');
    expect(t.assignee).toBe('Mikey');
    // data JSONB overflow merged onto the row
    expect(t.sectionId).toBe('sec1');
    expect(t.description).toBe('fast');
    expect(t.doneWhen).toBe('p95<250ms');
  });

  it('returns empty array when agent has no tasks', async () => {
    const { provider } = makeFakeProvider([]);
    const rows = await (provider as any).getTasksForAgent('Nobody', 'nobody');
    expect(rows).toEqual([]);
  });

  it('SELECT excludes the comments column (slim-via-#1520 convention)', async () => {
    const { provider, captured } = makeFakeProvider([]);
    await (provider as any).getTasksForAgent('Mikey', 'mikey');
    // SELECT clause should not include `comments` as a typed column.
    // (comments are fetched separately from org_studio_comments per #1524.)
    const selectClause = captured[0].sql.split(/FROM/i)[0];
    expect(selectClause).not.toMatch(/[\s,]comments\b/i);
  });
});
