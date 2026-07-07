#!/usr/bin/env node
/**
 * worker-spike.mjs — W-1 spike (#1656, Execution Workers phase gate).
 *
 * Proves the rent-the-engine mechanic end-to-end on one toy ticket:
 *   1. Spawn `codex exec --json` headless against a checkout.
 *   2. Parse the JSONL event stream (item.completed: command_execution /
 *      file_change / agent_message; turn.completed: usage).
 *   3. Write a dispatch-ledger row + model-call row (same tables as #1641).
 *   4. Post a structured closeout comment on the ticket.
 *
 * NOT production code — this is the de-risk spike. The real WorkerRuntime
 * (W-2) turns this into an AgentRuntime implementation.
 *
 * Usage:
 *   FOUNDRY_API_KEY=... ORG_STUDIO_API_KEY=... DATABASE_URL=... \
 *   node scripts/worker-spike.mjs --repo /tmp/w1-toy --ticket 1656 \
 *     --brief "Fix the bug in greet.py so test_greet.py passes."
 *
 * Sandbox note (spike finding): codex's default bwrap/landlock sandbox
 * FAILS on this host (no unprivileged user namespaces). The spike runs with
 * --sandbox danger-full-access, acceptable ONLY because the caller controls
 * the checkout. Production workers get isolation from the ProvisioningAdapter
 * (container / Actions runner), not from the engine — this is by design
 * (see docs/design/execution-workers.md, security ladder).
 */
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';

const { values: args } = parseArgs({
  options: {
    repo: { type: 'string' },
    ticket: { type: 'string' },
    brief: { type: 'string' },
    model: { type: 'string', default: 'gpt-5.3-codex' },
    'org-studio': { type: 'string', default: 'http://localhost:4501' },
    'dry-run': { type: 'boolean', default: false },
  },
});

if (!args.repo || !args.brief) {
  console.error('Required: --repo <dir> --brief "<task>" [--ticket NNN]');
  process.exit(2);
}

// ── 1. Run the engine ─────────────────────────────────────────────────────

function runEngine() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'codex',
      ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'danger-full-access',
       '-m', args.model, args.brief],
      { cwd: args.repo, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 5 * 60 * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`engine exit ${code}: ${err.slice(-400)}`));
      resolve(out);
    });
  });
}

// ── 2. Parse the event stream ─────────────────────────────────────────────

function parseEvents(raw) {
  const events = raw.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  const commands = [];
  const fileChanges = [];
  const messages = [];
  let usage = null;

  for (const e of events) {
    if (e.type === 'item.completed') {
      const it = e.item || {};
      if (it.type === 'command_execution') {
        commands.push({ command: it.command, exitCode: it.exit_code });
      } else if (it.type === 'file_change') {
        for (const c of it.changes || []) fileChanges.push(c);
      } else if (it.type === 'agent_message') {
        messages.push(it.text || '');
      }
    } else if (e.type === 'turn.completed') {
      usage = e.usage || null;
    }
  }
  return { events, commands, fileChanges, messages, usage };
}

// ── 3. Ledger rows (same tables as src/lib/dispatch-ledger.ts #1641) ──────

async function writeLedger(dispatchId, parsed, durationMs) {
  if (!process.env.DATABASE_URL) {
    console.warn('[ledger] no DATABASE_URL — skipping');
    return false;
  }
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const fp = args.ticket ? `${args.ticket}:in-progress` : null;
    await pool.query(
      `INSERT INTO org_studio_dispatch_ledger
         (dispatch_id, agent_id, source, outcome, dispatched_at, completed_at,
          duration_ms, ticket_fingerprint, workspace_id)
       VALUES ($1,$2,$3,$4, NOW() - ($5::bigint * interval '1 millisecond'), NOW(),
               $5,$6,'default-workspace')`,
      [dispatchId, 'worker-codex', 'worker-spike', 'completed', durationMs, fp],
    );
    const u = parsed.usage || {};
    await pool.query(
      `INSERT INTO org_studio_dispatch_model_calls
         (dispatch_id, agent_id, model_requested, model_served, provider,
          tokens_in, tokens_out, cache_read_tokens, cost_estimate, workspace_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'default-workspace')`,
      [
        dispatchId, 'worker-codex', args.model, args.model, 'foundry-openai-responses',
        u.input_tokens ?? null, u.output_tokens ?? null, u.cached_input_tokens ?? null,
        0, // Foundry deployment: zero marginal cost; real impl uses estimateCost()
      ],
    );
    return true;
  } finally {
    await pool.end();
  }
}

// ── 4. Closeout comment ───────────────────────────────────────────────────

async function postCloseout(dispatchId, parsed, durationMs, ledgerOk) {
  if (!args.ticket || !process.env.ORG_STUDIO_API_KEY) return false;
  // resolve ticket id from number
  const store = await fetch(`${args['org-studio']}/api/store`, {
    headers: { Authorization: `Bearer ${process.env.ORG_STUDIO_API_KEY}` },
  }).then((r) => r.json());
  const task = (store.tasks || []).find((t) => String(t.ticketNumber) === String(args.ticket));
  if (!task) { console.warn('[closeout] ticket not found'); return false; }

  const u = parsed.usage || {};
  const cmds = parsed.commands.map((c) => `- \`${(c.command || '').slice(0, 90)}\` → exit ${c.exitCode}`).join('\n');
  const files = parsed.fileChanges.map((f) => `- ${f.kind}: ${f.path}`).join('\n') || '- (none)';
  const content = [
    `🤖 **Worker run** \`${dispatchId.slice(0, 8)}\` (engine: codex/${args.model}, ${Math.round(durationMs / 1000)}s)`,
    ``,
    `**Files changed:**\n${files}`,
    ``,
    `**Commands:**\n${cmds || '- (none)'}`,
    ``,
    `**Summary:** ${parsed.messages[parsed.messages.length - 1]?.slice(0, 500) || '(no final message)'}`,
    ``,
    `**Usage:** in ${u.input_tokens ?? '?'} (cached ${u.cached_input_tokens ?? '?'}) / out ${u.output_tokens ?? '?'} · ledger: ${ledgerOk ? '✅ recorded' : '⚠️ skipped'}`,
  ].join('\n');

  const r = await fetch(`${args['org-studio']}/api/store`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.ORG_STUDIO_API_KEY}`,
    },
    body: JSON.stringify({
      action: 'addComment',
      taskId: task.id,
      comment: { author: 'worker-codex', content, type: 'comment' },
    }),
  }).then((x) => x.json());
  return !!r.ok;
}

// ── main ──────────────────────────────────────────────────────────────────

const dispatchId = `wrk-${randomUUID()}`;
const t0 = Date.now();
console.log(`[spike] dispatch ${dispatchId} — engine starting in ${args.repo}`);
const raw = await runEngine();
const durationMs = Date.now() - t0;
const parsed = parseEvents(raw);
console.log(`[spike] engine done in ${Math.round(durationMs / 1000)}s — ` +
  `${parsed.commands.length} commands, ${parsed.fileChanges.length} file changes, usage:`, parsed.usage);

if (args['dry-run']) {
  console.log('[spike] dry-run — skipping ledger + comment');
  process.exit(0);
}
const ledgerOk = await writeLedger(dispatchId, parsed, durationMs).catch((e) => {
  console.error('[ledger] failed:', e.message); return false;
});
console.log(`[spike] ledger: ${ledgerOk}`);
const commentOk = await postCloseout(dispatchId, parsed, durationMs, ledgerOk).catch((e) => {
  console.error('[closeout] failed:', e.message); return false;
});
console.log(`[spike] closeout comment: ${commentOk}`);
