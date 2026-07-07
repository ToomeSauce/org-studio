/**
 * EngineAdapter — codex implementation (#1657, W-2; schema proven by W-1 spike).
 *
 * Spawns `codex exec --json` as a subprocess and parses the JSONL event
 * stream into a normalized WorkerRunResult. The engine is a swappable
 * commodity behind this interface — a claude-code adapter implements the
 * same contract later.
 *
 * Event schema (verified against codex-cli 0.142.5, W-1 spike #1656):
 *   thread.started { thread_id }
 *   turn.started
 *   item.started|item.completed { item: { type, ... } }
 *     item.type = command_execution { command, exit_code }
 *               | file_change      { changes: [{path, kind}] }
 *               | agent_message    { text }
 *               | error            { message }   ← tolerate, non-fatal
 *   turn.completed { usage: { input_tokens, cached_input_tokens,
 *                             output_tokens, reasoning_output_tokens } }
 *
 * Sandbox note (W-1 finding): codex's bwrap/landlock sandbox fails on hosts
 * without unprivileged user namespaces. Isolation is the Provisioning
 * layer's job (design doc: security ladder) — local-process mode runs the
 * engine with danger-full-access inside a checkout the shell controls.
 */
import { spawn } from 'child_process';

export interface EngineUsage {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
}

export interface EngineCommand {
  command: string;
  exitCode: number | null;
}

export interface EngineFileChange {
  path: string;
  kind: string; // add | update | delete
}

export interface WorkerRunResult {
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  commands: EngineCommand[];
  fileChanges: EngineFileChange[];
  messages: string[];
  errors: string[];
  usage: EngineUsage | null;
  rawEventCount: number;
}

export interface EngineRunOpts {
  cwd: string;
  brief: string;
  model: string;
  timeoutMs: number;
  env?: Record<string, string>;
  /** Codex sandbox policy (#1659 W-4) — from codexSandboxModeFor(profile).
   *  Default 'danger-full-access' preserves W-2 behavior. */
  sandboxMode?: string;
  /** OS backstop argv prefix (#1659 W-4) — e.g. systemd-run scope wrapper
   *  with CPUQuota/MemoryMax. Empty/omitted = plain spawn. */
  argvPrefix?: string[];
}

/** Parse a raw JSONL event stream into the normalized result fields. */
export function parseEngineEvents(raw: string): Omit<WorkerRunResult, 'ok' | 'exitCode' | 'durationMs'> {
  const commands: EngineCommand[] = [];
  const fileChanges: EngineFileChange[] = [];
  const messages: string[] = [];
  const errors: string[] = [];
  let usage: EngineUsage | null = null;
  let count = 0;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // tolerate non-JSON noise on stdout
    }
    count++;
    if (e.type === 'item.completed') {
      const it = e.item || {};
      if (it.type === 'command_execution') {
        commands.push({
          command: typeof it.command === 'string' ? it.command : '',
          exitCode: typeof it.exit_code === 'number' ? it.exit_code : null,
        });
      } else if (it.type === 'file_change') {
        for (const c of Array.isArray(it.changes) ? it.changes : []) {
          if (c && typeof c.path === 'string') {
            fileChanges.push({ path: c.path, kind: String(c.kind || 'update') });
          }
        }
      } else if (it.type === 'agent_message') {
        if (typeof it.text === 'string') messages.push(it.text);
      } else if (it.type === 'error') {
        // W-1 finding: codex emits advisory error items (e.g. skills-context
        // truncation). Record, never fail the run on these.
        if (typeof it.message === 'string') errors.push(it.message);
      }
    } else if (e.type === 'turn.completed') {
      const u = e.usage || {};
      usage = {
        inputTokens: typeof u.input_tokens === 'number' ? u.input_tokens : null,
        cachedInputTokens: typeof u.cached_input_tokens === 'number' ? u.cached_input_tokens : null,
        outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : null,
        reasoningOutputTokens:
          typeof u.reasoning_output_tokens === 'number' ? u.reasoning_output_tokens : null,
      };
    }
  }
  return { commands, fileChanges, messages, errors, usage, rawEventCount: count };
}

/**
 * Build the full spawn argv (wrapper prefix + codex invocation). Exported
 * for tests — the deny/caps story is only trustworthy if the exact argv
 * is assertable.
 */
export function buildEngineArgv(opts: EngineRunOpts): { cmd: string; args: string[] } {
  const codexArgs = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    opts.sandboxMode || 'danger-full-access', // isolation = provisioning layer (see header)
    '-m',
    opts.model,
    opts.brief,
  ];
  const prefix = opts.argvPrefix || [];
  if (prefix.length > 0) {
    return { cmd: prefix[0], args: [...prefix.slice(1), 'codex', ...codexArgs] };
  }
  return { cmd: 'codex', args: codexArgs };
}

/**
 * Run the codex engine headless. Resolves with a normalized result;
 * only rejects on spawn-level failures (binary missing). Non-zero engine
 * exit resolves with ok:false so callers can post an honest closeout.
 */
export function runCodexEngine(opts: EngineRunOpts): Promise<WorkerRunResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const { cmd, args } = buildEngineArgv(opts);
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    let killed = false;
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`codex spawn failed: ${e.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const parsed = parseEngineEvents(out);
      if (killed) parsed.errors.push(`engine killed at ${opts.timeoutMs}ms timeout`);
      if (code !== 0 && err.trim()) parsed.errors.push(err.slice(-500));
      resolve({
        ok: code === 0 && !killed,
        exitCode: killed ? null : code,
        durationMs: Date.now() - started,
        ...parsed,
      });
    });
  });
}
