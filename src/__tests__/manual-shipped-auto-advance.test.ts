import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:***@127.0.0.1:1/test_db';

const { promoteMock } = vi.hoisted(() => ({
  promoteMock: vi.fn(),
}));

vi.mock('../lib/project-state', () => ({
  promoteProjectToNextVersionLocked: promoteMock,
}));

import {
  advanceAfterShipment,
  advanceAfterShipmentLocked,
  checkAndAutoAdvance,
  syncProjectShadowVersion,
} from '../lib/roadmap-sync';

function makeClient(options?: {
  pointer?: string;
  sourceStatus?: string;
  owner?: string | null;
}) {
  const pointer = options?.pointer ?? '0.7.1';
  const sourceStatus = options?.sourceStatus ?? 'shipped';
  const owner = options?.owner === undefined ? 'Mikey' : options.owner;

  return {
    query: vi.fn(async (sql: string) => {
      if (/FROM org_studio_projects/i.test(sql)) {
        return {
          rows: [{
            data: {
              state: 'active',
              currentVersion: pointer,
              sections: [{ name: 'Product', role: 'dev', owner: 'Mikey' }],
            },
          }],
        };
      }
      if (/SELECT status FROM org_studio_roadmap_versions/i.test(sql)) {
        return { rows: [{ status: sourceStatus }] };
      }
      if (/SELECT owner FROM org_studio_roadmap_versions/i.test(sql)) {
        return { rows: [{ owner }] };
      }
      return { rows: [] };
    }),
  };
}

describe('syncProjectShadowVersion workspace isolation', () => {
  it('writes the same non-default workspace that it locked and read', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (/SELECT data FROM org_studio_projects/i.test(sql)) {
          return {
            rows: [{
              data: {
                sections: [{
                  id: 'main',
                  versions: [{ version: '0.7.1', status: 'current' }],
                }],
              },
            }],
          };
        }
        return { rows: [], rowCount: 1 };
      }),
    };

    const result = await syncProjectShadowVersion(
      client,
      'proj-outcome',
      'upsert',
      '0.7.1',
      { version: '0.7.1', status: 'shipped' },
      'workspace-a',
    );

    expect(result.touched).toBe(true);
    expect(client.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('workspace_id = $2'),
      ['proj-outcome', 'workspace-a'],
    );
    expect(client.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('workspace_id = $3'),
      [expect.any(String), 'proj-outcome', 'workspace-a'],
    );
  });
});

describe('advanceAfterShipment', () => {
  beforeEach(() => {
    promoteMock.mockReset();
    promoteMock.mockResolvedValue({
      promoted: true,
      from: '0.7.1',
      to: '0.7.2',
      movedTasks: 7,
    });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ settings: { teammates: [{ name: 'Mikey', agentId: 'mikey' }] } }),
      })
      .mockResolvedValueOnce({ ok: true }));
  });

  it('promotes a shipped pointer and wakes the effective owner immediately', async () => {
    const client = makeClient();

    const result = await advanceAfterShipment('proj-outcome', '0.7.1', client, 'workspace-a');

    expect(result).toMatchObject({ promoted: true, from: '0.7.1', to: '0.7.2', movedTasks: 7 });
    expect(promoteMock).toHaveBeenCalledWith('proj-outcome', client, { workspaceId: 'workspace-a' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch).toHaveBeenLastCalledWith(
      'http://localhost:4501/api/scheduler',
      expect.objectContaining({ body: JSON.stringify({ action: 'trigger', agentId: 'mikey' }) }),
    );
  });

  it('marks a just-written manual shipment for its post-commit effect', async () => {
    const client = makeClient();

    const outcome = await advanceAfterShipmentLocked(
      'proj-outcome',
      '0.7.1',
      client,
      'workspace-a',
      true,
    );

    expect(outcome.shipped).toEqual(expect.objectContaining({ version: '0.7.1' }));
    expect(outcome.shipped?.projectData.currentVersion).toBe('0.7.1');
  });

  it('is idempotent after the project pointer has already moved on', async () => {
    const client = makeClient({ pointer: '0.7.2' });

    const result = await advanceAfterShipment('proj-outcome', '0.7.1', client, 'workspace-a');

    expect(result.promoted).toBe(false);
    expect(result.reason).toBe('project already moved past 0.7.1');
    expect(promoteMock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not promote unless the canonical pointer row is shipped', async () => {
    const client = makeClient({ sourceStatus: 'current' });

    const result = await advanceAfterShipment('proj-outcome', '0.7.1', client, 'workspace-a');

    expect(result.promoted).toBe(false);
    expect(result.reason).toBe('currentVersion 0.7.1 is not shipped');
    expect(promoteMock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('repairs a shipped pointer before evaluating an already-current successor', async () => {
    const client = makeClient();

    await checkAndAutoAdvance('proj-outcome', client, 'workspace-a');

    expect(promoteMock).toHaveBeenCalledTimes(1);
    expect(promoteMock).toHaveBeenCalledWith('proj-outcome', client, { workspaceId: 'workspace-a' });
    const sql = client.query.mock.calls.map(([statement]) => String(statement));
    expect(sql.some((statement) => /status = 'current'/i.test(statement))).toBe(false);
  });
});
