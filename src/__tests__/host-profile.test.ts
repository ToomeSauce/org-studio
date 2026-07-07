/**
 * Tests for HostProfile — schema, presets, three-layer enforcement
 * (#1659, W-4 of Execution Workers).
 *
 * The doneWhen requires PROOF that a denied command is blocked at the
 * engine-hook layer: the deny-guard test below EXECUTES the generated
 * script via sh and asserts the deny exit code (2), not just string
 * content.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  HOST_PROFILE_PRESETS,
  validateHostProfile,
  resolveHostProfile,
  compileDenyGuardScript,
  buildClaudePreToolUseConfig,
  codexSandboxModeFor,
  buildOsWrapper,
  toHostAdvisory,
  type HostProfile,
} from '@/lib/workers/host-profile';
import { tryAcquireHostSlot, hostSlotCount, __resetHostSlotsForTest } from '@/lib/workers/host-semaphore';
import { buildEngineArgv } from '@/lib/workers/engine-codex';
import { WorkerRuntime } from '@/lib/workers/worker-runtime';
import type { WorkerRunResult } from '@/lib/workers/engine-codex';

afterEach(() => {
  __resetHostSlotsForTest();
});

// ---------------------------------------------------------------------------
// Schema + presets
// ---------------------------------------------------------------------------

describe('#1659: HostProfile schema + presets', () => {
  it('ships constrained-local and remote-full presets', () => {
    const cl = HOST_PROFILE_PRESETS['constrained-local'];
    expect(cl.buildPolicy).toBe('ci-only');
    expect(cl.maxConcurrentJobs).toBe(1);
    expect(cl.denyCommands).toContain('next build');
    const rf = HOST_PROFILE_PRESETS['remote-full'];
    expect(rf.buildPolicy).toBe('local-ok');
    expect(rf.denyCommands).toEqual([]);
    // Presets must themselves validate.
    expect(validateHostProfile(cl).ok).toBe(true);
    expect(validateHostProfile(rf).ok).toBe(true);
  });

  it('rejects bad buildPolicy, denyCommands, caps, unknown keys', () => {
    const base = HOST_PROFILE_PRESETS['remote-full'];
    expect(validateHostProfile({ ...base, buildPolicy: 'yolo' }).ok).toBe(false);
    expect(validateHostProfile({ ...base, denyCommands: [42] }).ok).toBe(false);
    expect(validateHostProfile({ ...base, maxConcurrentJobs: 0 }).ok).toBe(false);
    expect(validateHostProfile({ ...base, cpuQuotaPct: 250 }).ok).toBe(false);
    expect(validateHostProfile({ ...base, surprise: true }).ok).toBe(false);
    expect(validateHostProfile(null).ok).toBe(false);
  });

  it('resolveHostProfile prefers settings.hostProfiles, falls back to presets', () => {
    const settings = {
      hostProfiles: {
        hanktank: {
          buildPolicy: 'ci-only',
          verification: 'dev-probe',
          denyCommands: ['next build'],
          maxConcurrentJobs: 1,
        },
      },
    };
    const fromSettings = resolveHostProfile(settings, 'hanktank');
    expect(fromSettings?.id).toBe('hanktank');
    expect(fromSettings?.denyCommands).toEqual(['next build']);

    const fromPreset = resolveHostProfile({}, 'constrained-local');
    expect(fromPreset?.maxConcurrentJobs).toBe(1);

    expect(resolveHostProfile({}, 'nope')).toBeNull();
    expect(resolveHostProfile({}, undefined)).toBeNull();
  });

  it('invalid stored profile falls back to preset instead of half-applying', () => {
    const settings = {
      hostProfiles: {
        'constrained-local': { buildPolicy: 'yolo' }, // invalid override
      },
    };
    const p = resolveHostProfile(settings, 'constrained-local');
    expect(p?.buildPolicy).toBe('ci-only'); // preset won
  });
});

// ---------------------------------------------------------------------------
// Layer 2: engine hooks — EXECUTED guard proof
// ---------------------------------------------------------------------------

describe('#1659: deny guard blocks at the engine-hook layer (executed proof)', () => {
  const profile = HOST_PROFILE_PRESETS['constrained-local'];

  function runGuard(script: string, command: string): { code: number; stderr: string } {
    const dir = mkdtempSync(join(tmpdir(), 'deny-guard-'));
    const p = join(dir, 'deny-guard.sh');
    writeFileSync(p, script, { mode: 0o755 });
    try {
      execFileSync('sh', [p, command], { stdio: ['ignore', 'pipe', 'pipe'] });
      return { code: 0, stderr: '' };
    } catch (e: any) {
      return { code: e.status, stderr: String(e.stderr || '') };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('DENIES a forbidden whole-project build (exit 2)', () => {
    const script = compileDenyGuardScript(profile);
    const r = runGuard(script, 'next build');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('DENIED by HostProfile constrained-local');
  });

  it('DENIES the forbidden command embedded in a compound command', () => {
    const script = compileDenyGuardScript(profile);
    expect(runGuard(script, 'cd app && next build && echo done').code).toBe(2);
    expect(runGuard(script, 'npm test -- --coverage').code).toBe(2);
  });

  it('ALLOWS targeted single-file checks (exit 0)', () => {
    const script = compileDenyGuardScript(profile);
    expect(runGuard(script, 'npx vitest run src/__tests__/x.test.ts').code).toBe(0);
    expect(runGuard(script, 'npx tsc --noEmit src/lib/one-file.ts').code).toBe(0);
    expect(runGuard(script, 'eslint src/lib/one-file.ts').code).toBe(0);
    expect(runGuard(script, 'git commit -m "feat: x"').code).toBe(0);
  });

  it('empty denyCommands allows everything', () => {
    const script = compileDenyGuardScript(HOST_PROFILE_PRESETS['remote-full']);
    expect(runGuard(script, 'next build').code).toBe(0);
  });

  it('deny patterns with shell-special chars are escaped, not executed', () => {
    const p: HostProfile = {
      ...profile,
      denyCommands: ['rm -rf *', 'foo|bar'],
    };
    const script = compileDenyGuardScript(p);
    expect(runGuard(script, 'rm -rf *').code).toBe(2);
    expect(runGuard(script, 'foo|bar').code).toBe(2);
    expect(runGuard(script, 'rm -rf ./dist').code).toBe(0); // '*' matched literally, not as glob
  });

  it('Claude PreToolUse config pipes Bash commands through the guard', () => {
    const cfg = buildClaudePreToolUseConfig('/x/deny-guard.sh');
    const hook = cfg.hooks.PreToolUse[0];
    expect(hook.matcher).toBe('Bash');
    expect(hook.hooks[0].command).toContain('/x/deny-guard.sh');
    expect(hook.hooks[0].command).toContain('tool_input.command');
  });

  it('codex sandbox mode maps from buildPolicy', () => {
    expect(codexSandboxModeFor(HOST_PROFILE_PRESETS['constrained-local'])).toBe('workspace-write');
    expect(codexSandboxModeFor(HOST_PROFILE_PRESETS['remote-full'])).toBe('danger-full-access');
    expect(codexSandboxModeFor(null)).toBe('danger-full-access'); // no profile = W-2 behavior
  });
});

// ---------------------------------------------------------------------------
// Layer 3: OS backstop
// ---------------------------------------------------------------------------

describe('#1659: OS backstop wrapper', () => {
  const profile = HOST_PROFILE_PRESETS['constrained-local'];

  it('builds a systemd-run scope with CPUQuota/MemoryMax when available', () => {
    const w = buildOsWrapper(profile, 60 * 60_000, true);
    expect(w.argvPrefix[0]).toBe('systemd-run');
    expect(w.argvPrefix).toContain('--property=CPUQuota=50%');
    expect(w.argvPrefix).toContain('--property=MemoryMax=4096M');
    // profile timeoutMin (30) tightens the base 60min timeout
    expect(w.timeoutMs).toBe(30 * 60_000);
  });

  it('no wrapper when systemd-run unavailable or no caps or no profile', () => {
    expect(buildOsWrapper(profile, 1000, false).argvPrefix).toEqual([]);
    expect(buildOsWrapper(HOST_PROFILE_PRESETS['remote-full'], 1000, true).argvPrefix).toEqual([]);
    expect(buildOsWrapper(null, 1000, true)).toEqual({ argvPrefix: [], timeoutMs: 1000 });
  });

  it('timeout only tightens, never loosens', () => {
    // base 10min < profile 30min → base wins
    expect(buildOsWrapper(profile, 10 * 60_000, true).timeoutMs).toBe(10 * 60_000);
  });

  it('buildEngineArgv prepends the wrapper and threads sandbox mode', () => {
    const { cmd, args } = buildEngineArgv({
      cwd: '/x',
      brief: 'B',
      model: 'm',
      timeoutMs: 1000,
      sandboxMode: 'workspace-write',
      argvPrefix: ['systemd-run', '--user', '--scope'],
    });
    expect(cmd).toBe('systemd-run');
    expect(args.slice(0, 2)).toEqual(['--user', '--scope']);
    expect(args).toContain('codex');
    expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace-write');
  });

  it('buildEngineArgv defaults preserve W-2 behavior', () => {
    const { cmd, args } = buildEngineArgv({ cwd: '/x', brief: 'B', model: 'm', timeoutMs: 1 });
    expect(cmd).toBe('codex');
    expect(args[args.indexOf('--sandbox') + 1]).toBe('danger-full-access');
  });
});

// ---------------------------------------------------------------------------
// Per-host semaphore
// ---------------------------------------------------------------------------

describe('#1659: per-host job semaphore', () => {
  it('caps concurrent jobs per host and frees on release', () => {
    const a = tryAcquireHostSlot('h1', 2);
    const b = tryAcquireHostSlot('h1', 2);
    expect(a.ok && b.ok).toBe(true);
    const c = tryAcquireHostSlot('h1', 2);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reason).toContain('job cap (2/2');
    (a as any).release();
    expect(tryAcquireHostSlot('h1', 2).ok).toBe(true);
  });

  it('hosts are independent', () => {
    expect(tryAcquireHostSlot('h1', 1).ok).toBe(true);
    expect(tryAcquireHostSlot('h2', 1).ok).toBe(true);
    expect(tryAcquireHostSlot('h1', 1).ok).toBe(false);
  });

  it('double-release is idempotent (cannot corrupt the count)', () => {
    const a = tryAcquireHostSlot('h1', 1);
    if (a.ok) {
      a.release();
      a.release(); // second release must be a no-op
    }
    expect(hostSlotCount('h1')).toBe(0);
    const b = tryAcquireHostSlot('h1', 1);
    expect(b.ok).toBe(true);
    expect(tryAcquireHostSlot('h1', 1).ok).toBe(false); // still capped at 1
  });
});

// ---------------------------------------------------------------------------
// WorkerRuntime integration — dispatcher-enforced semaphore + advisory
// ---------------------------------------------------------------------------

describe('#1659: WorkerRuntime enforces HostProfile at dispatch', () => {
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

  const OK_RESULT: WorkerRunResult = {
    ok: true, exitCode: 0, durationMs: 5, commands: [], fileChanges: [],
    messages: ['done'], errors: [], usage: null, rawEventCount: 1,
  };

  function setup(opts: { hostId?: string; settings?: any; engine?: any } = {}) {
    setEnv('WORKER_RUNTIME_ENABLED', 'true');
    setEnv(
      'WORKER_RUNTIME_CONFIG',
      JSON.stringify([
        {
          id: 'worker-codex', engine: 'codex', model: 'm', timeoutMs: 5000,
          lane: { taskTypes: ['bug'], projectIds: [] },
          ...(opts.hostId ? { hostId: opts.hostId } : {}),
        },
      ]),
    );
    setEnv('WORKER_REPO_PATHS', JSON.stringify({ 'proj-oss': '/tmp' }));
    const store = {
      settings: opts.settings || {},
      projects: [],
      tasks: [
        {
          id: 'task-1', ticketNumber: 9, title: 'Fix', status: 'backlog',
          assignee: 'worker-codex', taskType: 'bug', projectId: 'proj-oss', sortOrder: 1,
        },
      ],
    };
    const deps = {
      fetchStore: vi.fn(async () => store),
      postComment: vi.fn(async () => undefined),
      fetchComments: vi.fn(async () => []),
      writeAgentsMd: vi.fn(async () => vi.fn(async () => undefined)),
      runEngine: opts.engine || vi.fn(async () => OK_RESULT),
      recordDispatch: vi.fn(),
      recordModelCall: vi.fn(),
      systemdRunAvailable: () => true,
      acquireHostSlot: tryAcquireHostSlot,
    };
    return { rt: new WorkerRuntime(deps as any), deps };
  }

  it('refuses dispatch when the host is at maxConcurrentJobs', async () => {
    // constrained-local preset: maxConcurrentJobs = 1
    let resolveEngine!: (r: WorkerRunResult) => void;
    const pending = new Promise<WorkerRunResult>((res) => (resolveEngine = res));
    const { rt } = setup({ hostId: 'constrained-local', engine: vi.fn(() => pending) });

    await rt.send('worker-codex', 'brief', { idempotencyKey: 'd1' });
    expect(hostSlotCount('constrained-local')).toBe(1);

    // Second runtime instance simulating another worker on the SAME host:
    const { rt: rt2 } = setup({ hostId: 'constrained-local' });
    await expect(rt2.send('worker-codex', 'brief', { idempotencyKey: 'd2' })).rejects.toThrow(
      /job cap/,
    );

    resolveEngine(OK_RESULT);
    await new Promise((r) => setTimeout(r, 0));
    expect(hostSlotCount('constrained-local')).toBe(0); // slot freed after job end
  });

  it('threads profile-derived sandbox mode, argv prefix, and tightened timeout to the engine', async () => {
    let captured: any = null;
    const engine = vi.fn(async (o: any) => {
      captured = o;
      return OK_RESULT;
    });
    const { rt } = setup({ hostId: 'constrained-local', engine });
    await rt.send('worker-codex', 'brief', {});
    await new Promise((r) => setTimeout(r, 0));
    expect(captured.sandboxMode).toBe('workspace-write');
    expect(captured.argvPrefix[0]).toBe('systemd-run');
    expect(captured.timeoutMs).toBe(5000); // worker 5s < profile 30min → worker wins
  });

  it('renders the profile into the generated AGENTS.md (advisory layer)', async () => {
    let agentsMd = '';
    const { rt } = setup({ hostId: 'constrained-local' });
    (rt as any).deps.writeAgentsMd = vi.fn(async (_r: string, content: string) => {
      agentsMd = content;
      return vi.fn(async () => undefined);
    });
    await rt.send('worker-codex', 'brief', {});
    await new Promise((r) => setTimeout(r, 0));
    expect(agentsMd).toContain('ci-only');
    expect(agentsMd).toContain('`next build`');
    expect(agentsMd).toContain('Push and let CI run the full build');
  });

  it('settings.hostProfiles overrides presets at dispatch time', async () => {
    let captured: any = null;
    const engine = vi.fn(async (o: any) => {
      captured = o;
      return OK_RESULT;
    });
    const { rt } = setup({
      hostId: 'myhost',
      settings: {
        hostProfiles: {
          myhost: {
            buildPolicy: 'local-ok', verification: 'full',
            denyCommands: [], maxConcurrentJobs: 3,
          },
        },
      },
      engine,
    });
    await rt.send('worker-codex', 'brief', {});
    await new Promise((r) => setTimeout(r, 0));
    expect(captured.sandboxMode).toBe('danger-full-access'); // local-ok
    expect(hostSlotCount('myhost')).toBe(0);
  });

  it('no hostId = no profile = W-2 behavior unchanged', async () => {
    let captured: any = null;
    const engine = vi.fn(async (o: any) => {
      captured = o;
      return OK_RESULT;
    });
    const { rt } = setup({ engine });
    await rt.send('worker-codex', 'brief', {});
    await new Promise((r) => setTimeout(r, 0));
    expect(captured.sandboxMode).toBe('danger-full-access');
    expect(captured.argvPrefix).toEqual([]);
    expect(captured.timeoutMs).toBe(5000);
  });

  it('advisory adapter maps profile → W-3 host shape', () => {
    const adv = toHostAdvisory(HOST_PROFILE_PRESETS['constrained-local']);
    expect(adv?.buildPolicy).toBe('ci-only');
    expect(adv?.denyCommands).toContain('next build');
    expect(adv?.notes).toContain('dev-probe');
    expect(toHostAdvisory(null)).toBeNull();
  });
});
