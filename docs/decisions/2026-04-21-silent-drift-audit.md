# Silent-Drift Audit — 2026-04-21

Spike from #864. #861 instrumented skill installs (skill-install-ping + freshness widget). This audit enumerates sibling pipelines that run silently and could drift without anyone noticing.

The class of bug: **a pipeline runs silently at session start (or on a timer), returns no error, but there's no way to tell if it actually delivered the right content.** When the pipeline drifts (stale cache, wrong version, partial run, no-op), agents behave on stale data and nobody notices until a human asks "why did you do X?" days later.

## Summary

| # | Vector | Recommendation | Est. effort |
|---|--------|---------------|-------------|
| 1 | ORG.md generator | **instrument** | S (1–2 hrs) |
| 2 | Vision doc fetching | **instrument** | S (1–2 hrs) |
| 3 | Principles / values propagation | **accept** | — |
| 4 | Scheduler dispatch (isInFlight / sweep) | **instrument** | M (3–4 hrs) |
| 5 | OpenClaw bootstrap files | **instrument** | M (half-day) |
| 6 | Skill content beyond org-studio | **instrument** | S (1 hr) |
| 7 | Postgres LISTEN/NOTIFY reliability | **instrument** | M (3–4 hrs) |
| 8 | Roadmap auto-advance | **instrument** | S (1–2 hrs) |

## Vectors

### 1. ORG.md generator

**What it is.** `src/lib/org-generator.ts` builds personalized ORG.md markdown from store data (mission, values, teammates, performance metrics, principles, coaching insights, sections). Served on-demand via `GET /api/org-context?agent=<id>` (`src/app/api/org-context/route.ts`). The generated content is then written to `~/.openclaw/workspace-<agent>/ORG.md` — but the write-to-disk step lives in OpenClaw Gateway internals, not in Org Studio's source tree.

**Current visibility.** Zero. No log when ORG.md is regenerated, no hash, no timestamp in the output. The file on disk has an mtime but nothing ties it to the data version it was built from.

**Drift failure modes.** (a) Store data changes (teammate removed, mission edited, section reassigned) but ORG.md on disk still has the old content — agent works from stale org context for hours. (b) The `/api/org-context` call fails silently (503 from store init, DB timeout) — the agent reads whatever was previously on disk. (c) Performance metrics fetch (`fetchMetrics`) returns `{}` on failure — ORG.md generates without the Performance section; no error surfaced.

**Recommendation: instrument.**
- Add a `generatedAt` timestamp and content SHA-256 hash to ORG.md output (as an HTML comment at the bottom, like `<!-- org-context sha=abc123 generated=2026-04-21T21:00:00Z -->`).
- Log at INFO level in `/api/org-context`: `[OrgContext] Generated for agent=${agentId} sha=${hash} sections=${count}`.
- Add a "Last ORG.md refresh" widget to Mission Control's agent detail panel (read the hash/timestamp from the file or the API response).

### 2. Vision doc fetching

**What it is.** `GET /api/vision/[id]/doc` (`src/app/api/vision/[id]/doc/route.ts`) serves a project's VISION.md from Postgres (primary) or filesystem (fallback). `PUT` saves changes, notifies agents via `rpc('chat.send')`, and comments "ORG.md re-sync" but actually doesn't trigger one.

**Current visibility.** A single `console.error` on Postgres failure, then silent fallback to filesystem. No log on successful reads. The PUT path fires best-effort `rpc('chat.send')` with `.catch(() => {})` — if the notification fails, nothing is logged.

**Drift failure modes.** (a) Postgres row exists with old content; filesystem has newer version (or vice versa) — dual-source divergence, no reconciliation. (b) Vision doc is updated via PUT, but `rpc('chat.send')` fails — the dev/QA agent keeps working from the old vision. (c) `parseRoadmapProgress` returns wrong counts from a malformed doc — auto-advance logic downstream acts on stale progress signals.

**Recommendation: instrument.**
- Log `[VisionDoc] GET project=${id} source=postgres|filesystem len=${bytes}` on every read.
- Log `[VisionDoc] PUT project=${id} saved_to=postgres|filesystem notify_agents=[ids] notify_ok=true|false`.
- On PUT, if `rpc('chat.send')` rejects, log at WARN (not swallow). Consider adding a retry or an outbox entry.

### 3. Principles / values propagation

**What it is.** `src/lib/principles-generator.ts` reads confirmed kudos/flags from Postgres (or `data/kudos.json` fallback) and generates `OperatingPrinciple[]` objects. These are injected into ORG.md by `org-generator.ts` when `/api/org-context` is called.

**Current visibility.** None — no logs, no counts. The generator returns `[]` on empty input and failures, which is indistinguishable from "no principles generated yet."

**Drift failure modes.** (a) A kudos is confirmed in the UI but the generator still returns empty because the DB read fails silently — the agent never sees the new principle. (b) Principles are generated but ORG.md itself is stale (see vector #1), so the principles never reach the agent.

**Recommendation: accept.** Principles are a secondary enrichment. If ORG.md drift (#1) is instrumented, stale principles will be caught by the same hash. The risk of principles alone drifting is low (confirmed kudos/flags are rare events). Instrumenting this independently isn't worth the effort — it rides on vector #1's instrumentation.

### 4. Scheduler dispatch (isInFlight / sweep)

**What it is.** The scheduler (`src/app/api/scheduler/route.ts`) dispatches work to agents via `fireOneShot` → outbox → `sendToAgent`. Concurrency is gated by an in-memory `isInFlight` marker (`src/lib/runtimes/scheduler-bridge.ts`). A sweep action iterates all enabled loops looking for orphaned backlog or stuck in-progress tasks.

**Current visibility.** Console logs (`[Dispatch] skipping`, `[InFlight] Cleared`) — but these are server-side only, not surfaced in any UI. The `lastTriggerByAgent` cooldown map and `inFlightAgents` set are in-memory and invisible to operators.

**Drift failure modes.** (a) `isInFlight` marker gets stuck (process restarts, safety timeout fires after 10 min but the actual agent completed earlier) — next dispatch is delayed by up to the cooldown or until a sweep runs. (b) Sweep silently no-ops because `hasActionableWork` returns false due to a stale store read or approval horizon miscalculation — work backlogs without visible failure. (c) The outbox `enqueueOutbox` call fails and the retry `setTimeout` fires in-process; if the Next.js process recycles before the retry, the dispatch is lost.

**Recommendation: instrument.**
- Expose `inFlightAgents` and `lastTriggerByAgent` in the `/api/health` endpoint or a new `/api/scheduler/status` endpoint.
- Log sweep results at INFO: `[Sweep] checked=${n} triggered=${m} reasons=[...]`.
- Add a "Dispatch Health" widget to the Scheduler page: last dispatch time per agent, current in-flight status, outbox depth.

### 5. OpenClaw bootstrap files

**What it is.** OpenClaw Gateway reads workspace files (`SOUL.md`, `USER.md`, `ORG.md`, `MEMORY.md`, `AGENTS.md`) from `~/.openclaw/workspace-<agent>/` at session start and injects them as project context. This is entirely on the OpenClaw side — Org Studio writes `ORG.md` via the `/api/org-context` endpoint but has no confirmation the agent actually received or read the latest bytes.

**Current visibility.** Zero from Org Studio's perspective. OpenClaw injects the files listed in the workspace config under `## Project Context`. There's no hash, no version, no callback. The `OPENCLAW_CACHE_BOUNDARY` marker in TOOLS.md is a hint the content is cached, but there's no API to invalidate or verify.

**Drift failure modes.** (a) ORG.md is regenerated by Org Studio but OpenClaw's cache boundary means the agent's session still has the old bytes — the agent reads stale context for the entire session. (b) SOUL.md or USER.md is edited manually but the agent's session was already started — changes don't take effect until next session. (c) Multiple agents share a workspace name collision — one agent's ORG.md overwrites another's.

**Recommendation: instrument.**
- At session start, have the org-studio skill's install command also POST a `bootstrap-ping` to Org Studio: `{ agentId, files: { "ORG.md": { sha, mtime }, "SOUL.md": { sha, mtime } } }`.
- Dashboard widget: "Bootstrap Freshness" — per-agent, per-file, show last-seen SHA vs current SHA on disk.
- This is a cross-project concern (OpenClaw + Org Studio) so the effort is higher. The skill-install-ping pattern from #861 is the template.

### 6. Skill content beyond org-studio

**What it is.** Agents install skills via `npx skills add`. The org-studio skill's install is now instrumented (#861) via `skill-install-ping`. But agents have other skills: `~/.openclaw/workspace-mikey/skills/org-studio-api/`, `~/.agents/skills/frontend-design/`, `~/.agents/skills/podcast-api/`, `~/.agents/skills/vercel-react-best-practices/`, `~/.agents/skills/web-design-guidelines/`. Each is a git repo clone that can be stale independently.

**Current visibility.** Only `org-studio` skill is pinged. The other skills have zero freshness tracking.

**Drift failure modes.** (a) A skill's repo is updated upstream but the local clone isn't refreshed — agent works from an old SKILL.md. (b) The `npx skills add` command is a no-op (already installed, git fetch fails silently) — agent thinks it's current. (c) A non-org-studio skill references an API that changed — the agent follows outdated instructions.

**Recommendation: instrument.**
- Generalize `skill-install-ping` to accept any skill name (it already does — the `skill` field is parameterized).
- Update ORG.md's install block to loop over all installed skills (or at least the critical ones) and ping each.
- Dashboard: extend the "Skill Freshness" widget to show all pinged skills, not just `org-studio`.

### 7. Postgres LISTEN/NOTIFY reliability

**What it is.** `src/lib/postgres-pubsub.ts` provides a pub/sub layer over Postgres `LISTEN/NOTIFY`. The `PostgresStoreProviderWithPubSub` wrapper (`src/lib/postgres-store-with-pubsub.ts`) emits NOTIFY on every CRUD operation. The listener connection is a dedicated `pg` client held open for the server lifetime.

**Current visibility.** `console.log` on subscribe/notify. `console.error` on parse failure. No reconnection logic. No health monitoring beyond a manual `health()` method that's never called on a schedule.

**Drift failure modes.** (a) The dedicated listener client dies (Postgres restart, idle timeout, network blip) — `isConnected` stays `true` but no notifications arrive. All downstream caches go stale with zero warning. (b) NOTIFY payloads exceed Postgres's 8KB limit for large store updates — the notification is silently truncated or dropped. (c) The global singleton `getGlobalPubSub()` is initialized once; if the first call fails, `globalPubSub` stays `null` and all subsequent PubSub operations silently no-op.

**Recommendation: instrument.**
- Add automatic reconnection with exponential backoff when the listener client emits `error` or `end` events.
- Add a periodic heartbeat (every 60s): publish a sentinel NOTIFY, verify the listener receives it within 5s. Log WARN on miss.
- Expose PubSub health in `/api/health`: `{ pubsub: { connected, lastHeartbeat, missedHeartbeats } }`.

### 8. Roadmap auto-advance

**What it is.** `src/lib/roadmap-sync.ts` — when a task moves to `done`, `syncRoadmapItemForTask` flips the matching roadmap item's `done` flag. When all items in the current version are done, `checkAndAutoAdvance` ships the version and promotes the next one (if within the approval horizon). `reconcileRoadmapItemDone` is a cross-check that can be called manually or via `/api/roadmap/reconcile`.

**Current visibility.** Console logs: `[RoadmapSync]`, `[VersionShip]`, `[AutoAdvance]`. These are server-side only — not surfaced in any UI. The reconcile endpoint returns summary counts but nobody polls it.

**Drift failure modes.** (a) A task is moved to `done` outside the store route (direct DB update, migration script) — `syncRoadmapItemForTask` is never called, roadmap items stay `done=false`, the version never ships. (b) `checkAndAutoAdvance` errors non-fatally (the entire function is wrapped in try/catch) — the version stays in `current` forever. (c) The `promoteProjectToNextVersion` call succeeds but the task-move-to-backlog loop fails partway — some tasks are moved, others aren't, and the partial state is committed. (d) The reconcile endpoint is never called automatically — historical drift accumulates silently.

**Recommendation: instrument.**
- Add a periodic reconcile cron (daily, low-cost) that calls `reconcileRoadmapItemDone()` for all projects and logs the summary.
- Surface reconcile results in Mission Control: "Roadmap Sync" widget showing `{ scanned, flipped, shipped, advanced, skippedAdvance }`.
- On auto-advance failure, emit a structured log entry (not just `console.error`) that can trigger an alert.

## Recommendation summary

**Instrument first (highest cost/benefit):**
1. **#7 Postgres LISTEN/NOTIFY** — if this dies, *every* real-time sync pathway goes dark. Adding reconnection + heartbeat prevents a wide class of silent failures. Medium effort but highest blast radius.
2. **#1 ORG.md generator** — agents read ORG.md at every session start. A content hash + timestamp is cheap and immediately verifiable. Small effort, high signal.
3. **#4 Scheduler dispatch** — the in-memory `isInFlight` marker is the single concurrency gate. Exposing it in a health endpoint prevents "why isn't my agent working?" investigations. Medium effort.
4. **#5 OpenClaw bootstrap files** — cross-project, higher effort, but closes the "did the agent actually see the latest bytes?" gap that no other instrumentation covers.

**Instrument second (good but lower urgency):**
5. **#2 Vision doc fetching** — dual-source risk is real but vision docs change infrequently. Small effort.
6. **#6 Skill content beyond org-studio** — generalizing the existing ping is trivial. Small effort.
7. **#8 Roadmap auto-advance** — add a reconcile cron and surface results. Small effort.

**Accept:**
- **#3 Principles / values propagation** — rides on ORG.md instrumentation. Low independent risk.

## New tickets to file

- `[org-studio] Instrument ORG.md generator with content hash + timestamp (#864-1)`
- `[org-studio] Add logging to vision doc GET/PUT and surface notification failures (#864-2)`
- `[org-studio] Expose scheduler in-flight state and sweep results in health endpoint (#864-3)`
- `[org-studio] Bootstrap-ping: agent reports file SHAs at session start (#864-4)`
- `[org-studio] Generalize skill-install-ping to all installed skills (#864-5)`
- `[org-studio] Postgres PubSub reconnection + heartbeat health check (#864-6)`
- `[org-studio] Add periodic roadmap reconcile cron + surface results in UI (#864-7)`
