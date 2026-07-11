import { describe, expect, it, vi } from 'vitest';
import {
  PLANNER_RESULT_END,
  PLANNER_RESULT_START,
  buildPlannerInstructions,
  parsePlannerResult,
  persistPlannerChunks,
  renderPlannerSummary,
  validatePlannerOutput,
  type CreatedPlannerChunk,
} from '@/lib/workers/planner';
import type { WorkerRunResult } from '@/lib/workers/engine-codex';

const VALID = {
  chunks: [
    {
      key: 'schema',
      title: 'Add planner schema',
      description: 'Create the pure planner validator in src/lib/workers/planner.ts.',
      doneWhen: 'Targeted planner tests pass.',
      constraints: 'No external dependencies.',
      modelTier: 'standard',
      dependsOn: [],
    },
    {
      key: 'runtime',
      title: 'Wire planner runtime',
      description: 'Integrate validated planner output into WorkerRuntime.',
      doneWhen: 'Runtime test proves planning ticket materialization.',
      constraints: 'Never write repository files from planner jobs.',
      modelTier: 'complex',
      dependsOn: ['schema'],
    },
  ],
} as const;

function result(message: string, overrides: Partial<WorkerRunResult> = {}): WorkerRunResult {
  return {
    ok: true,
    exitCode: 0,
    durationMs: 100,
    commands: [],
    fileChanges: [],
    messages: [message],
    errors: [],
    usage: null,
    rawEventCount: 1,
    ...overrides,
  };
}

describe('#1691 planner output validation', () => {
  it('accepts a strict multi-chunk DAG and rejects unknown fields', () => {
    expect(validatePlannerOutput(VALID).chunks).toHaveLength(2);
    expect(() => validatePlannerOutput({ ...VALID, surprise: true })).toThrow('unknown field');
  });

  it('rejects too few chunks, invalid tiers, dangling dependencies, and cycles', () => {
    expect(() => validatePlannerOutput({ chunks: [VALID.chunks[0]] })).toThrow('2-12 chunks');
    expect(() =>
      validatePlannerOutput({
        chunks: [
          { ...VALID.chunks[0], modelTier: 'frontier' },
          VALID.chunks[1],
        ],
      }),
    ).toThrow('modelTier');
    expect(() =>
      validatePlannerOutput({
        chunks: [VALID.chunks[0], { ...VALID.chunks[1], dependsOn: ['missing'] }],
      }),
    ).toThrow("unknown key 'missing'");
    expect(() =>
      validatePlannerOutput({
        chunks: [
          { ...VALID.chunks[0], dependsOn: ['runtime'] },
          { ...VALID.chunks[1], dependsOn: ['schema'] },
        ],
      }),
    ).toThrow('dependency cycle');
  });

  it('parses only marked JSON and refuses code-writing output', () => {
    const message = `analysis\n${PLANNER_RESULT_START}\n${JSON.stringify(VALID)}\n${PLANNER_RESULT_END}`;
    expect(parsePlannerResult(result(message))).toEqual(VALID);
    expect(() => parsePlannerResult(result(JSON.stringify(VALID)))).toThrow('missing');
    expect(() =>
      parsePlannerResult(result(message, { fileChanges: [{ path: 'x.ts', kind: 'update' }] })),
    ).toThrow('read-only');
  });

  it('builds a frontier read-only brief with roadmap and vision context', () => {
    const brief = buildPlannerInstructions({
      projectId: 'p1',
      projectName: 'Org Studio',
      version: '2026.11.15',
      versionTitle: 'Autonomy',
      itemId: 'item-1',
      itemTitle: 'Planner job',
      visionExtract: '## North Star\nMake hard things easy.',
    });
    expect(brief).toContain('FRONTIER-tier');
    expect(brief).toContain('Planner job (item-1)');
    expect(brief).toContain('Make hard things easy.');
    expect(brief).toContain(PLANNER_RESULT_START);
    expect(brief).toContain('do not edit files');
  });
});

describe('#1691 planner materialization', () => {
  it('creates planning chunks, then wires blockedBy to allocated ticket numbers', async () => {
    let nextTicket = 1700;
    const stored: CreatedPlannerChunk[] = [];
    const updates = new Map<string, number[]>();
    const output = validatePlannerOutput(VALID);
    const chunks = await persistPlannerChunks({
      sourceTask: {
        id: 'source',
        ticketNumber: 1691,
        title: 'Planner',
        projectId: 'proj-org-studio',
        sectionId: 'sec-main',
        version: '2026.11.15',
        roadmapItemId: 'item-1',
        assignee: 'Mikey',
      },
      output,
      deps: {
        findExisting: vi.fn(async () => []),
        createChunk: vi.fn(async (input) => {
          expect(input.status).toBe('planning');
          expect(input.roadmapItemId).toBe('item-1');
          expect(input.version).toBe('2026.11.15');
          const task = {
            id: `task-${nextTicket}`,
            ticketNumber: nextTicket++,
            title: input.title,
            plannerChunkKey: input.plannerChunkKey,
            blockedBy: [],
          };
          stored.push(task);
          return task;
        }),
        updateChunk: vi.fn(async (id, patch) => {
          updates.set(id, patch.blockedBy);
        }),
        rollbackChunk: vi.fn(async () => undefined),
      },
    });
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.ticketNumber >= 1700)).toBe(true);
    expect(updates.get(chunks[1].id)).toEqual([chunks[0].ticketNumber]);
    expect(renderPlannerSummary({ id: 'source', ticketNumber: 1691, title: 'Planner' }, chunks))
      .toContain('All chunks are in **Planning**');
  });

  it('rolls back created chunks when a later write fails', async () => {
    const rollback = vi.fn(async () => undefined);
    let calls = 0;
    await expect(
      persistPlannerChunks({
        sourceTask: {
          id: 'source',
          title: 'Planner',
          projectId: 'p',
          version: 'v',
          roadmapItemId: 'i',
          assignee: 'Mikey',
        },
        output: validatePlannerOutput(VALID),
        deps: {
          findExisting: vi.fn(async () => []),
          createChunk: vi.fn(async (input) => {
            calls++;
            if (calls === 2) throw new Error('db down');
            return {
              id: 'first',
              ticketNumber: 1,
              title: input.title,
              plannerChunkKey: input.plannerChunkKey,
              blockedBy: [],
            };
          }),
          updateChunk: vi.fn(async () => undefined),
          rollbackChunk: rollback,
        },
      }),
    ).rejects.toThrow('db down');
    expect(rollback).toHaveBeenCalledWith('first');
  });
});
