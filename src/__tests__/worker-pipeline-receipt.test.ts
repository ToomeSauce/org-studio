import { beforeEach, describe, expect, it, vi } from 'vitest';

const getStoreProviderMock = vi.fn();
vi.mock('@/lib/store-provider', () => ({
  getStoreProvider: (...args: any[]) => getStoreProviderMock(...args),
}));

import {
  __resetWorkerPipelineReceiptForTest,
  __setWorkerPipelineReceiptPoolForTest,
  assembleWorkerPipelineReceipt,
  extractEvidenceLinks,
  getWorkerPipelineReceipt,
  normalizeReceiptStatusHistory,
} from '@/lib/worker-pipeline-receipt';

describe('worker pipeline receipt helpers (#1704)', () => {
  beforeEach(() => {
    getStoreProviderMock.mockReset();
    __resetWorkerPipelineReceiptForTest();
  });

  it('extracts PR + worker run links from reviewNotes/comments with dedupe and stable ordering', () => {
    const links = extractEvidenceLinks(
      [
        'Shipped via https://github.com/Org/Studio/pull/42#discussion.',
        'Run: https://github.com/org/studio/actions/runs/300/',
      ].join('\n'),
      [
        {
          id: 'c1',
          author: 'Worker',
          content: 'duplicate pr https://github.com/org/studio/pull/42 and run https://github.com/org/studio/actions/runs/200',
          createdAt: 100,
        },
        {
          id: 'c2',
          author: 'Worker',
          content: 'another run https://ci.example.com/job?run_id=1000)',
          createdAt: 101,
        },
      ],
    );

    expect(links).toEqual({
      workerRuns: [
        'https://ci.example.com/job?run_id=1000',
        'https://github.com/org/studio/actions/runs/200',
        'https://github.com/org/studio/actions/runs/300',
      ],
      pullRequests: [
        'https://github.com/org/studio/pull/42',
      ],
    });
  });

  it('normalizes statusHistory deterministically and derives status/model projections', () => {
    const receipt = assembleWorkerPipelineReceipt(
      {
        ticketNumber: 1704,
        id: 'task-1704',
        plannerSourceTaskId: 'plan-1',
        parentId: 'parent-1',
        roadmapItemId: 'item-1',
        projectId: 'proj-1',
        version: '2026.11.15',
        modelTier: 'complex',
        reviewNotes: null,
        statusHistory: [
          { status: ' Done ', timestamp: 30, by: 'Worker', model: 'gpt-5.3-codex' },
          { status: 'in-progress', timestamp: '20', by: 'Worker', model: 'gpt-5.3-codex' },
          { status: 'backlog', timestamp: 10, by: 'Planner' },
          { status: '', timestamp: 0 },
          { status: 'done', timestamp: null, by: 'Worker', model: 'gpt-5.4' },
        ],
      },
      [],
    );

    expect(receipt.statusHistory.map((x) => [x.status, x.timestamp])).toEqual([
      ['backlog', 10],
      ['in-progress', 20],
      ['done', 30],
      ['done', null],
    ]);
    expect(receipt.statusPath).toEqual(['backlog', 'in-progress', 'done']);
    expect(receipt.modelHistory).toEqual(['gpt-5.3-codex', 'gpt-5.4']);
    expect(receipt.modelTierSnapshot).toEqual({
      requested: 'complex',
      latestStatusModel: 'gpt-5.4',
    });
  });

  it('returns stable empty/null shapes for missing inputs', () => {
    const receipt = assembleWorkerPipelineReceipt(
      {
        ticketNumber: null,
        id: '  ',
        plannerSourceTaskId: undefined,
        parentId: undefined,
        roadmapItemId: undefined,
        projectId: undefined,
        version: undefined,
        modelTier: null,
        reviewNotes: '',
        statusHistory: null,
      },
      null,
    );

    expect(receipt).toEqual({
      ticketNumber: null,
      taskId: null,
      plannerSourceTaskId: null,
      parentId: null,
      roadmapItemId: null,
      projectId: null,
      version: null,
      statusHistory: [],
      statusPath: [],
      modelHistory: [],
      modelTierSnapshot: { requested: null, latestStatusModel: null },
      evidenceLinks: { workerRuns: [], pullRequests: [] },
      attributions: [],
    });
  });

  it('normalizes status history independently as a pure helper', () => {
    expect(
      normalizeReceiptStatusHistory([
        { status: 'done', timestamp: 3, by: 'A' },
        { status: 'backlog', timestamp: 1, by: 'A' },
        { status: 'in-progress', timestamp: 2, by: 'A' },
      ]),
    ).toEqual([
      { status: 'backlog', timestamp: 1, by: 'A', model: null },
      { status: 'in-progress', timestamp: 2, by: 'A', model: null },
      { status: 'done', timestamp: 3, by: 'A', model: null },
    ]);
  });
});

describe('getWorkerPipelineReceipt (#1705)', () => {
  beforeEach(() => {
    getStoreProviderMock.mockReset();
    __resetWorkerPipelineReceiptForTest();
  });

  it('returns null when the workspace-scoped ticket does not exist', async () => {
    getStoreProviderMock.mockReturnValue({
      read: vi.fn(async () => ({ tasks: [{ id: 'task-1', ticketNumber: 9 }] })),
      listComments: vi.fn(async () => []),
    });
    __setWorkerPipelineReceiptPoolForTest({ query: vi.fn(async () => ({ rows: [] })) });

    await expect(getWorkerPipelineReceipt('ws-1', 1705)).resolves.toBeNull();
  });

  it('uses scoped listComments and merges attributed model history from ledger rows', async () => {
    const listComments = vi.fn(async () => [
      {
        id: 'c1',
        author: 'Worker',
        content: 'PR https://github.com/org/studio/pull/1705',
        createdAt: 100,
      },
    ]);
    getStoreProviderMock.mockReturnValue({
      read: vi.fn(async () => ({
        tasks: [
          {
            id: 'task-1705',
            ticketNumber: 1705,
            modelTier: 'standard',
            reviewNotes: 'run https://github.com/org/studio/actions/runs/99',
            statusHistory: [
              { status: 'backlog', timestamp: 1, by: 'Planner' },
              { status: 'in-progress', timestamp: 2, by: 'Worker' },
              { status: 'done', timestamp: 3, by: 'Worker' },
            ],
          },
        ],
      })),
      listComments,
    });

    const query = vi.fn(async (_text: string, values: unknown[]) => {
      expect(values).toEqual(['ws-1705', 1705]);
      return {
        rows: [
          {
            dispatch_id: 'd1',
            dispatched_at: 2000,
            called_at: 2050,
            worker_id: 'worker-codex',
            source: 'worker',
            model_requested: 'gpt-5.3-codex',
            model_served: 'gpt-5.3-codex',
            model_used: 'gpt-5.3-codex',
            cost_estimate: '0.05',
          },
          {
            dispatch_id: 'd1',
            dispatched_at: 2000,
            called_at: 2100,
            worker_id: 'worker-codex',
            source: 'worker',
            model_requested: 'gpt-5.4',
            model_served: 'gpt-5.4',
            model_used: 'gpt-5.4',
            cost_estimate: '0.10',
          },
          {
            dispatch_id: 'd2',
            dispatched_at: 3000,
            called_at: null,
            worker_id: 'worker-codex',
            source: 'worker',
            model_requested: null,
            model_served: null,
            model_used: null,
            cost_estimate: null,
          },
        ],
      };
    });
    __setWorkerPipelineReceiptPoolForTest({ query });

    const receipt = await getWorkerPipelineReceipt('ws-1705', 1705);
    expect(listComments).toHaveBeenCalledWith({ kind: 'task', taskId: 'task-1705' }, { limit: 200 });
    expect(query).toHaveBeenCalledOnce();
    expect(receipt?.modelHistory).toEqual(['gpt-5.3-codex']);
    expect(receipt?.attributions).toEqual([
      {
        dispatchId: 'd1',
        dispatchedAt: 2000,
        calledAt: 2050,
        workerId: 'worker-codex',
        source: 'worker',
        modelRequested: 'gpt-5.3-codex',
        modelServed: 'gpt-5.3-codex',
        modelUsed: 'gpt-5.3-codex',
        costUsd: 0.15000000000000002,
      },
      {
        dispatchId: 'd2',
        dispatchedAt: 3000,
        calledAt: null,
        workerId: 'worker-codex',
        source: 'worker',
        modelRequested: null,
        modelServed: null,
        modelUsed: null,
        costUsd: null,
      },
    ]);
    expect(receipt?.evidenceLinks).toEqual({
      workerRuns: ['https://github.com/org/studio/actions/runs/99'],
      pullRequests: ['https://github.com/org/studio/pull/1705'],
    });
  });

  it('fails soft when listComments or ledger reads are unavailable', async () => {
    getStoreProviderMock.mockReturnValue({
      read: vi.fn(async () => ({
        tasks: [
          {
            id: 'task-1705',
            ticketNumber: 1705,
            reviewNotes: null,
            comments: [
              {
                id: 'inline-1',
                author: 'Worker',
                content: 'inline run https://ci.example.com/job?run_id=501',
                createdAt: 1,
              },
            ],
            statusHistory: [{ status: 'done', timestamp: 1 }],
          },
        ],
      })),
      listComments: vi.fn(async () => {
        throw new Error('comments table missing');
      }),
    });
    __setWorkerPipelineReceiptPoolForTest({
      query: vi.fn(async () => {
        throw new Error('dispatch tables missing');
      }),
    });

    const receipt = await getWorkerPipelineReceipt('ws-1705', 1705);
    expect(receipt).toBeTruthy();
    expect(receipt?.attributions).toEqual([]);
    expect(receipt?.evidenceLinks.workerRuns).toEqual(['https://ci.example.com/job?run_id=501']);
  });
});
