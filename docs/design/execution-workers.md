# Execution Workers — sandboxed headless engines as a third runtime class

**Status:** Draft v1 · 2026-07-07 · Author: Mikey · Approved direction by Basil (Telegram thread 2026-07-07)

## Summary

Org Studio gains a third way to execute dispatched work, **additive** to the two
agent runtimes (OpenClaw, Hermes): an **Execution Worker** — an ephemeral,
sandboxed job that runs a *rented* headless coding engine (Codex CLI `codex exec`,
Claude Code `claude -p`) inside a shell that Org Studio owns end-to-end.

Positioning in one line: **power = their loop + our context assembly · safety =
HostProfile enforced at three layers · security = one provisioning knob from
local-process to enterprise sandbox.**

This is NOT a replacement for agent runtimes. OpenClaw/Hermes keep the
kitchen-sink assistant lane (channels, memory, browser, cron, orchestration).
Workers take the lane where those capabilities are overhead or a liability:
scoped, unattended, per-ticket code work.

## Why (decision record)

Debated 2026-07-07 (Basil ⇄ Mikey, four rounds of pressure-testing). Net:

1. **Never build the agentic loop ourselves.** The loop is the fastest-commoditizing
   category in software (OpenHands, SWE-agent, Aider, goose; Codex CLI itself is
   Apache-2.0). An in-house loop would be permanently worse than free incumbents.
   → We *rent* the engine as a swappable subprocess and own everything around it.
2. **Token consumption/control is immediate value.** A runtime dispatch drags the
   full assistant context (system prompt, memory, skills, channel state) before the
   ticket starts. A worker gets ticket brief + repo, nothing else. We already built
   the measurement rig (#1641 ledger, #1644 rollups, #1652–#1655 budget leash) —
   the dogfood can be scored with our own metrics.
3. **Enterprise security story.** The kitchen-sink capability surface
   (browser/messaging/exec/memory) is unauditable for enterprise review. A worker
   with an allowlisted toolset, ephemeral sandbox, no persistent memory, no
   channels, and every tool call in the ledger is a compliance story. This is a
   differentiator, not just cloud table stakes.
4. **Cloud adoption.** "First install OpenClaw" is a brutal SaaS onboarding
   barrier. Workers are the batteries-included execution path for cloud tenants.
5. **The pattern already exists informally.** OpenClaw agents spawn Codex-backed
   subagents for mechanical code work while the main loop orchestrates. Workers are
   that pattern with the kitchen sink removed, formalized, and metered.

Rejected along the way: building the loop natively (bad ROI, treadmill),
launching a standalone OSS engine project (crowded field), GitHub Copilot
subscription tokens as a backend provider (ToS gray area — spec Foundry/OpenAI/
Anthropic keys for anything customer-facing).

## Architecture

```
Dispatcher (existing #1515 paths, per-lane routing)
   │
   ▼
WorkerRuntime  ──────────────  implements AgentRuntime (discover/send/health/dispose)
   │                           registered in RuntimeRegistry next to openclaw/hermes
   ▼
JobOrchestrator
   ├── ContextAssembler        ticket brief + comments + repo conventions → workspace
   ├── ProvisioningAdapter     local-process | local-container | gh-actions | vm/e2b
   ├── EngineAdapter           codex exec | claude -p   (subprocess + JSON event stream)
   ├── HostProfileEnforcer     deny-commands, concurrency, cgroup caps, timeout
   └── LedgerSink              engine events → org_studio_dispatch_model_calls (#1641)
   │
   ▼
Results loop: branch pushed / PR opened → closeout comment on ticket → status move
```

### WorkerRuntime (AgentRuntime implementation)

Same interface the registry already speaks (`src/lib/runtimes/types.ts`). `send()`
enqueues a job instead of waking a session. Dispatch stays runtime-neutral —
the scheduler doesn't know or care that the assignee is a worker pool. A worker
"teammate" appears in settings like any other assignee (e.g. `worker-codex`),
so routing is just assignment — no new dispatch concept.

**Lane routing (v1):** allowlist by `taskType` + project. Dogfood starts with
`chore`/`bug` tickets on OSS repos only. Everything else stays on agent runtimes.

### EngineAdapter

- Spawns the engine headless: `codex exec --json -m <model> "<brief>"` or
  `claude -p --output-format stream-json "<brief>"`.
- Parses the structured event stream: tool calls, file edits, token usage,
  completion status.
- Engine is a **swappable commodity**. Adapter interface ~5 methods. If a better
  engine ships next quarter, we write one adapter.
- Model + reasoning-effort per ticket type is worker config — the "tunable token
  consumption" knob (e.g. `bug → gpt-5.3-codex/medium`, `chore → cheap/low`).

### ContextAssembler — where runtime-grade power comes from

The engines match or beat runtime loops on raw edit-run-check ability; the gap is
accumulated context. That knowledge mostly already lives in Org Studio:

| Source | Materialized as |
|---|---|
| Ticket (description/doneWhen/constraints) + full comment thread | job brief (prompt) |
| Repo conventions + HostProfile advisory | **generated `AGENTS.md` at checkout root** — both engines read it natively; same machinery as ORG.md generation |
| Prior attempts (handoffs, bounce comments) | brief appendix |
| Boundaries/leash (#1652/#1654) | brief appendix (leash-block renderer reused) |

Reverse direction is equally load-bearing: the shell parses what-was-tried /
what-failed from the event stream back into **ticket comments**, so the *org*
remembers instead of a runtime's private memory. Feeds Org Memory later.

### HostProfile — HOST.md as enforced config

Per execution target, stored in Org Studio settings:

```jsonc
{
  "id": "hanktank",
  "buildPolicy": "ci-only",            // ci-only | local-ok
  "verification": "dev-probe",         // dev-probe | full
  "denyCommands": ["next build", "vitest run (bare)", "tsc --noEmit (bare)", "eslint ."],
  "maxConcurrentJobs": 1,
  "cpuLimit": "50%", "memLimitMb": 4096, "timeoutMin": 30
}
```

Enforced at **three layers**, weakest→strongest:

1. **Advisory** — profile renders into generated AGENTS.md ("verify via targeted
   tests + push; CI runs the full build"). Same mechanism as HOST.md today, but
   auto-materialized per job.
2. **Engine hooks (hard block)** — Claude Code `PreToolUse` hooks can deny a
   command pre-execution; Codex CLI has configurable sandbox/approval policy.
   `denyCommands` compiles into these. A forbidden build doesn't run wrong —
   it doesn't run.
3. **OS backstop** — cgroup CPU/mem caps + hard timeout around the worker
   process; **dispatcher-enforced `maxConcurrentJobs` per host** (same pattern
   as existing per-agent dispatch serialization). This is an upgrade over today:
   HOST.md cannot stop two agents from building concurrently — a per-host
   semaphore can.

Shipped presets: `constrained-local` (the hanktank rules, promoted from prose to
config) and `remote-full`. OSS pitch: nobody else ships "host constraints as
enforced config" — lots of people run agents on thermally-limited minis.

### Security ladder (`execution.mode`)

| Mode | Isolation | Audience |
|---|---|---|
| `local-process` | none — trusted like a runtime | OSS quickstart, zero deps |
| `local-container` | Docker, shared kernel | cautious local default where Docker exists |
| `remote: gh-actions` | ephemeral runner | **our dogfood**; maps to existing lean-on-CI practice |
| `remote: vm / e2b` | full isolation + egress policy | cloud tenants, enterprise |

Same shell, ledger, and HostProfile enforcement in every mode — only the
provisioning adapter changes. A local worker is exactly as trusted as
OpenClaw/Hermes on the same box (explicitly conceded in the debate); the
ladder exists so cloud/enterprise can buy stronger isolation without a fork.

### Ledger & leash integration (already built, this week)

- Engine event streams carry token/cost per call → rows in
  `org_studio_dispatch_model_calls` with a real `dispatch_id`. Workers become our
  **cleanest metered lane** (vs. Hermes `unmeteredDispatches`).
- Budget gate (#1653) applies unchanged — workers hold at the ceiling like
  any dispatch. Boundaries injection (#1654) reuses the leash-block renderer.
- `/usage` (#1644) picks up worker spend with zero changes (attribution is by
  dispatch fingerprint, which workers get for free).

## Dogfood plan (pre-cloud, immediate)

- **Lane:** `chore`/`bug` tickets on `ToomeSauce/*` OSS repos only.
- **Where:** GitHub Actions runners (free tier) — NOT hanktank. Forces the
  remote-provisioning architecture cloud needs; keeps model-generated shell off
  the box that hosts Postgres + both runtimes; concurrency becomes safe.
- **Score with our own metrics:** cost/ticket, bounce rate, time-to-done —
  worker lane vs. runtime lane, straight from the ledger.
- **Human merge gate:** workers open PRs; they do not merge. (Agent runtimes
  keep their existing merge norms.)

## Non-goals

- Not building an agentic loop. Ever.
- Not deprecating or wrapping OpenClaw/Hermes — additive third option only.
- No auto-merge; no production deploys from workers.
- Not a general assistant: no channels, no cron, no persistent memory, no browser.
- Teams/Slack/Telegram native messaging is a **sibling track**, specced separately.

## Open questions

1. Engine order: Codex CLI first (Foundry keys on hand, zero-cost tokens) or
   Claude Code first (stronger hooks story)? Lean: Codex first, hooks parity later.
2. Secrets: per-repo deploy keys vs. GitHub App installation for checkout + PR.
   Lean: GitHub App (auditable, revocable, org-scoped).
3. Worker identity: one board teammate (`worker-codex`) vs. per-engine teammates.
   Lean: one per engine-config lane, so metrics separate cleanly.
4. Where HostProfile lives: settings JSONB (fast, reversible) vs. table.
   Lean: settings first, table when cloud multi-tenant needs it.

## Next steps

Roadmap: foundation version `2026.10.01 — Execution Workers (dogfood)` with
planning tickets W-1…W-7 (see roadmap items; each links a ticket). Phase gate:
W-1 spike proves the event-stream parse + ledger insert on a toy ticket before
the rest of the slate is approved past the horizon.
