# Changelog

All notable changes to Org Studio. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is SemVer (pre-1.0 — minor bumps may include breaking changes).

## [0.4.0] — 2026-05-23

Three-week stabilization pass between 0.3.3 and 0.4.0 focused on **scheduler reliability**, **dispatch read-path performance**, **comment-storage hardening**, and **observability**. 30 commits across 5 themed clusters. No public-API breakages.

### Headline shifts

1. **Dispatch correctness is structurally solid.** Snapshot staleness eliminated at dispatch time (#1515), status_history writes are atomic (#1531), all 7 dispatch paths emit unified `[dispatch #1515]` telemetry (#1521), and every status-change writer routes through a single `buildStatusTransition()` helper (#1535). Inline @mention dispatch in `server.mjs` is gone (#1513) — only the durable Postgres-backed dedup + audit table fires.
2. **Scheduler hot path is ~3.5× thinner on the wire.** `PostgresStoreProvider.read()` is slim+parallel by default (#1520), the `case 'trigger'` decision path uses `readSlim()` only (#1529, 3.2MB → ~900KB, 619ms → 143ms p95), and `fireOneShot()` uses `readSlim()` + new targeted `getTasksForAgent()` (#1534). The wire footprint for cross-agent gate-signal evaluation is now indexed columns, not full-fat JSONB blobs.
3. **Comments are auditable.** Every comment write captures authentication-side metadata (`authMethod`, `userId`, `tokenId`, apiKey hash, IP, UA, requestedAuthor pre-canonicalization, capturedAt) and persists it server-side only (#1506). New admin endpoint to query the audit log (#1508). Defense-in-depth: `auditMeta` is stripped from every list/read response.
4. **`listComments` is a first-class read API.** New normalized `org_studio_comments` table backs `listComments` and bulk `listCommentsForTasks` (#1524). API now accepts agent-friendly `taskId` shorthand and returns an actionable error hint when the scope shape is wrong (#1536). Phase 2b/3 (stop inline `task.comments[]` write, drop the JSONB column) remain blocked on human sign-off — both are irreversible.

### Added

#### Reliability & correctness
- **Postgres-backed durable notification dedup + structured audit table** (#1513) — replaces in-memory dedup. Comment / mention / status notifications flow through the normalized path with recency suppression for stale-on-arrival events and latency logging.
- **Re-read store at dispatch time** (#1515) — eliminates snapshot staleness when the dispatcher fires; dispatch fingerprint narrowed to actionable buckets only.
- **Lease guard honors human/QA STOP comments** (#1492) — explicit STOP comment on an in-progress task pauses the lease until cleared.
- **Level-3 auto-bounce write reliability + activity-feed surfacing** (#1493).
- **Wake assignee on any non-in-progress → in-progress transition** (#1494) — closes a gap where dev was silently re-dispatched from `done`/`review` without a wake event.
- **`buildStatusTransition()` helper** (#1535) — every status-change writer (route handlers, scheduler, sweeper, blocker-clear, dispatcher) now routes through one pure helper that owns `statusHistory` append, `lastActivityAt` bump, `loopCount`/`loopPausedAt` reset, and claim-lease stamping on entering `in-progress`. Reduces the bug surface for the long tail of status-write paths.
- **`status_history` appended atomically with typed status flips** (#1531) — closes the race where a successful status update could lose its history entry on concurrent writes.

#### Performance
- **`PostgresStoreProvider.read()` slim+parallelize** (#1520) — 2.15× faster baseline read. `data` JSONB still included on overflow paths via #1520 follow-up so subscript indexing into custom fields keeps working.
- **`PostgresStoreProvider.readSlim()`** (#1529) — projection-narrow read for hot paths that don't need full task bodies; ships ~900KB instead of 3.2MB at workspace scale (1400 tasks, 8 agents).
- **`PostgresStoreProvider.getTasksForAgent(name, id)`** (#1534) — single targeted SELECT with full columns for one agent's non-archived tasks (`lower(assignee) IN (name, id)`). Used by `fireOneShot()` to ship full-fat blobs only for the agent being dispatched.
- **Request-scoped store-read memoization for `case 'trigger'`** (#1526) — collapse N read calls within the same request to 1.
- **Parallelize hydration query + prewarm pg pool at boot** (#1528).

#### Comments & audit
- **`auditMeta` on every comment write** (#1506) — `authMethod`, `userId`, `tokenId`, short apiKey hash, `requestIp`, `userAgent`, `requestedAuthor` (BEFORE canonicalization), `capturedAt`. Persisted server-side only; never returned to clients (route-layer `stripAuditMeta` defense-in-depth).
- **`GET /api/admin/comment-audit`** (#1508) — admin endpoint to query the audit log by `taskId`, `apiKeyHash`, time range, etc. Inner-auth 401 downgraded to uniform 403 `admin_required` to avoid leaking which keys are admin vs. valid-but-non-admin.
- **Bulk `listCommentsForTasks` + migrate evidence/signal detectors** (#1524) — Phase 2a. Detectors that previously scanned `task.comments[]` JSONB now hit the normalized table via a single bulk fetch.
- **`listComments` accepts `taskId` shorthand** (#1536) — agents can pass `{action:"listComments",taskId:"<id>"}`; the server auto-promotes to `{kind:"task",taskId}`. The 400 response now includes an `actionable hint` field explaining the expected shape (`"comment scope, not auth scope"`). Backward-compat: explicit `payload.scope` always wins.

#### Observability
- **Notification-health admin dashboard** (#1516) — visualizes dedup hit rate, notification latency, and per-agent delivery counters.
- **`[dispatch #1515]` telemetry hoisted inside `fireOneShot()`** (#1521) — all 7 dispatch entry points (cron tick, manual trigger, blocker-clear, etc.) now emit the same diagnostic line.

### Changed

- **Scheduler write path uses targeted per-row writes** (#1497) — `writeStore()` full-store-rewrite replaced with row-scoped `provider.updateTask()` / `provider.upsertProject()` calls. Eliminates a long-standing lost-write race on concurrent scheduler ticks.
- **`listComments` error message** (#1536) — was `{error:"Missing scope"}`; now includes `hint` explaining that this is a *comment scope*, not an *auth scope*, and pointing at the canonical shape. Error string unchanged for any caller pattern-matching on it.
- **Inner-auth response on admin endpoints** (#1508) — 401 with method-specific message → uniform 403 `{error:"admin_required"}`. Reduces enumeration risk.
- **Optimistic version-approval state** (PR #46) — UI now reverts optimistic state when the server rejects the write, instead of leaving the version in a phantom-approved state until refresh.

### Removed

- **Legacy inline @mention dispatch in `server.mjs`** (#1513) — the path that bypassed Postgres dedup and the audit table. Comments and mentions now route exclusively through the durable path.
- **Team Activity section from home page** (#1495 bug 3) — unused, occupied prime above-the-fold real estate.

### Fixed

- **Archived filter on context board showed zero results** (#1495 bug 1).
- **Top nav unpinned from viewport** (#1495 bug 2) — `h-screen` on a flex parent with unbounded body content broke `sticky top-0` on the nav.
- **Model badges missing on Billy/Thelma comments** (#1495 bug 4) — wrong port + auth wall in the badge fetch.
- **`.ts` import path in #1529 parity verifier** (#70ba554) — broke deploy-time typecheck.
- **`data` JSONB included in slim task SELECT** (#1520 follow-up) — restored overflow-read behavior for tasks that store custom fields in `data`.

### Skill (`org-studio-api`)

- **`listComments` documented for the first time** — Quick Reference table entry + canonical shape + `taskId` shorthand. Closes the agent-confusion root cause behind #1536 (the API existed; the skill never explained it, so agents pattern-matched the wrong shape from `addComment`).
- **`references/api-reference.md`** — new `POST /api/store — listComments` section with full request/response examples, both shapes, and the 400 hint.

### Notes

- Skill bundle (`skills/dist/org-studio-api.skill`) rebuilt via `npm run build:skill`. SHA sidecar captures `package_version=0.4.0`, `git_sha=<release-sha>`, `built_at`, `size_bytes`. Publishing to ClawHub still requires a human with publish credentials (#1466, blocked).
- Phase 2b (#1294, stop inline `task.comments[]` write in `addComment`) and Phase 3 (#1295, drop `org_studio_tasks.comments` JSONB column — **irreversible**) remain in `blocked`. Both await human sign-off on the migration cutover plan. The normalized `org_studio_comments` table is the live read path as of #1524; the inline JSONB write is now redundant.
- Single `git revert` rollback is still possible for any of the 30 commits in this release; the comments-migration tickets that aren't reversible (#1295) are explicitly held in `blocked` until they are individually approved.

## [0.3.3] — 2026-05-20

Docs-only follow-up to 0.3.2. Rewrites the `Local Environment: Host Constraints` section in `org-studio-api/SKILL.md` to remove operator-private specifics (host names, hardware details) that had landed in 0.3.2. The shared skill now describes only the **general pattern** — operators with specific constraints add details to their own `AGENTS.md` / workspace overlays.

### Changed

- **`Local Environment: Host Constraints`** in `SKILL.md` reduced to a generic, deployment-agnostic version. Same preferred validation workflow (targeted local checks, push, let CI build), but no hostnames or hardware caveats.
- **CHANGELOG** for 0.3.2 also reworded along the same lines.

### Notes

v0.3.2 git history and release notes still contain the original wording; this is a forward-only correction. The shared skill that agents read on session start is now scrubbed.

## [0.3.2] — 2026-05-20

Docs-only. Adds a general-purpose `Local Environment: Host Constraints` section to the `org-studio-api` skill.

### Added

- **`Local Environment: Host Constraints` section in `org-studio-api/SKILL.md`** — documents the general pattern for deployments where the operator restricts full local builds (thermal-limited or low-memory hosts), so agents reach for the preferred CI-driven validation workflow instead. Lives near the top of the skill so it's the second thing an agent reads after Event-Driven Triggers. Operators with specific host names / hardware caveats should add those details to their own `AGENTS.md` / workspace overlays rather than to the shared skill.

### Why

The pattern (targeted local checks, push, let CI build) is useful across many deployments; the specifics (which host has which constraint) are operator-private. The shared skill now covers the pattern only.

## [0.3.1] — 2026-05-20

Docs + release-tooling pass. No runtime changes.

### Added
- `org-studio-api` skill (`SKILL.md` + `references/api-reference.md`) now documents the #1461 work: `action: "create"` (strict, title-required, owner-inherited), `action: "patch"` (COALESCE-by-default, `items_mode: replace|merge`), `qa` / `gtm` `versionType` values, the single-current invariant, and the new `/api/admin/roadmap-audit` admin endpoint.
- `scripts/build-skill.sh` and `npm run build:skill` — repeatable build of `skills/dist/org-studio-api.skill` with a sidecar `org-studio-api.skill.sha` that captures `package_version`, `git_sha`, `built_at`, and `size_bytes`. The April-vintage stale zip is replaced.
- README "Publishing the `org-studio-api` skill" section — the release flow used to be tribal knowledge; it's now a recipe.

### Notes
- Package was already at 0.3.0 in `package.json` without a CHANGELOG entry. This release bumps to 0.3.1 with a docs-only diff; backfilling 0.3.0's history is tracked separately.
- Publishing the new bundle to ClawHub still requires a human with publish credentials.

## [0.3.0] — 2026-05-08

Three-day sprint between v0.2.0 and v0.3.0. **Headline shifts:**

1. **Outcome-bound versions** — roadmap versions can now declare a `successCriteria` + metric gate that blocks auto-completion until the metric is satisfied, even when every child ticket is `done`.
2. **Two-state project model** — `Active` / `Inactive` toggle replaces the multi-state launch flow; the old "Launch" button is gone.
3. **Postgres-only store** — `data/store.json` fallback removed; Postgres is the only persistence path (file mode is now offline/dev-only).
4. **Column-position is the canonical priority signal** — `task.priority` field removed; drag-to-reorder is the source of truth.

_This entry was backfilled retroactively in v0.3.1 (#1468); the original 0.3.0 release shipped without a CHANGELOG entry. See git log `397c4a6..1b956cf` for the source-of-truth commit history._

### Added

#### Roadmap & versions
- **Outcome-bound versions** (#1263, PR #33) — `successCriteria`, `metricTarget`, `metricCurrent`, `metricComparator` (`gte` | `lte` | `eq`), `loopPaused` fields on `version.meta`. Version won't auto-complete or auto-advance until `metricCurrent` satisfies the comparator. Caps: 5 concurrent in-progress tasks per outcome-bound version (`MAX_OPEN_EXPERIMENTS`), 3 agent-created spike tickets per UTC day (`MAX_AUTO_TASKS_PER_VERSION_PER_DAY`, returns `429` past cap). Defense-in-depth: project promotion re-checks the metric after the approval-horizon gate.
- **Rename version in place** (#1267, PR #32) — moves all child tickets to the new version string instead of duplicating the row.
- **Auto-mint stub vision doc + roadmap row on first launch** (#1229) — bootstrap when a brand-new project is activated.
- **Blocked deep-links** (#1266) — clickable blocker links across `/projects`, `/projects/[id]`, and `/context`.

#### UX & dispatch
- **Two-state project model** (`roto54a`) — `Active` / `Inactive` toggle; multi-state launch flow retired.
- **Vertical drag-and-drop within columns** (#1250) — dispatcher reads `sortOrder` so reorder actually affects pickup order.
- **`task.priority` field removed** (#1249) — column-position is canonical; high-priority is whatever's at the top.
- **`diagnoseAgentBacklog` exposed via `POST /api/scheduler action=diagnose`** (#1194, PR #31).
- **Auto-notify dev owner on every non-system ticket comment** (#1268) — comments now ping the assignee even if you don't `@`-mention.
- **Auto-resolve `sectionId` in `addTask` / `updateTask`** (#1269) — agents no longer need to pass the section explicitly.
- **Editable project metadata via settings slide-over** (#1281).

#### Infra & deploy
- **`npm run deploy`** (#1261) — single script: build → restart → health-check → print `BUILD_ID` + SHA. Boot-time `BUILD_ID` stamp in service logs (`[boot] org-studio dashboard live: BUILD_ID=... SHA=... branch=...`) — easy way to verify the running process matches `git rev-parse --short HEAD`.

### Changed

- **`approvedThrough` scalar dropped from type definitions** (#1224) — `approvedVersions[]` set is the sole source of truth (set-membership gate locked in by test #1222).
- **Project rename: `proj-mc` → `proj-org-studio`** (#1234), with `addTask` now rejecting unknown `projectId`.
- **Launch message** (#1230) — stale Telegram-proposal copy ripped out.
- **Bearer auth in `activity-status` curl examples** (#1251) — agent prompt corrected.
- **Notification envelope** (#1262) — assignee notifications now use the rich "reply on the task" format.
- **Dispatch-blocker UI labels** — aligned with #1224 per-version approval model.

### Fixed

- **`data/store.json` file fallbacks retired** (#1265) — every `safeRead(STORE_PATH)` in `server.mjs` replaced with `cachedStore`-only (or `null` + warn). Postgres outages now surface explicitly instead of silently serving stale data. Initial-startup `ORG.md` sync also routed through `refreshCachedStore()` (was reading STORE_PATH, fed stale ORG.md on every restart — latent bug fixed). Final archive at `data/backups/store-1265-final-archive-*.json`.
- **`/api/store` surfaces real error messages** (#1260) — was silently producing dead buttons.
- **Activate button** (#1253) — optimistic state + error toast + double-click guard; was double-firing on slow networks.
- **Orphan-blocked tasks** (#1235, #1254) — surfaced on project dashboard, rehome UI + project-scope opt-in.
- **Mobile task detail panel** (#1248) — x-jitter + project header overlap.
- **In-column rendering honors `sortOrder`** (#1250 fix) — drags were snapping back because render order ignored the sort.
- **Current version block** (#1276, #1280) — edit/delete buttons restored; owner picker added then refined through three followups (positioning, then label chip, then dropping the `qaOwner` slot in favour of `devOwner`-only — #1281 followup).
- **Backfill 6 historical tasks with `NULL ticketNumber`** (`okqrk04n`) — also added a guard against silent regression.
- **`ComponentFixture` type alignment with #1224 `approvedVersions[]`** — CI was failing on stale fixtures.

### Tests added

- `#1222` — `approvedVersions[]` set-membership gate for auto-promote.
- `#1246` — assignee auto-notification on every task comment.

### Docs

- **Outcome-bound versions documented** in skill, guide, README, and api-reference (#1263 docs commit `232b2ab`).

## [0.2.0] — 2026-05-05

First substantive release since v0.1.1. The headline shift is **per-component roadmaps**: every project can now have multiple Components (Main / QA / Frontend / Backend / etc.), each with its own version timeline, approval list, and dispatch gates. The legacy single-roadmap-per-project model is gone.

### Added

#### Per-component roadmaps (#1112, #1126)
- `Component` type with own `versions[]`, `owner`, `role`, and `approvedVersions[]`
- Stacked per-component roadmap UI on the project page, with component filter pills
- Per-component dispatch gating in the scheduler — each component's approvals govern its own tasks
- `version.owner` field with `getEffectiveOwner()` helper; assignee snapshot-on-create
- Sequential dispatch gate (a version can't dispatch until prior approved versions on the same component have shipped)
- Editable component owner + per-version owner UI

#### Approval model (#1188, #1212, #1224)
- **Per-version approval checkboxes** replace the draggable approval banner — non-contiguous approvals are now first-class
- `approvedVersions[]` (explicit set) is the sole source of truth for dispatch eligibility
- Legacy `approvedThrough` scalar and its contiguous-prefix semantics removed (#1224)
- Skipping an unapproved version no longer blocks a later approved one (#1212)
- "Approve & Start v…" CTA replaces dead-end disabled Start button

#### Dispatch & scheduler (#1100, #1102, #1138, #1180, #1183, #1184, #1204)
- Adhoc-task dispatch lane (followups/bugs without a roadmap version)
- Dispatch attempt logging + `diagnose-blocker` API (phase 1)
- Dispatch banner + per-ticket badge + Telegram escalate (phase 2+3)
- Auto-unblock fan-out on blocker completion
- Stall heuristic v2 — time-based + stale-claim aware
- Hard SINGLE-WIP gate at dispatch boundary (#1204)
- Watchdog stops re-dispatching dormant agents + only logs real restarts

#### Health & observability (#677, #678, #679, #861, #864, #982, #983)
- System Health page + `/api/health` endpoint
- Periodic roadmap reconcile cron + `/api/health/roadmap`
- Outbox + retries for gateway sends; agent loop heartbeat watchdog + `incidents` table
- Skill-install-ping instrumentation; ORG.md generator emits sha256 + timestamp
- Bootstrap-ping reports file SHAs at session start
- pubsub: heartbeat + auto-reconnect + health endpoint
- Vision doc GET/PUT structured logging
- Scheduler exposes in-flight state + sweep results
- Build SHA pill in sidebar

#### Workspaces & multi-tenancy (v0.16, #719)
- File-store workspace envelope with silent auto-migration
- Per-workspace auth, projects, teammates, threads isolation
- Workspace memberships seed script
- Login workspace cookie

#### UI / UX
- Projects page regrouping: **Blocked / Active / Inactive / Archived** (#1190)
- Home page cleanup — drop Mission, rename to Blockers + Active Projects (#25, #26)
- Home Blockers shows only user-owned blockers + agent blocker protocol (#1192)
- Project-page Components panel + board filter pills
- Studio Ledger editorial project page (cutover) (#1)
- Operations dashboard replaces default ledger view on project page (#11)
- Responsive Settings modal + TopBar user menu
- Telegram nudge to vision owner on version-shipped (#1191)
- Mobile horizontal-overflow fix (#12)

#### Data / migrations
- `project.state` field, `inFlightRunId` on tasks, `project-state.ts` util
- Atomic `ticketNumber` allocation via Postgres sequence (#863)
- Roadmap data hydration + QA collapse migration trio
- Backfill `roadmap_sort_order` to semver-aware keys
- Thrivor migration + test-project cleanup
- Semantic-versioning migration (0.141 → 0.14.1, drop `v` prefix)
- Auto-advance: trigger promote when approvedThrough changes; auto-stop when all approved work ships
- Roadmap-sync: keep embedded items in lockstep with rv-table; serialize concurrent item-done writes (#1181)

#### Comments / mentions
- Mentions exclude email addresses
- OpenClaw agents get mention text via `chat.send` (not just scheduler wake)
- Reliable @mention dispatch via `commentId` in NOTIFY
- Multi-human safe author resolution (#1218)
- Comment empty-body guard + auth-method-aware author resolver (#1217)

#### API hardening
- `updateTask` validates payload shape and returns 404 on missing id (#1195)
- Adhoc-lane version bypass closed + symmetric `updateTask` validator + audit script (#1211)
- `addTask`: auto-promote planning → backlog when task matches `currentVersion`
- `blocked` transitions require non-empty `blockedReason` (#1138 follow-up)

### Changed

- KISS board simplification: 5 columns (Planning / Backlog / In Progress / Review / Done); QA is a **component**, not a column. Review is opt-in only for irreversible or security-sensitive changes. Blocked is its own status.
- Telegram comms relay disabled by default; health-alerts moved to webhook
- Removed in-app chat/DM feature (workspace envelope made it obsolete)
- Sidebar cleanup — Settings/Logout moved out of sidebar
- Consolidated all promote-version paths into `promoteProjectToNextVersion`
- Scheduler prompt updated for KISS board

### Fixed

- Component-aware approval banner writes; Start button gate respects components
- Self-governed components bypass project-level dispatch gates correctly
- `waitsFor` target treats untagged legacy tasks as primary component
- Synthesize roadmap cards for QA/support components
- Hydrate `component.versions[]` from rv-table on read (close shadow-roadmap drift)
- Refresh non-primary component version fields from rv-table on store read
- NOTIFY `org_studio_change` on roadmap mutations so clients refresh
- Roadmap version edit hardened against undefined `item.title` / `version` fields
- Scheduler: blocked tasks are now visibility-only in dispatch (#1100)
- Store: bulk `write()` was nulling `version` column on every task; same bug in `createTask` — fixed
- Auto-advance: handle 0-item versions
- Vitest: 8 store-provider/store-logic failures repaired (#1145)
- Plus ~40 smaller guard / null-safety / UI polish fixes

### Removed

- Legacy `approvedThrough` scalar (project + component level) — fully gone, data migrated
- `role:qa` carve-out from dispatch gate (#1126 PR 6) — QA tickets go through the same path as everyone else
- Single-roadmap-per-project model — replaced by Components

### Migration notes

Existing deployments will auto-migrate on first boot:
- Project file stores wrap into a workspace envelope
- `approvedThrough` values backfill into `approvedVersions[]`
- Roadmap items get auto-minted ids and semver-aware `sort_order`
- Versions normalize to SemVer (e.g. `0.141` → `0.14.1`, `v` prefix dropped)

No manual action required for self-hosted instances.

---

## [0.1.1] — 2026-04-17

Last minor release before the per-component roadmap arc. See git log for details.

[0.2.0]: https://github.com/ToomeSauce/org-studio/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/ToomeSauce/org-studio/releases/tag/v0.1.1
