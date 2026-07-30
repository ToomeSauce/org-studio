# Materialyze separation plan

- **Decision date:** 2026-07-16
- **Inventory date:** 2026-07-30
- **Source repository:** `ToomeSauce/org-studio`
- **Inventory baseline:** `16e9a58`
- **Status:** transfer blocked pending creation or authorization of a separate Materialyze repository

## Decision

Org Studio remains an MIT, self-hosted operating studio for named OpenClaw
and Hermes teams in trusted environments. The stateless software-delivery
prototype is a separate product, Materialyze.

Do not delete the prototype from Org Studio until its destination exists, the
relevant source and history have been transferred with required MIT notices,
and the equivalence checks below pass. Until then, avoid adding new Org Studio
features that depend on these transitional surfaces.

## Extraction inventory

| Capability | Primary source | Coupled surfaces to inspect |
|---|---|---|
| Worker runtime and configuration | `src/lib/workers/worker-runtime.ts`, `src/lib/workers/config.ts` | `src/lib/runtimes/registry.ts`, settings, scheduler, system UI |
| Direct coding engines | `src/lib/workers/engine-codex.ts`, `src/lib/workers/engine-openai-compat.ts` | worker runtime, examples, worker workflow |
| Ephemeral provisioning and GitHub runners | `src/lib/workers/provisioning.ts`, `src/lib/workers/github-app-auth.ts`, `.github/workflows/worker-job.yml` | worker configuration, scheduler, secrets documentation |
| Host policy and concurrency | `src/lib/workers/host-profile.ts`, `src/lib/workers/host-semaphore.ts` | generated worker context and settings |
| Stateless repository context | `src/lib/workers/repo-context.ts`, `src/lib/workers/context-assembler.ts` | `/api/projects/[id]/repo-context`, project fields, context UI |
| Frontier planner | `src/lib/workers/planner.ts` | store API planner actions, task materialization |
| Model-tier routing | `src/lib/model-tier.ts`, `src/lib/workers/route-tier.ts` | task schema, store API, scheduler, task/context UI |
| Worker receipts and scorecards | `src/lib/worker-pipeline-receipt.ts`, `src/lib/worker-scorecard.ts` | observability routes, system UI, weekly digest |
| Runtime-independent messaging | `src/lib/messaging/`, `src/lib/outbox.ts`, `lib/outbox.mjs` | outbox routes/worker, Slack and Telegram docs, scheduler and alerts |
| Prototype tooling | `scripts/worker-spike.mjs`, `docs/design/execution-workers.md`, `docs/examples/openai-compatible-worker.json` | tests and contributor documentation |

The corresponding tests under `src/__tests__/` and route-local test files are
part of each transfer. Search imports before removal; the list above identifies
the roots, not every dependent line.

## Concepts Org Studio retains

These remain independently implemented in Org Studio even if Materialyze has
a counterpart:

- Vision documents and outcome-bound roadmaps
- Human approval horizons and project start/stop controls
- Budgets, boundaries, dependencies, comments, and status history
- Named teammate domains, org memory, culture, coaching, and feedback
- Runtime health, activity, schedule diagnostics, and cost/delivery metrics
- OpenClaw and Hermes discovery, dispatch, and metadata integration

Shared product vocabulary does not justify a shared deployment, credential,
database, or security boundary.

## Transfer sequence

1. Establish the Materialyze repository, owner, license, and access policy.
2. Record Org Studio's source commit and copy or split the inventoried code
   while retaining its MIT copyright and license notices.
3. Adapt the copied code to Materialyze's least-privilege credential,
   isolation, tenant, persistence, and audit contracts.
4. Run the equivalence checks below in Materialyze and record evidence.
5. In a separate Org Studio pull request, remove transferred routes, UI,
   settings, schema fields, workflows, tests, and documentation.
6. Verify OpenClaw/Hermes onboarding, dispatch, vision, roadmap, board,
   approval, memory, and metrics flows after removal.
7. Publish migration notes for anyone using the experimental worker or
   runtime-independent messaging surfaces.

## Equivalence gates

Materialyze must demonstrate all of the following before Org Studio removal:

- Bounded jobs run through both direct-engine adapters with normalized events,
  timeouts, cancellation, and failure handling.
- Ephemeral provisioning has deterministic cleanup and least-privilege,
  short-lived credentials.
- Host policy, concurrency limits, repository context, and planner
  materialization have tests equal to or stronger than the transferred suite.
- Model-tier routing preserves explicit attribution of requested tier, chosen
  model, execution result, duration, and cost.
- Receipts are complete, immutable enough for their threat model, and
  queryable per project and job.
- Slack/Telegram commands authenticate, authorize, deduplicate, and enqueue
  without relying on an OpenClaw/Hermes runtime.
- Materialyze's CI passes its build, type, unit, integration, security, and
  license checks at the recorded transfer commit.
- An owner signs off on capability equivalence and on the Org Studio removal
  list.

## Current constraint

As of the inventory date, no repository with “Materialyze” in its name was
visible among repositories accessible to the ToomeSauce account. The transfer
and destructive cleanup phases therefore have not started. This document is
the boundary freeze and handoff checklist, not evidence that extraction is
complete.
