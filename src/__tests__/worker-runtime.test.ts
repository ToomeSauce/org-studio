/**
 * Tests for the Execution Workers lane gate + engine event parsing
 * (#1657, W-2). Event fixtures mirror the real codex-cli 0.142.5 stream
 * captured in the W-1 spike (#1656).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { checkLane, getWorkerConfigs, workersEnabled, DEFAULT_WORKERS } from '@/lib/workers/config';
import { parseEngineEvents, type WorkerRunResult } from '@/lib/workers/engine-codex';
import { WorkerRuntime } from '@/lib/workers/worker-runtime';

const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined) {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
afterEach(() => {
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
      runEngine: vi.fn(async () => OK_RESULT),
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
});
