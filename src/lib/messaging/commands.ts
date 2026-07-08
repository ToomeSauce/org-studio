/**
 * M-1 (#1662): Deterministic inbound command layer.
 *
 * Pure parse + authz + dispatch table. HARD RULE (ticket constraint): no
 * model calls anywhere in this path — commands are exact-grammar strings
 * (typically produced by inline buttons), and anything that doesn't parse
 * gets a usage error, never an LLM fallback.
 *
 * Grammar (v1):
 *   approve <projectId> <version>     — add version to primary component's approvedVersions[]
 *   pause <projectId>                 — set loopPaused=true on the active version
 *   resume <projectId>                — set loopPaused=false on the active version
 *   budget <projectId> <usd>          — set budget.ceilingUsdMonth
 *   status <projectId>                — read-only one-liner (spend/ceiling/paused)
 *   help                              — list commands available to the caller
 *
 * Authz: chat user → ChatBinding (fail closed: no binding, no commands),
 * then optional per-binding allowedCommands narrowing. Execution goes
 * through injected effect functions (store/roadmap APIs) so this module
 * stays pure and unit-testable.
 */

import type { ChatBinding, InboundMessage, InboundReply } from './types';

// ---------- Parsing ----------

export type ParsedCommand =
  | { verb: 'approve'; projectId: string; version: string }
  | { verb: 'pause'; projectId: string }
  | { verb: 'resume'; projectId: string }
  | { verb: 'budget'; projectId: string; usd: number }
  | { verb: 'status'; projectId: string }
  | { verb: 'help' };

export type ParseResult = { ok: true; cmd: ParsedCommand } | { ok: false; error: string };

export const COMMAND_VERBS = ['approve', 'pause', 'resume', 'budget', 'status', 'help'] as const;

const USAGE: Record<string, string> = {
  approve: 'approve <projectId> <version>',
  pause: 'pause <projectId>',
  resume: 'resume <projectId>',
  budget: 'budget <projectId> <usd>',
  status: 'status <projectId>',
  help: 'help',
};

/** Version shapes we accept: SemVer (1.2.3) or CalVer (2026.10.01[.N]).
 *  Mirrors the roadmap route's canonical-form rule: no 'v' prefix. */
const VERSION_RE = /^\d+\.\d+\.\d+(\.\d+)?$/;
/** Project ids are store-generated slugs/ids — conservative charset. */
const PROJECT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function parseCommand(raw: string): ParseResult {
  const text = (raw || '').trim().replace(/^\//, ''); // tolerate '/approve …'
  if (!text) return { ok: false, error: 'Empty command. Try: help' };

  const parts = text.split(/\s+/);
  const verb = parts[0].toLowerCase();

  if (!COMMAND_VERBS.includes(verb as any)) {
    return { ok: false, error: `Unknown command '${verb}'. Try: help` };
  }
  const usage = `Usage: ${USAGE[verb]}`;

  switch (verb) {
    case 'help':
      return { ok: true, cmd: { verb: 'help' } };
    case 'approve': {
      if (parts.length !== 3) return { ok: false, error: usage };
      const [, projectId, version] = parts;
      if (!PROJECT_ID_RE.test(projectId)) return { ok: false, error: `Bad projectId. ${usage}` };
      if (!VERSION_RE.test(version)) {
        return { ok: false, error: `Bad version '${version}' — canonical form only (no 'v' prefix). ${usage}` };
      }
      return { ok: true, cmd: { verb: 'approve', projectId, version } };
    }
    case 'pause':
    case 'resume':
    case 'status': {
      if (parts.length !== 2) return { ok: false, error: usage };
      const projectId = parts[1];
      if (!PROJECT_ID_RE.test(projectId)) return { ok: false, error: `Bad projectId. ${usage}` };
      return { ok: true, cmd: { verb, projectId } as ParsedCommand };
    }
    case 'budget': {
      if (parts.length !== 3) return { ok: false, error: usage };
      const [, projectId, usdRaw] = parts;
      if (!PROJECT_ID_RE.test(projectId)) return { ok: false, error: `Bad projectId. ${usage}` };
      const usd = Number(usdRaw);
      if (!Number.isFinite(usd) || usd <= 0) {
        return { ok: false, error: `Budget must be a positive number of USD. ${usage}` };
      }
      return { ok: true, cmd: { verb: 'budget', projectId, usd } };
    }
  }
  return { ok: false, error: usage };
}

// ---------- Authz ----------

export type AuthzResult = { ok: true; binding: ChatBinding } | { ok: false; error: string };

/** Resolve a chat user to a teammate binding. Fail closed: unknown chat
 *  users get NOTHING (not even help), so a random group member can't probe. */
export function authorize(
  msg: Pick<InboundMessage, 'channel' | 'chatUserId'>,
  verb: string,
  bindings: ChatBinding[],
): AuthzResult {
  const binding = (bindings || []).find(
    (b) => b.channel === msg.channel && String(b.chatUserId) === String(msg.chatUserId),
  );
  if (!binding) {
    return { ok: false, error: 'Not authorized — no teammate binding for this chat user.' };
  }
  if (binding.allowedCommands && !binding.allowedCommands.includes(verb)) {
    return { ok: false, error: `'${verb}' is not in your allowed commands.` };
  }
  return { ok: true, binding };
}

// ---------- Execution (injected effects — no IO in this module) ----------

/** Store/roadmap side effects, injected by the registry wiring. Each maps
 *  to an EXISTING API write path (One Leash — same writes the UI does):
 *  - approveVersion → updateComponent { approvedVersions[] } (fires promote flow)
 *  - setLoopPaused  → full-field roadmap upsert with loopPaused
 *  - setBudget      → updateProject { budget } (validateBudget applies)
 */
export interface CommandEffects {
  approveVersion(projectId: string, version: string, by: string): Promise<string>;
  setLoopPaused(projectId: string, paused: boolean, by: string): Promise<string>;
  setBudget(projectId: string, ceilingUsdMonth: number, by: string): Promise<string>;
  getStatus(projectId: string): Promise<string>;
}

export async function executeCommand(
  cmd: ParsedCommand,
  binding: ChatBinding,
  effects: CommandEffects,
): Promise<InboundReply> {
  try {
    switch (cmd.verb) {
      case 'help': {
        const verbs = binding.allowedCommands?.length
          ? COMMAND_VERBS.filter((v) => binding.allowedCommands!.includes(v))
          : [...COMMAND_VERBS];
        return {
          ok: true,
          text: 'Commands:\n' + verbs.map((v) => `  ${USAGE[v]}`).join('\n'),
        };
      }
      case 'approve':
        return { ok: true, text: await effects.approveVersion(cmd.projectId, cmd.version, binding.teammate) };
      case 'pause':
        return { ok: true, text: await effects.setLoopPaused(cmd.projectId, true, binding.teammate) };
      case 'resume':
        return { ok: true, text: await effects.setLoopPaused(cmd.projectId, false, binding.teammate) };
      case 'budget':
        return { ok: true, text: await effects.setBudget(cmd.projectId, cmd.usd, binding.teammate) };
      case 'status':
        return { ok: true, text: await effects.getStatus(cmd.projectId) };
    }
  } catch (e: any) {
    return { ok: false, text: `Command failed: ${e?.message || e}` };
  }
  return { ok: false, text: 'Unhandled command.' };
}

/** Full inbound pipeline: parse → authz → execute. This is the handler
 *  adapters call; it is the ONLY inbound entry point. */
export async function handleInbound(
  msg: InboundMessage,
  bindings: ChatBinding[],
  effects: CommandEffects,
): Promise<InboundReply> {
  const parsed = parseCommand(msg.text);
  // Authz first for unparseable input too? No — parse errors leak nothing,
  // but authz errors must not reveal which commands exist. Order: parse
  // (generic errors), then authz (generic denial), then execute.
  if (!parsed.ok) {
    // Still require a binding before returning usage detail.
    const auth = authorize(msg, 'help', bindings);
    if (!auth.ok) return { ok: false, text: 'Not authorized.' };
    return { ok: false, text: parsed.error };
  }
  const auth = authorize(msg, parsed.cmd.verb, bindings);
  if (!auth.ok) return { ok: false, text: auth.error };
  return executeCommand(parsed.cmd, auth.binding, effects);
}
