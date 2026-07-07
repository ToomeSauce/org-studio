/**
 * ContextAssembler — job brief + generated AGENTS.md for worker jobs
 * (#1658, W-3 of Execution Workers).
 *
 * The engines (codex/claude-code) match runtime loops on raw edit-run-check
 * ability; the gap is accumulated org context. This module materializes
 * that context at dispatch time:
 *
 *   assembleBrief()          → the job prompt: ticket fields + full comment
 *                              thread + prior-attempt handoffs/bounces +
 *                              autonomy leash (#1654 renderer — REUSED, not
 *                              reimplemented; constraint on the ticket).
 *   generateWorkerAgentsMd() → AGENTS.md content for the checkout root:
 *                              repo conventions + host build advisory. Both
 *                              engines read AGENTS.md natively — this is the
 *                              same delivery mechanism as ORG.md generation,
 *                              purpose-built for a single job.
 *   extractAttemptSummary()  → reverse path: distill what-was-tried /
 *                              what-failed from the engine event stream into
 *                              a form that lands in ticket comments, so the
 *                              ORG remembers instead of a runtime's private
 *                              memory (design doc: ContextAssembler section).
 *
 * Everything here is PURE — data in, strings out. IO (fetching comments,
 * writing AGENTS.md, posting closeouts) lives in worker-runtime.ts behind
 * its injectable deps, which keeps all of this unit-testable.
 */
import { renderLeashBlock, type LeashProjectLike, type LeashSpendInfo } from '../leash-block';
import type { WorkerRunResult } from './engine-codex';

// ---------------------------------------------------------------------------
// Brief assembly
// ---------------------------------------------------------------------------

export interface BriefTask {
  id: string;
  ticketNumber?: number;
  title: string;
  description?: string;
  doneWhen?: string;
  constraints?: string;
  context?: string;
  status?: string;
  projectId?: string;
  version?: string;
  devHandoff?: { message: string; author: string; createdAt: number } | null;
}

export interface BriefComment {
  author?: string;
  content?: string;
  createdAt?: number;
  type?: string; // 'comment' | 'system'
}

export interface AssembleBriefOpts {
  /** The scheduler's dispatch message (passed through as the header). */
  dispatchMessage: string;
  task: BriefTask;
  /** Full comment thread, oldest-first. Empty array = no thread section. */
  comments?: BriefComment[];
  /** Owning project — for the leash block (#1654). */
  project?: LeashProjectLike | null;
  /** Live spend for the leash block; omit for static render. */
  spend?: LeashSpendInfo | null;
  /** Cap on comment-thread characters in the brief (default 6000). */
  maxThreadChars?: number;
}

const DEFAULT_MAX_THREAD_CHARS = 6000;

function fmtTime(ms?: number): string {
  if (!ms || !Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  } catch {
    return '';
  }
}

/**
 * Render the comment thread, oldest-first, newest guaranteed to survive
 * truncation (we trim from the OLD end — recent context is worth more).
 */
function renderThread(comments: BriefComment[], maxChars: number): string {
  const rendered = comments.map((c) => {
    const when = fmtTime(c.createdAt);
    const tag = c.type === 'system' ? ' [system]' : '';
    return `— ${c.author || 'unknown'}${tag}${when ? ` (${when})` : ''}:\n${(c.content || '').trim()}`;
  });
  // Trim oldest-first until it fits.
  let start = 0;
  const total = () => rendered.slice(start).join('\n\n').length;
  while (start < rendered.length - 1 && total() > maxChars) start++;
  const body = rendered.slice(start).join('\n\n');
  const omitted = start > 0 ? `(${start} older comment(s) omitted for length)\n\n` : '';
  return omitted + body;
}

/**
 * Prior attempts: devHandoff (explicit context injection from a blocker
 * resolution) + system bounce/reopen comments. Surfaced separately from
 * the thread because they're the highest-value "don't repeat this" signal.
 */
function renderPriorAttempts(task: BriefTask, comments: BriefComment[]): string {
  const parts: string[] = [];
  if (task.devHandoff?.message) {
    parts.push(
      `Handoff from ${task.devHandoff.author}${fmtTime(task.devHandoff.createdAt) ? ` (${fmtTime(task.devHandoff.createdAt)})` : ''}: ${task.devHandoff.message.trim()}`,
    );
  }
  const bounceMarkers = ['Reopened by', 'bounce', 'sent back', 'Worker run', 'failed'];
  for (const c of comments) {
    if (c.type !== 'system') continue;
    const content = c.content || '';
    if (bounceMarkers.some((m) => content.includes(m))) {
      parts.push(`${c.author || 'system'}: ${content.trim().slice(0, 500)}`);
    }
  }
  return parts.join('\n\n');
}

/** Assemble the full job brief (the engine prompt). */
export function assembleBrief(opts: AssembleBriefOpts): string {
  const { dispatchMessage, task } = opts;
  const comments = opts.comments || [];
  const maxThreadChars = opts.maxThreadChars ?? DEFAULT_MAX_THREAD_CHARS;

  const sections: string[] = [];

  sections.push(dispatchMessage.trim());

  sections.push(
    [
      `## Your ticket — #${task.ticketNumber ?? '?'}: ${task.title}`,
      task.description ? `\n${task.description.trim()}` : '',
      task.doneWhen ? `\n**Done when:** ${task.doneWhen.trim()}` : '',
      task.constraints ? `\n**Constraints:** ${task.constraints.trim()}` : '',
      task.context ? `\n**Context/prior art:** ${task.context.trim()}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );

  const prior = renderPriorAttempts(task, comments);
  if (prior) {
    sections.push(`## Prior attempts — do not repeat these\n\n${prior}`);
  }

  const visible = comments.filter((c) => (c.content || '').trim().length > 0);
  if (visible.length > 0) {
    sections.push(`## Ticket discussion (oldest first)\n\n${renderThread(visible, maxThreadChars)}`);
  }

  // Autonomy leash — REUSES the #1654 renderer verbatim. No parallel renderer.
  const leash = renderLeashBlock(opts.project, opts.spend ?? null);
  if (leash) sections.push(leash);

  sections.push(
    [
      `## Operating rules`,
      `- Make the changes in this repository. Read AGENTS.md at the repo root first — it carries the host build policy.`,
      `- Verify with targeted checks only (single-file tests / single-file typecheck). Do NOT run whole-project builds, full test suites, or full-repo lint/typecheck.`,
      `- Commit on the current branch with a descriptive message referencing #${task.ticketNumber ?? 'the ticket'}. Do NOT push.`,
      `- If you cannot complete the task, say clearly in your final message WHAT you tried and WHY it failed — that summary is written back to the ticket.`,
    ].join('\n'),
  );

  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// Generated AGENTS.md
// ---------------------------------------------------------------------------

export interface HostAdvisory {
  /** e.g. "ci-only" | "local-ok" — W-4 formalizes; free text advisory here. */
  buildPolicy?: string;
  /** Commands that must NOT run on this host. */
  denyCommands?: string[];
  /** Extra prose notes. */
  notes?: string;
}

export interface GenerateAgentsMdOpts {
  task: BriefTask;
  workerId: string;
  /** Repo conventions prose (per-project config; W-5 wires per-checkout). */
  repoConventions?: string;
  /** Host advisory — renders the build-policy section (W-4 hardens to hooks). */
  host?: HostAdvisory | null;
}

export const GENERATED_AGENTS_MD_MARKER = '<!-- generated by Org Studio ContextAssembler (#1658) — do not commit -->';

/**
 * AGENTS.md content for the checkout root. Both codex and claude-code read
 * AGENTS.md natively — this is the highest-leverage delivery channel for
 * repo conventions + host constraints (advisory layer 1 of the HostProfile
 * ladder; W-4 adds engine deny-hooks on top).
 */
export function generateWorkerAgentsMd(opts: GenerateAgentsMdOpts): string {
  const { task, workerId } = opts;
  const lines: string[] = [];
  lines.push(GENERATED_AGENTS_MD_MARKER);
  lines.push(`# AGENTS.md — worker job context (generated)`);
  lines.push('');
  lines.push(
    `You are \`${workerId}\`, an Org Studio execution worker on ticket #${task.ticketNumber ?? '?'}: ${task.title}.`,
  );
  lines.push('');

  if (opts.repoConventions?.trim()) {
    lines.push(`## Repo conventions`);
    lines.push('');
    lines.push(opts.repoConventions.trim());
    lines.push('');
  }

  lines.push(`## Host build policy${opts.host?.buildPolicy ? ` (${opts.host.buildPolicy})` : ''}`);
  lines.push('');
  lines.push(`- Targeted single-file checks ONLY (one test file, one-file typecheck, one-file lint).`);
  lines.push(`- NO whole-project builds, full test suites, full-repo typecheck/lint — CI runs those after push.`);
  const denies = (opts.host?.denyCommands || []).filter(Boolean);
  if (denies.length > 0) {
    lines.push(`- Forbidden on this host:`);
    for (const d of denies) lines.push(`  - \`${d}\``);
  }
  if (opts.host?.notes?.trim()) {
    lines.push('');
    lines.push(opts.host.notes.trim());
  }
  lines.push('');
  lines.push(`## Git`);
  lines.push('');
  lines.push(`- Commit on the current branch with a descriptive message referencing #${task.ticketNumber ?? 'the ticket'}.`);
  lines.push(`- Do NOT push. Do NOT commit this AGENTS.md file if it shows as modified — it is generated per-job.`);
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Reverse path: attempt summary from the engine event stream
// ---------------------------------------------------------------------------

export interface AttemptSummary {
  /** One-line outcome. */
  outcome: 'completed' | 'failed' | 'timeout';
  /** Files touched (from file_change events). */
  filesTouched: string[];
  /** Verification-looking commands with exit codes (tests/typecheck/lint/build probes). */
  verificationRuns: { command: string; exitCode: number | null }[];
  /** Commands that failed (non-zero exit) — the "what failed" signal. */
  failedCommands: { command: string; exitCode: number | null }[];
  /** Engine's final message (what it says it did / why it stopped). */
  finalMessage: string;
  /** Advisory errors from the stream. */
  errors: string[];
}

const VERIFICATION_PATTERNS = [
  /\bvitest\b/, /\bjest\b/, /\btsc\b/, /\beslint\b/, /\bnpm (run )?(test|lint|typecheck|check)\b/,
  /\bpytest\b/, /\bnext (build|lint)\b/, /\bcargo (test|check)\b/, /\bgo (test|vet)\b/,
];

/** Distill the run result into the structured pieces the closeout needs. */
export function extractAttemptSummary(res: WorkerRunResult): AttemptSummary {
  const timedOut = res.errors.some((e) => e.includes('timeout'));
  const verificationRuns = res.commands.filter((c) =>
    VERIFICATION_PATTERNS.some((p) => p.test(c.command)),
  );
  return {
    outcome: res.ok ? 'completed' : timedOut ? 'timeout' : 'failed',
    filesTouched: [...new Set(res.fileChanges.map((f) => `${f.kind}: ${f.path}`))],
    verificationRuns,
    failedCommands: res.commands.filter((c) => c.exitCode !== null && c.exitCode !== 0),
    finalMessage: res.messages[res.messages.length - 1] || '',
    errors: res.errors,
  };
}

/** Render the structured closeout comment (replaces the W-2 flat render). */
export function renderStructuredCloseout(args: {
  dispatchId: string;
  engineLabel: string; // e.g. "codex/gpt-5.3-codex"
  durationMs: number;
  summary: AttemptSummary;
  usage?: { inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null } | null;
}): string {
  const { summary: s } = args;
  const icon = s.outcome === 'completed' ? '✅' : s.outcome === 'timeout' ? '⏱️' : '⚠️';
  const lines: string[] = [];
  lines.push(
    `🤖 **Worker run** \`${args.dispatchId.slice(0, 12)}\` — ${args.engineLabel}, ` +
      `${Math.round(args.durationMs / 1000)}s, ${icon} ${s.outcome}`,
  );
  lines.push('');
  lines.push(`**Files touched:**`);
  lines.push(s.filesTouched.map((f) => `- ${f}`).join('\n') || '- (none)');
  lines.push('');
  lines.push(`**Verification run:**`);
  lines.push(
    s.verificationRuns
      .map((c) => `- \`${c.command.slice(0, 90)}\` → exit ${c.exitCode}`)
      .join('\n') || '- (none detected — flag for human review)',
  );
  if (s.failedCommands.length > 0) {
    lines.push('');
    lines.push(`**What failed:**`);
    lines.push(
      s.failedCommands
        .slice(0, 8)
        .map((c) => `- \`${c.command.slice(0, 90)}\` → exit ${c.exitCode}`)
        .join('\n'),
    );
  }
  lines.push('');
  lines.push(`**Engine summary:** ${s.finalMessage.slice(0, 800) || '(no final message)'}`);
  if (s.errors.length > 0) {
    lines.push('');
    lines.push(`**Warnings/errors:**`);
    lines.push(s.errors.map((e) => `- ${e.slice(0, 200)}`).join('\n'));
  }
  if (args.usage) {
    const u = args.usage;
    lines.push('');
    lines.push(
      `**Usage:** in ${u.inputTokens ?? '?'} (cached ${u.cachedInputTokens ?? '?'}) / out ${u.outputTokens ?? '?'}`,
    );
  }
  return lines.join('\n');
}
