import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  readMock,
  listCommentsMock,
  getStoreProviderMock,
} = vi.hoisted(() => {
  const read = vi.fn();
  const list = vi.fn();
  const getProvider = vi.fn(() => ({
    read,
    listComments: list,
  }));
  return {
    readMock: read,
    listCommentsMock: list,
    getStoreProviderMock: getProvider,
  };
});

vi.mock('@/lib/store-provider', () => ({
  getStoreProvider: getStoreProviderMock,
}));

import {
  __resetForTest,
  __setPoolForTest,
  assembleWorkerPipelineReceipt,
  extractEvidenceLinks,
  getWorkerPipelineReceipt,
  normalizeReceiptStatusHistory,
} from '@/lib/worker-pipeline-receipt';

describe('worker pipeline receipt helpers/read path (#1705)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetForTest();
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
        ticketNumber: 1705,
        id: 'task-1705',
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
    expect(receipt.attribution).toEqual({
      tokensIn: 0,
      tokensOut: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      modelHistory: [],
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
      attribution: {
        tokensIn: 0,
        tokensOut: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        modelHistory: [],
      },
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

  it('returns null for unknown ticket in workspace-scoped read path', async () => {
    readMock.mockResolvedValueOnce({
      tasks: [{ id: 't-1', ticketNumber: 11 }],
    });
    const pool = { query: vi.fn() };
    __setPoolForTest(pool);

    const receipt = await getWorkerPipelineReceipt('ws-1', 1705);

    expect(getStoreProviderMock).toHaveBeenCalledWith('ws-1');
    expect(receipt).toBeNull();
    expect(listCommentsMock).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('aggregates multi-call attribution deterministically with requested-only fallback and 6-decimal cost', async () => {
    readMock.mockResolvedValueOnce({
      tasks: [{
        id: 'task-1705',
        ticketNumber: 1705,
        plannerSourceTaskId: 'plan-1705',
        parentId: 'parent-1705',
        roadmapItemId: 'item-1705',
        projectId: 'proj-1',
        version: '2026.11.15',
        modelTier: 'complex',
        reviewNotes: 'PR https://github.com/org/studio/pull/1705',
        statusHistory: [
          { status: 'backlog', timestamp: 10, by: 'Planner', model: 'planner-model' },
          { status: 'in-progress', timestamp: 20, by: 'Worker' },
        ],
      }],
    });
    listCommentsMock.mockResolvedValueOnce([{
      id: 'c-1',
      author: 'Worker',
      content: 'Run https://github.com/org/studio/actions/runs/987',
      createdAt: 111,
    }]);

    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            model_used: 'gpt-5.3-codex',
            tokens_in: 1200,
            tokens_out: 300,
            cache_read_tokens: 800,
            cache_write_tokens: 40,
            cost_estimate: '0.1000004',
          },
          {
            model_used: 'gpt-5.4',
            tokens_in: 200,
            tokens_out: 50,
            cache_read_tokens: 100,
            cache_write_tokens: 10,
            cost_estimate: '0.2000004',
          },
          {
            model_used: 'gpt-5.3-codex',
            tokens_in: 300,
            tokens_out: 60,
            cache_read_tokens: 200,
            cache_write_tokens: 20,
            cost_estimate: null,
          },
          {
            model_used: 'gpt-5.5-mini',
            tokens_in: 10,
            tokens_out: 2,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            cost_estimate: '0.0000004',
          },
        ],
      }),
    };
    __setPoolForTest(pool);

    const receipt = await getWorkerPipelineReceipt('ws-1', 1705);
    const sql = String(pool.query.mock.calls[0][0]);

    expect(getStoreProviderMock).toHaveBeenCalledWith('ws-1');
    expect(listCommentsMock).toHaveBeenCalledWith({ kind: 'task', taskId: 'task-1705' }, { limit: 200 });
    expect(sql).toContain('COALESCE(mc.model_served, mc.model_requested)');
    expect(sql).toContain('l.workspace_id = $1');
    expect(sql).toContain('mc.workspace_id = $1');
    expect(receipt?.attribution).toEqual({
      tokensIn: 1710,
      tokensOut: 412,
      cacheReadTokens: 1100,
      cacheWriteTokens: 70,
      costUsd: 0.300001,
      modelHistory: ['gpt-5.3-codex', 'gpt-5.4', 'gpt-5.5-mini'],
    });
    expect(receipt?.modelHistory).toEqual(['gpt-5.3-codex', 'gpt-5.4', 'gpt-5.5-mini', 'planner-model']);
  });

  it('fails soft when comment lookup or ledger tables are unavailable', async () => {
    readMock.mockResolvedValueOnce({
      tasks: [{
        id: 'task-1705',
        ticketNumber: 1705,
        reviewNotes: null,
        comments: [{ id: 'fallback', author: 'A', content: 'fallback', createdAt: 1 }],
      }],
    });
    listCommentsMock.mockRejectedValueOnce(new Error('no comments table'));
    __setPoolForTest({
      query: vi.fn().mockRejectedValue({ code: '42P01' }),
    });

    const receipt = await getWorkerPipelineReceipt('ws-1', 1705);

    expect(receipt?.attribution).toEqual({
      tokensIn: 0,
      tokensOut: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      modelHistory: [],
    });
    expect(receipt?.evidenceLinks.workerRuns).toEqual([]);
  });
});
