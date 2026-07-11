/**
 * Tests for the Execution Workers lane gate + engine event parsing
 * (#1657, W-2). Event fixtures mirror the real codex-cli 0.142.5 stream
 * captured in the W-1 spike (#1656).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { checkLane, getWorkerConfigs, workersEnabled, DEFAULT_WORKERS } from '@/lib/workers/config';
import { parseEngineEvents, type WorkerRunResult } from '@/lib/workers/engine-codex';
import { WorkerRuntime } from '@/lib/workers/worker-runtime';
import {
  assembleBrief,
  generateWorkerAgentsMd,
  extractAttemptSummary,
  renderStructuredCloseout,
  GENERATED_AGENTS_MD_MARKER,
} from '@/lib/workers/context-assembler';

const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined) {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
});

describe('#1657: worker config gating', () => {
  it('workers disabled by default', () => {
    setEnv('WORKER_RUNTIME_ENABLED', undefined);
    expect(workersEnabled()).toBe(false);
    expect(getWorkerConfigs()).toEqual([]);
  });

  it('defaults apply when enabled without explicit config', () => {
    setEnv('WORKER_RUNTIME_ENABLED', 'true');
    setEnv('WORKER_RUNTIME_CONFIG', undefined);
    const ws = getWorkerConfigs();
    expect(ws).toHaveLength(1);
    expect(ws[0].id).toBe('worker-codex');
    expect(ws[0].lane.taskTypes).toEqual(['chore', 'bug']);
    expect(ws[0].tiers).toEqual(['trivial', 'standard', 'complex']);
  });

  it('invalid JSON config falls back to defaults', () => {
    setEnv('WORKER_RUNTIME_ENABLED', 'true');
    setEnv('WORKER_RUNTIME_CONFIG', '{nope');
    expect(getWorkerConfigs()).toEqual(DEFAULT_WORKERS);
  });

  it('custom config parses and rejects non-worker ids', () => {
    setEnv('WORKER_RUNTIME_ENABLED', 'true');
    setEnv(
      'WORKER_RUNTIME_CONFIG',
      JSON.stringify([
        { id: 'worker-x', model: 'm1', lane: { taskTypes: ['BUG'], projectIds: ['p1'] } },
        { id: 'mikey', model: 'nope' }, // must be filtered — not a worker- id
      ]),
    );
    const ws = getWorkerConfigs();
    expect(ws).toHaveLength(1);
    expect(ws[0].id).toBe('worker-x');
    expect(ws[0].lane.taskTypes).toEqual(['bug']); // lowercased
    expect(ws[0].lane.projectIds).toEqual(['p1']);
    expect(ws[0].tiers).toEqual(['trivial', 'standard', 'complex']); // default when omitted
  });

  it('parses explicit tiers and drops invalid entries', () => {
    setEnv('WORKER_RUNTIME_ENABLED', 'true');
    setEnv(
      'WORKER_RUNTIME_CONFIG',
      JSON.stringify([
        {
          id: 'worker-x',
          model: 'm1',
          tiers: ['Trivial', 'standard', 'nope', null],
          lane: { taskTypes: [], projectIds: [] },
        },
      ]),
    );
    const ws = getWorkerConfigs();
    expect(ws).toHaveLength(1);
    expect(ws[0].tiers).toEqual(['trivial', 'standard']);
  });
});

describe('#1657: lane gate', () => {
  const worker = {
    ...DEFAULT_WORKERS[0],
    lane: { taskTypes: ['chore', 'bug'], projectIds: ['proj-oss'] },
  };

  it('allows in-lane tasks', () => {
    expect(
      checkLane(worker, { ticketNumber: 1, taskType: 'bug', projectId: 'proj-oss' }).ok,
    ).toBe(true);
    expect(
      checkLane(worker, { ticketNumber: 2, taskType: 'CHORE', projectId: 'proj-oss' }).ok,
    ).toBe(true); // case-insensitive
  });

  it('refuses out-of-lane taskType with a reason', () => {
    const r = checkLane(worker, { ticketNumber: 3, taskType: 'feature', projectId: 'proj-oss' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('outside');
  });

  it('refuses out-of-lane project', () => {
    const r = checkLane(worker, { ticketNumber: 4, taskType: 'bug', projectId: 'proj-prod' });
    expect(r.ok).toBe(false);
  });

  it('empty lane lists allow everything', () => {
    const open = { ...worker, lane: { taskTypes: [], projectIds: [] } };
    expect(checkLane(open, { taskType: 'anything', projectId: 'anywhere' }).ok).toBe(true);
  });

  it('missing taskType refused when lane restricts types', () => {
    expect(checkLane(worker, { projectId: 'proj-oss' }).ok).toBe(false);
  });
});

describe('#1657: engine event-stream parsing (W-1 verified schema)', () => {
  const fixture = [
    JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'i0', type: 'error', message: 'Skill descriptions were shortened' },
    }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'i1', type: 'agent_message', text: 'Inspecting files.' },
    }),
    JSON.stringify({
      type: 'item.started',
      item: { id: 'i2', type: 'command_execution', command: 'ls', exit_code: null },
    }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'i2', type: 'command_execution', command: 'ls', exit_code: 0 },
    }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'i3', type: 'file_change', changes: [{ path: '/x/greet.py', kind: 'update' }] },
    }),
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 61012, cached_input_tokens: 54016, output_tokens: 407, reasoning_output_tokens: 57 },
    }),
  ].join('\n');

  it('extracts commands, file changes, messages, usage', () => {
    const p = parseEngineEvents(fixture);
    expect(p.commands).toEqual([{ command: 'ls', exitCode: 0 }]); // item.started ignored
    expect(p.fileChanges).toEqual([{ path: '/x/greet.py', kind: 'update' }]);
    expect(p.messages).toEqual(['Inspecting files.']);
    expect(p.usage).toEqual({
      inputTokens: 61012,
      cachedInputTokens: 54016,
      outputTokens: 407,
      reasoningOutputTokens: 57,
    });
    expect(p.rawEventCount).toBe(8);
  });

  it('records advisory error items without failing (W-1 finding)', () => {
    const p = parseEngineEvents(fixture);
    expect(p.errors).toEqual(['Skill descriptions were shortened']);
  });

  it('tolerates non-JSON noise and empty input', () => {
    expect(parseEngineEvents('not json\n\n{broken').rawEventCount).toBe(0);
    const p = parseEngineEvents('');
    expect(p.commands).toEqual([]);
    expect(p.usage).toBeNull();
  });
});

describe('#1657: WorkerRuntime send() = enqueue semantics', () => {
  const OK_RESULT: WorkerRunResult = {
    ok: true,
    exitCode: 0,
    durationMs: 1234,
    commands: [{ command: 'ls', exitCode: 0 }],
    fileChanges: [{ path: 'a.ts', kind: 'update' }],
    messages: ['done'],
    errors: [],
    usage: { inputTokens: 10, cachedInputTokens: 5, outputTokens: 3, reasoningOutputTokens: 1 },
    rawEventCount: 4,
  };

  function makeStore(taskOverrides: Record<string, any> = {}) {
    return {
      tasks: [
        {
          id: 'task-1',
          ticketNumber: 42,
          title: 'Fix the thing',
          status: 'backlog',
          assignee: 'worker-codex',
          taskType: 'bug',
          projectId: 'proj-oss',
          sortOrder: 1,
          ...taskOverrides,
        },
      ],
    };
  }

  function makeRuntime(overrides: Record<string, any> = {}) {
    const deps = {
      fetchStore: vi.fn(async () => makeStore()),
      postComment: vi.fn(async () => undefined),
      fetchComments: vi.fn(async () => []),
      fetchVision: vi.fn(async () => ''),
      materializePlan: vi.fn(async () => []),
      writeAgentsMd: vi.fn(async () => vi.fn(async () => undefined)),
      runEngine: vi.fn(async () => OK_RESULT),
      runRemote: vi.fn(async () => ({ ok: false, mode: 'gh-actions', detail: 'not configured' })),
      updateTask: vi.fn(async () => undefined),
      recordDispatch: vi.fn(),
      recordModelCall: vi.fn(),
      ...overrides,
    };
    return { rt: new WorkerRuntime(deps), deps };
  }

  function enableWorkers(lane = { taskTypes: ['chore', 'bug'], projectIds: [] as string[] }) {
    setEnv('WORKER_RUNTIME_ENABLED', 'true');
    setEnv(
      'WORKER_RUNTIME_CONFIG',
      JSON.stringify([
        { id: 'worker-codex', name: 'Worker (Codex)', engine: 'codex', model: 'm', lane, timeoutMs: 5000 },
      ]),
    );
    setEnv('WORKER_REPO_PATHS', JSON.stringify({ 'proj-oss': '/tmp' })); // /tmp exists everywhere
  }

  it('returns immediately with enqueued:true — does NOT await the engine', async () => {
    enableWorkers();
    let resolveEngine!: (r: WorkerRunResult) => void;
    const enginePromise = new Promise<WorkerRunResult>((res) => (resolveEngine = res));
    const { rt, deps } = makeRuntime({ runEngine: vi.fn(() => enginePromise) });

    const out = (await rt.send('worker-codex', 'brief', { idempotencyKey: 'd1' })) as any;
    expect(out.enqueued).toBe(true);
    expect(out.dispatchId).toBe('d1');
    expect(out.ticketNumber).toBe(42);
    // Engine still running; ledger dispatch row recorded at enqueue time.
    expect(deps.recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ dispatchId: 'd1', outcome: 'enqueued', ticketFingerprint: '42:backlog' }),
    );
    expect(deps.recordModelCall).not.toHaveBeenCalled();

    resolveEngine(OK_RESULT);
    await new Promise((r) => setTimeout(r, 0)); // let the background job flush
    expect(deps.recordModelCall).toHaveBeenCalledWith(
      expect.objectContaining({ dispatchId: 'd1', tokensIn: 10, tokensOut: 3 }),
    );
    expect(deps.postComment).toHaveBeenCalled(); // closeout landed
  });

  it('fires onComplete when the background job finishes', async () => {
    enableWorkers();
    const { rt } = makeRuntime();
    const onComplete = vi.fn();
    await rt.send('worker-codex', 'brief', { onComplete });
    expect(onComplete).not.toHaveBeenCalled(); // not yet — enqueue returned first
    await new Promise((r) => setTimeout(r, 0));
    expect(onComplete).toHaveBeenCalledWith('worker-codex');
  });

  it('refuses a second dispatch while a job is in flight (single-flight)', async () => {
    enableWorkers();
    let resolveEngine!: (r: WorkerRunResult) => void;
    const enginePromise = new Promise<WorkerRunResult>((res) => (resolveEngine = res));
    const { rt } = makeRuntime({ runEngine: vi.fn(() => enginePromise) });

    await rt.send('worker-codex', 'brief', { idempotencyKey: 'd1' });
    await expect(rt.send('worker-codex', 'brief', { idempotencyKey: 'd2' })).rejects.toThrow(
      /in flight/,
    );
    resolveEngine(OK_RESULT);
    await new Promise((r) => setTimeout(r, 0));
    // Slot freed after completion — next dispatch enqueues fine.
    const out = (await rt.send('worker-codex', 'brief', { idempotencyKey: 'd3' })) as any;
    expect(out.enqueued).toBe(true);
  });

  it('lane refusal throws + posts a ⛔ comment, nothing enqueued', async () => {
    enableWorkers({ taskTypes: ['chore'], projectIds: [] }); // bug task is out of lane
    const { rt, deps } = makeRuntime();
    await expect(rt.send('worker-codex', 'brief')).rejects.toThrow(/outside/);
    expect(deps.postComment).toHaveBeenCalledWith(
      'task-1',
      'worker-codex',
      expect.stringContaining('⛔ Lane refusal'),
    );
    expect(deps.runEngine).not.toHaveBeenCalled();
    expect(deps.recordDispatch).not.toHaveBeenCalled();
  });

  it('missing repo checkout throws + posts a ⛔ comment', async () => {
    enableWorkers();
    setEnv('WORKER_REPO_PATHS', '{}');
    const { rt, deps } = makeRuntime();
    await expect(rt.send('worker-codex', 'brief')).rejects.toThrow(/No repo checkout/);
    expect(deps.runEngine).not.toHaveBeenCalled();
  });

  describe('gh-actions mode', () => {
    function enableGhActionsWorkers(lane = { taskTypes: ['chore', 'bug'], projectIds: [] as string[] }) {
      setEnv('WORKER_RUNTIME_ENABLED', 'true');
      setEnv(
        'WORKER_RUNTIME_CONFIG',
        JSON.stringify([
          {
            id: 'worker-codex',
            name: 'Worker (Codex)',
            engine: 'codex',
            model: 'gpt-5.3-codex',
            mode: 'gh-actions',
            lane,
            timeoutMs: 5000,
          },
        ]),
      );
    }

    it('enqueues, skips local engine/AGENTS writes, and posts PR closeout with usage', async () => {
      enableGhActionsWorkers();
      vi.stubEnv('WORKER_REPO_SLUGS', JSON.stringify({ 'proj-oss': 'x/y' }));

      const runRemote = vi.fn(async () => ({
        ok: true,
        mode: 'gh-actions',
        detail: 'run success',
        prUrl: 'https://github.com/x/y/pull/1',
        usage: {
          inputTokens: 100,
          cachedInputTokens: 0,
          outputTokens: 50,
          reasoningOutputTokens: 0,
        },
      }));

      const { rt, deps } = makeRuntime({ runRemote });
      const out = (await rt.send('worker-codex', 'brief', { idempotencyKey: 'd-remote' })) as any;
      expect(out.enqueued).toBe(true);
      expect(out.dispatchId).toBe('d-remote');

      await new Promise((r) => setTimeout(r, 0));
      expect(deps.runEngine).not.toHaveBeenCalled();
      expect(deps.writeAgentsMd).not.toHaveBeenCalled();
      expect(runRemote).toHaveBeenCalledWith(
        expect.objectContaining({ repo: 'x/y', ticketNumber: 42, model: 'gpt-5.3-codex' }),
        expect.objectContaining({ mode: 'gh-actions' }),
      );
      expect(deps.recordModelCall).toHaveBeenCalledWith(
        expect.objectContaining({ dispatchId: 'd-remote', tokensIn: 100, tokensOut: 50 }),
      );
      const closeout = (deps.postComment as any).mock.calls[0][2] as string;
      expect(closeout).toContain('gh-actions runner');
      expect(closeout).toContain('https://github.com/x/y/pull/1');
      // #1661 results loop: success + PR → ticket moves to done (PR = merge gate)
      expect(deps.updateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ status: 'done', reviewNotes: expect.stringContaining('pull/1') }),
      );
    });

    it('#1661: failed run below attempt cap leaves ticket alone (sweep retries)', async () => {
      enableGhActionsWorkers();
      vi.stubEnv('WORKER_REPO_SLUGS', JSON.stringify({ 'proj-oss': 'x/y' }));
      const runRemote = vi.fn(async () => ({ ok: false, mode: 'gh-actions', detail: 'run failure' }));
      const { rt, deps } = makeRuntime({ runRemote }); // 0 prior attempts in thread
      await rt.send('worker-codex', 'brief', { idempotencyKey: 'd-fail1' });
      await new Promise((r) => setTimeout(r, 0));
      expect(deps.updateTask).not.toHaveBeenCalled();
    });

    it('#1661: failure at attempt cap escalates to blocked/needs-human-judgment', async () => {
      enableGhActionsWorkers();
      vi.stubEnv('WORKER_REPO_SLUGS', JSON.stringify({ 'proj-oss': 'x/y' }));
      const runRemote = vi.fn(async () => ({ ok: false, mode: 'gh-actions', detail: 'run failure' }));
      const priorFailures = [
        { author: 'worker-codex', content: '🤖 **Worker run** `a` — ❌ failed on gh-actions runner', createdAt: 1 },
        { author: 'worker-codex', content: '🤖 **Worker run** `b` — ❌ failed on gh-actions runner', createdAt: 2 },
      ];
      const { rt, deps } = makeRuntime({
        runRemote,
        fetchComments: vi.fn(async () => priorFailures),
      });
      await rt.send('worker-codex', 'brief', { idempotencyKey: 'd-fail3' });
      await new Promise((r) => setTimeout(r, 0));
      // 2 prior + this one = 3 = default WORKER_MAX_ATTEMPTS
      expect(deps.updateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ status: 'blocked', blockedReasonType: 'needs-human-judgment' }),
      );
    });

    it('missing WORKER_REPO_SLUGS entry posts ⛔ and throws', async () => {
      enableGhActionsWorkers();
      vi.stubEnv('WORKER_REPO_SLUGS', '{}');
      const { rt, deps } = makeRuntime();
      await expect(rt.send('worker-codex', 'brief')).rejects.toThrow(/No repo slug configured/);
      expect(deps.postComment).toHaveBeenCalledWith(
        'task-1',
        'worker-codex',
        expect.stringContaining('⛔ No repo slug configured'),
      );
      expect(deps.runRemote).not.toHaveBeenCalled();
    });
  });

  it('no actionable work → skipped, no throw', async () => {
    enableWorkers();
    const { rt } = makeRuntime({ fetchStore: vi.fn(async () => ({ tasks: [] })) });
    const out = (await rt.send('worker-codex', 'brief')) as any;
    expect(out.skipped).toBe('no actionable work');
  });

  it('unknown worker id throws', async () => {
    enableWorkers();
    const { rt } = makeRuntime();
    await expect(rt.send('worker-nope', 'brief')).rejects.toThrow(/Unknown worker/);
  });

  it('engine failure posts honest failure closeout and frees the slot', async () => {
    enableWorkers();
    const { rt, deps } = makeRuntime({
      runEngine: vi.fn(async () => {
        throw new Error('codex spawn failed: ENOENT');
      }),
    });
    const onComplete = vi.fn();
    await rt.send('worker-codex', 'brief', { onComplete });
    await new Promise((r) => setTimeout(r, 0));
    expect(deps.postComment).toHaveBeenCalledWith(
      'task-1',
      'worker-codex',
      expect.stringContaining('failed to start'),
    );
    expect(onComplete).toHaveBeenCalledWith('worker-codex'); // completion still fires
    // Slot freed — subsequent dispatch enqueues.
    const out = (await rt.send('worker-codex', 'brief')) as any;
    expect(out.enqueued).toBe(true);
  });

  it('#1691: rejects plan jobs on a worker not marked FRONTIER', async () => {
    enableWorkers({ taskTypes: ['feature'], projectIds: [] });
    const { rt, deps } = makeRuntime({
      fetchStore: vi.fn(async () =>
        makeStore({ jobKind: 'plan', taskType: 'feature' }),
      ),
    });
    await expect(rt.send('worker-codex', 'brief')).rejects.toThrow('FRONTIER-tier');
    expect(deps.runEngine).not.toHaveBeenCalled();
  });

  it('#1691: plan job builds read-only frontier brief and materializes validated chunks', async () => {
    setEnv('WORKER_RUNTIME_ENABLED', 'true');
    setEnv(
      'WORKER_RUNTIME_CONFIG',
      JSON.stringify([
        {
          id: 'worker-codex',
          name: 'Worker (Codex)',
          engine: 'codex',
          model: 'frontier-model',
          mode: 'local-process',
          frontier: true,
          lane: { taskTypes: ['feature'], projectIds: ['proj-oss'] },
          timeoutMs: 5000,
        },
      ]),
    );
    setEnv('WORKER_REPO_PATHS', JSON.stringify({ 'proj-oss': '/tmp' }));
    const plannerJson = {
      chunks: [
        {
          key: 'one', title: 'Chunk one', description: 'Implement one.', doneWhen: 'One passes.',
          constraints: 'Scoped.', modelTier: 'standard', dependsOn: [],
        },
        {
          key: 'two', title: 'Chunk two', description: 'Implement two.', doneWhen: 'Two passes.',
          constraints: 'Scoped.', modelTier: 'complex', dependsOn: ['one'],
        },
      ],
    };
    let captured: any;
    const materialized = [
      { id: 'c1', ticketNumber: 1700, title: 'Chunk one', plannerChunkKey: 'one', blockedBy: [] },
      { id: 'c2', ticketNumber: 1701, title: 'Chunk two', plannerChunkKey: 'two', blockedBy: [1700] },
    ];
    const fetchStore = vi.fn(async () => ({
      ...makeStore({
        jobKind: 'plan', taskType: 'feature', version: '2026.11.15', roadmapItemId: 'item-plan',
      }),
      projects: [{
        id: 'proj-oss',
        name: 'OSS',
        repoContextPack: 'repo map',
        sections: [{ versions: [{ version: '2026.11.15', title: 'Plan', items: [{ id: 'item-plan', title: 'Roadmap outcome' }] }] }],
      }],
    }));
    const { rt, deps } = makeRuntime({
      fetchStore,
      fetchVision: vi.fn(async () => '## North Star\nUseful software.'),
      runEngine: vi.fn(async (opts: any) => {
        captured = opts;
        return {
          ...OK_RESULT,
          fileChanges: [],
          messages: [`ORG_STUDIO_PLAN_JSON_START\n${JSON.stringify(plannerJson)}\nORG_STUDIO_PLAN_JSON_END`],
        };
      }),
      materializePlan: vi.fn(async () => materialized),
    });
    await rt.send('worker-codex', 'DISPATCH', { idempotencyKey: 'plan-1' });
    await new Promise((r) => setTimeout(r, 0));
    expect(captured.sandboxMode).toBe('read-only');
    expect(captured.brief).toContain('FRONTIER-tier');
    expect(captured.brief).toContain('Useful software.');
    expect(captured.brief).toContain('repo map');
    expect(captured.brief).toContain('do NOT edit files');
    expect(deps.writeAgentsMd).not.toHaveBeenCalled();
    expect(deps.materializePlan).toHaveBeenCalledWith('task-1', plannerJson, 'worker-codex');
    expect(deps.postComment).toHaveBeenCalledWith(
      'task-1',
      'worker-codex',
      expect.stringContaining('#1701'),
    );
    expect(deps.updateTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ status: 'done' }),
    );
  });

  it('#1691: remote plan jobs use artifact-only workflow output and never invoke local engine', async () => {
    setEnv('WORKER_RUNTIME_ENABLED', 'true');
    setEnv(
      'WORKER_RUNTIME_CONFIG',
      JSON.stringify([{ id: 'worker-codex', name: 'Worker', engine: 'codex', model: 'frontier-model', mode: 'gh-actions', frontier: true, lane: { taskTypes: ['feature'], projectIds: [] }, timeoutMs: 5000 }]),
    );
    setEnv('WORKER_REPO_SLUGS', JSON.stringify({ 'proj-oss': 'ToomeSauce/org-studio' }));
    const output = {
      chunks: [
        { key: 'one', title: 'One', description: 'One.', doneWhen: 'One.', constraints: 'Scoped.', modelTier: 'standard', dependsOn: [] },
        { key: 'two', title: 'Two', description: 'Two.', doneWhen: 'Two.', constraints: 'Scoped.', modelTier: 'complex', dependsOn: ['one'] },
      ],
    };
    const { rt, deps } = makeRuntime({
      fetchStore: vi.fn(async () => ({
        ...makeStore({ jobKind: 'plan', taskType: 'feature', version: 'v1', roadmapItemId: 'i1' }),
        projects: [{ id: 'proj-oss', sections: [{ versions: [{ version: 'v1', items: [{ id: 'i1', title: 'Item' }] }] }] }],
      })),
      runRemote: vi.fn(async () => ({
        ok: true,
        mode: 'gh-actions',
        detail: 'run success',
        messages: [`ORG_STUDIO_PLAN_JSON_START\n${JSON.stringify(output)}\nORG_STUDIO_PLAN_JSON_END`],
      })),
      materializePlan: vi.fn(async () => [
        { id: 'c1', ticketNumber: 1700, title: 'One', plannerChunkKey: 'one', blockedBy: [] },
        { id: 'c2', ticketNumber: 1701, title: 'Two', plannerChunkKey: 'two', blockedBy: [1700] },
      ]),
    });
    await rt.send('worker-codex', 'brief', { idempotencyKey: 'remote-plan' });
    await new Promise((r) => setTimeout(r, 0));
    expect(deps.runRemote).toHaveBeenCalledWith(
      expect.objectContaining({ jobKind: 'plan', repo: 'ToomeSauce/org-studio' }),
      expect.anything(),
    );
    expect(deps.runEngine).not.toHaveBeenCalled();
    expect(deps.materializePlan).toHaveBeenCalled();
    expect(deps.updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'done' }));
  });

  it('#1691: malformed plan output posts error context and does not materialize', async () => {
    setEnv('WORKER_RUNTIME_ENABLED', 'true');
    setEnv(
      'WORKER_RUNTIME_CONFIG',
      JSON.stringify([{ id: 'worker-codex', name: 'Worker', engine: 'codex', model: 'm', mode: 'local-process', frontier: true, lane: { taskTypes: ['feature'], projectIds: [] }, timeoutMs: 5000 }]),
    );
    setEnv('WORKER_REPO_PATHS', JSON.stringify({ 'proj-oss': '/tmp' }));
    const { rt, deps } = makeRuntime({
      fetchStore: vi.fn(async () => ({
        ...makeStore({ jobKind: 'plan', taskType: 'feature', version: 'v1', roadmapItemId: 'i1' }),
        projects: [{ id: 'proj-oss', sections: [{ versions: [{ version: 'v1', items: [{ id: 'i1', title: 'Item' }] }] }] }],
      })),
      runEngine: vi.fn(async () => ({ ...OK_RESULT, fileChanges: [], messages: ['not json'] })),
    });
    await rt.send('worker-codex', 'brief', {});
    await new Promise((r) => setTimeout(r, 0));
    expect(deps.materializePlan).not.toHaveBeenCalled();
    expect(deps.postComment).toHaveBeenCalledWith(
      'task-1', 'worker-codex', expect.stringContaining('missing ORG_STUDIO_PLAN_JSON_START'),
    );
  });

  it('discover() reflects configured workers with lane metadata', async () => {
    enableWorkers({ taskTypes: ['bug'], projectIds: ['p1'] });
    const { rt } = makeRuntime();
    const agents = await rt.discover();
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ id: 'worker-codex', runtime: 'worker', status: 'online' });
    expect(agents[0].metadata?.lane).toEqual({ taskTypes: ['bug'], projectIds: ['p1'] });
  });

  it('discover() is empty when workers are disabled', async () => {
    setEnv('WORKER_RUNTIME_ENABLED', undefined);
    const { rt } = makeRuntime();
    expect(await rt.discover()).toEqual([]);
    expect((await rt.health()).connected).toBe(false);
  });

  // --- #1658 W-3: ContextAssembler wiring in the job path ---

  it('job brief includes ticket fields, comment thread, and operating rules (#1658)', async () => {
    enableWorkers();
    const comments = [
      { author: 'Basil', content: 'Please keep it additive.', createdAt: 1, type: 'comment' },
    ];
    let capturedBrief = '';
    const { rt, deps } = makeRuntime({
      fetchComments: vi.fn(async () => comments),
      runEngine: vi.fn(async (opts: any) => {
        capturedBrief = opts.brief;
        return OK_RESULT;
      }),
    });
    await rt.send('worker-codex', 'DISPATCH HEADER', {});
    await new Promise((r) => setTimeout(r, 0));
    expect(deps.fetchComments).toHaveBeenCalledWith('task-1');
    expect(capturedBrief).toContain('DISPATCH HEADER');
    expect(capturedBrief).toContain('#42: Fix the thing');
    expect(capturedBrief).toContain('Ticket discussion');
    expect(capturedBrief).toContain('Please keep it additive.');
    expect(capturedBrief).toContain('Do NOT run whole-project builds');
  });

  it('writes generated AGENTS.md before the run and restores it after (#1658)', async () => {
    enableWorkers();
    const restore = vi.fn(async () => undefined);
    const calls: string[] = [];
    const { rt } = makeRuntime({
      writeAgentsMd: vi.fn(async (repo: string, content: string) => {
        calls.push('write');
        expect(repo).toBe('/tmp');
        expect(content).toContain(GENERATED_AGENTS_MD_MARKER);
        expect(content).toContain('#42');
        return restore;
      }),
      runEngine: vi.fn(async () => {
        calls.push('run');
        return OK_RESULT;
      }),
    });
    await rt.send('worker-codex', 'brief', {});
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(['write', 'run']);
    expect(restore).toHaveBeenCalled();
  });

  it('restores AGENTS.md even when the engine crashes (#1658)', async () => {
    enableWorkers();
    const restore = vi.fn(async () => undefined);
    const { rt } = makeRuntime({
      writeAgentsMd: vi.fn(async () => restore),
      runEngine: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await rt.send('worker-codex', 'brief', {});
    await new Promise((r) => setTimeout(r, 0));
    expect(restore).toHaveBeenCalled();
  });

  it('posts a STRUCTURED closeout with files/verification/outcome (#1658)', async () => {
    enableWorkers();
    const result: WorkerRunResult = {
      ...OK_RESULT,
      commands: [
        { command: 'npx vitest run src/x.test.ts', exitCode: 0 },
        { command: 'ls -la', exitCode: 0 },
        { command: 'npx tsc --noEmit src/x.ts', exitCode: 2 },
      ],
    };
    const { rt, deps } = makeRuntime({ runEngine: vi.fn(async () => result) });
    await rt.send('worker-codex', 'brief', {});
    await new Promise((r) => setTimeout(r, 0));
    const closeout = (deps.postComment as any).mock.calls[0][2] as string;
    expect(closeout).toContain('Files touched');
    expect(closeout).toContain('update: a.ts');
    expect(closeout).toContain('Verification run');
    expect(closeout).toContain('vitest run src/x.test.ts');
    expect(closeout).not.toContain('ls -la'); // non-verification commands excluded
    expect(closeout).toContain('What failed');
    expect(closeout).toContain('exit 2');
  });
});

describe('#1658: assembleBrief', () => {
  const task = {
    id: 't1',
    ticketNumber: 7,
    title: 'T',
    description: 'D',
    doneWhen: 'DW',
    constraints: 'C',
  };

  it('renders prior attempts from devHandoff + system bounce comments', () => {
    const brief = assembleBrief({
      dispatchMessage: 'HDR',
      task: { ...task, devHandoff: { message: 'DB is migrated now', author: 'Ana', createdAt: 5 } },
      comments: [
        { author: 'System', type: 'system', content: 'Reopened by Basil: broke on staging', createdAt: 1 },
        { author: 'Ana', type: 'comment', content: 'normal chat', createdAt: 2 },
      ],
    });
    expect(brief).toContain('Prior attempts');
    expect(brief).toContain('DB is migrated now');
    expect(brief).toContain('Reopened by Basil');
    expect(brief.indexOf('Prior attempts')).toBeLessThan(brief.indexOf('Ticket discussion'));
  });

  it('includes the leash block via the #1654 renderer when project has boundaries', () => {
    const brief = assembleBrief({
      dispatchMessage: 'HDR',
      task,
      project: {
        id: 'p1',
        name: 'Proj',
        budget: { ceilingUsdMonth: 100 },
        boundaries: { freeToDecide: ['tech stack'], mustAsk: ['spending money'] },
      },
      spend: { spendUsd: 25 },
    });
    expect(brief).toContain('Autonomy leash — Proj');
    expect(brief).toContain('$25.00 of $100.00/mo');
    expect(brief).toContain('Must ask BEFORE acting: spending money');
  });

  it('trims the OLD end of long threads, keeps the newest comments', () => {
    const comments = Array.from({ length: 30 }, (_, i) => ({
      author: `A${i}`,
      content: `comment number ${i} ${'x'.repeat(300)}`,
      createdAt: i,
      type: 'comment' as const,
    }));
    const brief = assembleBrief({ dispatchMessage: 'HDR', task, comments, maxThreadChars: 2000 });
    expect(brief).toContain('comment number 29'); // newest survives
    expect(brief).not.toContain('comment number 0 '); // oldest trimmed
    expect(brief).toContain('older comment(s) omitted');
  });

  it('omits empty sections cleanly', () => {
    const brief = assembleBrief({ dispatchMessage: 'HDR', task: { id: 't', title: 'X' } });
    expect(brief).not.toContain('Ticket discussion');
    expect(brief).not.toContain('Prior attempts');
    expect(brief).not.toContain('Autonomy leash');
    expect(brief).toContain('Operating rules');
  });
});

describe('#1658: generateWorkerAgentsMd + extractAttemptSummary', () => {
  it('AGENTS.md carries marker, host policy, deny list, git rules', () => {
    const md = generateWorkerAgentsMd({
      task: { id: 't', ticketNumber: 9, title: 'Fix' },
      workerId: 'worker-codex',
      repoConventions: 'Use tabs.',
      host: { buildPolicy: 'ci-only', denyCommands: ['next build'], notes: 'Thermal-limited host.' },
    });
    expect(md.startsWith(GENERATED_AGENTS_MD_MARKER)).toBe(true);
    expect(md).toContain('worker-codex');
    expect(md).toContain('Use tabs.');
    expect(md).toContain('ci-only');
    expect(md).toContain('`next build`');
    expect(md).toContain('Thermal-limited host.');
    expect(md).toContain('Do NOT push');
  });

  it('extractAttemptSummary classifies outcome, verification, failures', () => {
    const res: WorkerRunResult = {
      ok: false,
      exitCode: 1,
      durationMs: 100,
      commands: [
        { command: 'npx vitest run a.test.ts', exitCode: 1 },
        { command: 'cat file.ts', exitCode: 0 },
      ],
      fileChanges: [
        { path: 'a.ts', kind: 'update' },
        { path: 'a.ts', kind: 'update' }, // duplicate deduped
      ],
      messages: ['first', 'Could not fix the flaky test — mock leaks between cases.'],
      errors: [],
      usage: null,
      rawEventCount: 4,
    };
    const s = extractAttemptSummary(res);
    expect(s.outcome).toBe('failed');
    expect(s.filesTouched).toEqual(['update: a.ts']);
    expect(s.verificationRuns).toHaveLength(1);
    expect(s.failedCommands).toEqual([{ command: 'npx vitest run a.test.ts', exitCode: 1 }]);
    expect(s.finalMessage).toContain('mock leaks');
  });

  it('timeout errors classify as timeout outcome', () => {
    const s = extractAttemptSummary({
      ok: false,
      exitCode: null,
      durationMs: 5000,
      commands: [],
      fileChanges: [],
      messages: [],
      errors: ['engine killed at 5000ms timeout'],
      usage: null,
      rawEventCount: 0,
    });
    expect(s.outcome).toBe('timeout');
    const closeout = renderStructuredCloseout({
      dispatchId: 'd123456789012',
      engineLabel: 'codex/m',
      durationMs: 5000,
      summary: s,
    });
    expect(closeout).toContain('⏱️ timeout');
    expect(closeout).toContain('none detected — flag for human review');
  });
});
