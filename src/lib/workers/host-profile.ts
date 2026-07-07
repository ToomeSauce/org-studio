/**
 * HostProfile — HOST.md-style host constraints as enforced config
 * (#1659, W-4 of Execution Workers).
 *
 * Promotes per-execution-target rules from operator prose to structured,
 * validated config stored in Org Studio settings (`settings.hostProfiles`,
 * JSONB overflow — reversible, no migration). Design doc:
 * docs/design/execution-workers.md § HostProfile.
 *
 * Enforced at THREE layers, weakest → strongest:
 *   1. Advisory        — renders into the generated AGENTS.md (W-3 wiring).
 *   2. Engine hooks    — denyCommands[] compiles into a guard script +
 *                        Claude Code PreToolUse hook config; Codex gets
 *                        sandbox-mode mapping from buildPolicy. A forbidden
 *                        build doesn't run wrong — it doesn't run.
 *   3. OS backstop     — systemd-run scope wrapper (CPUQuota/MemoryMax) +
 *                        hard timeout + dispatcher-enforced per-host job
 *                        semaphore (host-semaphore.ts).
 *
 * Everything in this module is PURE (schema, validation, presets, hook
 * compilation, wrapper argv building). IO lives with the callers.
 */

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface HostProfile {
  /** Stable id, e.g. "hanktank". Referenced by worker config via hostId. */
  id: string;
  /** Human label. */
  name?: string;
  /** ci-only: no whole-project builds locally; local-ok: full builds fine. */
  buildPolicy: 'ci-only' | 'local-ok';
  /** How work gets verified on this host. */
  verification: 'dev-probe' | 'full';
  /** Command substrings/patterns that must NOT run (engine-hook layer). */
  denyCommands: string[];
  /** Max simultaneous worker jobs on this host (dispatcher semaphore). */
  maxConcurrentJobs: number;
  /** OS backstop caps (systemd-run scope when available). */
  cpuQuotaPct?: number;   // e.g. 50 → CPUQuota=50%
  memLimitMb?: number;    // e.g. 4096 → MemoryMax=4096M
  timeoutMin?: number;    // hard wall-clock cap; overrides worker timeoutMs when smaller
}

export const HOST_PROFILE_PRESETS: Record<string, HostProfile> = {
  /** The hanktank rules, promoted from HOST.md prose to config. */
  'constrained-local': {
    id: 'constrained-local',
    name: 'Constrained local (thermal/CPU-limited host)',
    buildPolicy: 'ci-only',
    verification: 'dev-probe',
    denyCommands: [
      'next build',
      'npm run build',
      'npm test',
      'vitest --run', // bare full-suite forms; targeted `vitest run <file>` stays allowed
      'tsc --noEmit -p',
      'eslint .',
    ],
    maxConcurrentJobs: 1,
    cpuQuotaPct: 50,
    memLimitMb: 4096,
    timeoutMin: 30,
  },
  /** Ephemeral/remote runner — full builds are the point. */
  'remote-full': {
    id: 'remote-full',
    name: 'Remote full (ephemeral runner / VM)',
    buildPolicy: 'local-ok',
    verification: 'full',
    denyCommands: [],
    maxConcurrentJobs: 4,
    timeoutMin: 60,
  },
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type HostProfileValidation = { ok: true; profile: HostProfile } | { ok: false; error: string };

export function validateHostProfile(raw: any): HostProfileValidation {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'profile must be an object' };
  if (typeof raw.id !== 'string' || !/^[a-z0-9][a-z0-9-_]{0,63}$/i.test(raw.id)) {
    return { ok: false, error: 'id must be a short alphanumeric/dash/underscore string' };
  }
  if (!['ci-only', 'local-ok'].includes(raw.buildPolicy)) {
    return { ok: false, error: `buildPolicy must be ci-only|local-ok (got ${raw.buildPolicy})` };
  }
  if (!['dev-probe', 'full'].includes(raw.verification)) {
    return { ok: false, error: `verification must be dev-probe|full (got ${raw.verification})` };
  }
  if (!Array.isArray(raw.denyCommands) || raw.denyCommands.some((d: any) => typeof d !== 'string' || !d.trim())) {
    return { ok: false, error: 'denyCommands must be an array of non-empty strings' };
  }
  if (!Number.isInteger(raw.maxConcurrentJobs) || raw.maxConcurrentJobs < 1 || raw.maxConcurrentJobs > 64) {
    return { ok: false, error: 'maxConcurrentJobs must be an integer 1–64' };
  }
  for (const [k, max] of [['cpuQuotaPct', 100], ['memLimitMb', 1024 * 1024], ['timeoutMin', 24 * 60]] as const) {
    if (raw[k] !== undefined && (!Number.isFinite(raw[k]) || raw[k] <= 0 || raw[k] > max)) {
      return { ok: false, error: `${k} must be a positive number ≤ ${max}` };
    }
  }
  const known = new Set(['id', 'name', 'buildPolicy', 'verification', 'denyCommands', 'maxConcurrentJobs', 'cpuQuotaPct', 'memLimitMb', 'timeoutMin']);
  const unknown = Object.keys(raw).filter((k) => !known.has(k));
  if (unknown.length > 0) return { ok: false, error: `unknown keys: ${unknown.join(', ')}` };
  return {
    ok: true,
    profile: {
      id: raw.id,
      name: typeof raw.name === 'string' ? raw.name : undefined,
      buildPolicy: raw.buildPolicy,
      verification: raw.verification,
      denyCommands: raw.denyCommands.map((d: string) => d.trim()),
      maxConcurrentJobs: raw.maxConcurrentJobs,
      cpuQuotaPct: raw.cpuQuotaPct,
      memLimitMb: raw.memLimitMb,
      timeoutMin: raw.timeoutMin,
    },
  };
}

/** Resolve a profile from settings.hostProfiles, falling back to presets. */
export function resolveHostProfile(
  settings: Record<string, any> | undefined | null,
  hostId: string | undefined,
): HostProfile | null {
  if (!hostId) return null;
  const stored = settings?.hostProfiles?.[hostId];
  if (stored) {
    const v = validateHostProfile({ id: hostId, ...stored, ...(stored.id ? {} : {}) });
    if (v.ok) return v.profile;
    console.warn(`[host-profile] stored profile ${hostId} invalid (${(v as any).error}) — falling back to preset`);
  }
  return HOST_PROFILE_PRESETS[hostId] || null;
}

// ---------------------------------------------------------------------------
// Layer 2: engine hooks
// ---------------------------------------------------------------------------

/**
 * Compile denyCommands into a POSIX guard script. The script reads the
 * candidate command on argv/stdin and exits 2 (deny) when any deny pattern
 * matches as a substring, 0 otherwise. This single artifact backs both
 * engine integrations:
 *   - Claude Code: PreToolUse hook invokes it with the Bash tool input;
 *     exit 2 = block (see buildClaudePreToolUseConfig).
 *   - Codex: no command-deny primitive exists; the guard is still emitted
 *     for wrapper use, and buildPolicy maps to the sandbox mode (below).
 *
 * Substring matching is deliberate: deny patterns like "next build" should
 * catch "cd app && next build" too. Case-sensitive (commands are).
 */
export function compileDenyGuardScript(profile: HostProfile): string {
  const patterns = profile.denyCommands;
  const lines: string[] = [
    '#!/bin/sh',
    `# Generated deny guard — HostProfile "${profile.id}" (#1659). Do not edit.`,
    '# Usage: deny-guard.sh "<command string>"  (or command on stdin)',
    '# Exit 0 = allowed, exit 2 = DENIED.',
    'CMD="$1"',
    '[ -z "$CMD" ] && CMD="$(cat)"',
  ];
  for (const p of patterns) {
    // The pattern sits inside double quotes in the case pattern, where glob
    // chars are already literal — only backslash and double-quote need
    // escaping. (Escaping globs here would inject literal backslashes and
    // break matching — caught by the executed-proof test.)
    const esc = p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    lines.push(`case "$CMD" in *"${esc}"*) echo "DENIED by HostProfile ${profile.id}: matches '${esc}'" >&2; exit 2;; esac`);
  }
  lines.push('exit 0');
  return lines.join('\n') + '\n';
}

/**
 * Claude Code settings fragment: PreToolUse hook on the Bash tool that
 * pipes the command through the deny guard. Exit code 2 from a PreToolUse
 * hook blocks the tool call — that's the hard-block layer.
 * (Written to <checkout>/.claude/settings.json by the claude-code adapter;
 * emitted here so the shape is tested + stable before that adapter lands.)
 */
export function buildClaudePreToolUseConfig(guardScriptPath: string): any {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: `jq -r '.tool_input.command // empty' | ${guardScriptPath}`,
            },
          ],
        },
      ],
    },
  };
}

/**
 * Codex sandbox-mode mapping. Codex CLI has no per-command deny primitive;
 * what it does have is a sandbox policy. buildPolicy drives it:
 *   ci-only  → 'workspace-write' (no escaping the checkout; heavy system-wide
 *              side effects contained) — plus advisory + OS caps do the rest.
 *   local-ok → 'danger-full-access' (trusted like a runtime on this box).
 */
export function codexSandboxModeFor(profile: HostProfile | null): string {
  if (!profile) return 'danger-full-access'; // no profile = W-2 behavior, unchanged
  return profile.buildPolicy === 'ci-only' ? 'workspace-write' : 'danger-full-access';
}

// ---------------------------------------------------------------------------
// Layer 3: OS backstop — systemd-run scope wrapper
// ---------------------------------------------------------------------------

export interface OsWrapperResult {
  /** Argv prefix to prepend to the engine spawn, [] when no caps apply. */
  argvPrefix: string[];
  /** Effective timeout ms after applying profile.timeoutMin (min of both). */
  timeoutMs: number;
}

/**
 * Build the OS-cap wrapper. When systemd-run is available (injectable check),
 * wraps the engine in a transient user scope with CPUQuota/MemoryMax. Pure
 * argv construction — the spawn itself stays in engine-codex.
 */
export function buildOsWrapper(
  profile: HostProfile | null,
  baseTimeoutMs: number,
  systemdRunAvailable: boolean,
): OsWrapperResult {
  let timeoutMs = baseTimeoutMs;
  if (profile?.timeoutMin && profile.timeoutMin * 60_000 < timeoutMs) {
    timeoutMs = profile.timeoutMin * 60_000;
  }
  if (!profile || !systemdRunAvailable || (!profile.cpuQuotaPct && !profile.memLimitMb)) {
    return { argvPrefix: [], timeoutMs };
  }
  const argv = ['systemd-run', '--user', '--scope', '--quiet', '--collect'];
  if (profile.cpuQuotaPct) argv.push(`--property=CPUQuota=${profile.cpuQuotaPct}%`);
  if (profile.memLimitMb) argv.push(`--property=MemoryMax=${profile.memLimitMb}M`);
  return { argvPrefix: argv, timeoutMs };
}

// ---------------------------------------------------------------------------
// Layer 1: advisory (AGENTS.md) — adapter to the W-3 renderer's shape
// ---------------------------------------------------------------------------

/** Convert a HostProfile into the W-3 generateWorkerAgentsMd host advisory. */
export function toHostAdvisory(profile: HostProfile | null): {
  buildPolicy?: string;
  denyCommands?: string[];
  notes?: string;
} | null {
  if (!profile) return null;
  return {
    buildPolicy: profile.buildPolicy,
    denyCommands: profile.denyCommands,
    notes:
      profile.buildPolicy === 'ci-only'
        ? `Verification on this host: ${profile.verification}. Push and let CI run the full build/test/typecheck.`
        : undefined,
  };
}
