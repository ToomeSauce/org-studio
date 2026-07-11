import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreProvider } from '@/lib/store-provider';
import {
  __resetForTest,
  __setPoolForTest,
  __setStoreProviderGetterForTest,
  assembleWorkerPipelineReceipt,
  extractEvidenceLinks,
  getWorkerPipelineReceipt,
  normalizeReceiptStatusHistory,
} from '@/lib/worker-pipeline-receipt';

describe('worker pipeline receipt helpers (#1704)', () => {
  beforeEach(() => {
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

  it('reads a workspace-scoped receipt and aggregates multi-call attribution deterministically', async () => {
    const provider: Pick<StoreProvider, 'read' | 'listComments'> = {
      read: vi.fn(async () => ({
        tasks: [{
          id: 'task-1705',
          ticketNumber: 1705,
          projectId: 'proj-1',
          statusHistory: [{ status: 'done', timestamp: 10, model: 'gpt-5.3-codex' }],
          reviewNotes: 'done',
        }],
      })),
      listComments: vi.fn(async () => [{ id: 'c1', author: 'Worker', content: 'ok', createdAt: 1 }]),
    };
    __setStoreProviderGetterForTest(() => provider);
    __setPoolForTest({
      query: vi.fn(async () => ({
        rows: [
          {
            model_served: 'claude-opus-4.8',
            tokens_in: '100',
            tokens_out: 10,
            cache_read_tokens: 50,
            cache_write_tokens: 5,
            cost_estimate: '0.1111114',
          },
          {
            model_served: 'gpt-4.1-mini',
            tokens_in: 200,
            tokens_out: '20',
            cache_read_tokens: '0',
            cache_write_tokens: 2,
            cost_estimate: '0.2222225',
          },
          {
            model_served: 'claude-opus-4.8',
            tokens_in: 3,
            tokens_out: 4,
            cache_read_tokens: 1,
            cache_write_tokens: 0,
            cost_estimate: '0.0000004',
          },
        ],
      })),
    });

    const receipt = await getWorkerPipelineReceipt('ws-1', 1705);

    expect(provider.listComments).toHaveBeenCalledWith({ kind: 'task', taskId: 'task-1705' }, { limit: 200 });
    expect(receipt).not.toBeNull();
    expect(receipt!.attribution).toEqual({
      tokensIn: 303,
      tokensOut: 34,
      cacheReadTokens: 51,
      cacheWriteTokens: 7,
      costUsd: 0.333334,
      modelHistory: ['claude-opus-4.8', 'gpt-4.1-mini'],
    });
    expect(receipt!.modelHistory).toEqual([
      'gpt-5.3-codex',
      'claude-opus-4.8',
      'gpt-4.1-mini',
    ]);
  });

  it('returns null when ticket is unknown and fails soft when comments/ledger are unavailable', async () => {
    const provider: Pick<StoreProvider, 'read' | 'listComments'> = {
      read: vi.fn(async () => ({
        tasks: [{
          id: 'task-1706',
          ticketNumber: 1706,
          comments: [{ id: 'inline', author: 'W', content: 'inline comment', createdAt: 1 }],
          statusHistory: [],
        }],
      })),
      listComments: vi.fn(async () => { throw new Error('comment read failed'); }),
    };
    __setStoreProviderGetterForTest(() => provider);
    __setPoolForTest({
      query: vi.fn(async () => {
        const err: Error & { code?: string } = new Error('relation missing');
        err.code = '42P01';
        throw err;
      }),
    });

    await expect(getWorkerPipelineReceipt('ws-1', 9999)).resolves.toBeNull();

    const receipt = await getWorkerPipelineReceipt('ws-1', 1706);
    expect(receipt).not.toBeNull();
    expect(receipt!.evidenceLinks).toEqual({ workerRuns: [], pullRequests: [] });
    expect(receipt!.attribution).toEqual({
      tokensIn: 0,
      tokensOut: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      modelHistory: [],
    });
  });
});
