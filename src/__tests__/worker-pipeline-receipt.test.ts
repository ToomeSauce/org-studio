import { describe, expect, it } from 'vitest';
import {
  assembleWorkerPipelineReceipt,
  extractEvidenceLinks,
  normalizeReceiptStatusHistory,
} from '@/lib/worker-pipeline-receipt';

describe('worker pipeline receipt helpers (#1704)', () => {
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
