# #1387 Slice A — Locked Decisions

Date: 2026-05-18
Author: Mikey (with Basil sign-off via #1383 comment thread)
Status: **LOCKED.** These decisions drive the foundation refactor. Do not relitigate during implementation.

## Context

Audit `1387-multitenant-audit.md` found ~18 HIGH-risk gaps in multi-tenant query coverage. The foundation gap (`getStoreProvider()` pinned to `'default-workspace'`) blocks all other fixes from being meaningful. This doc captures the design decisions that govern the foundation refactor (slice A code-only) and the deferred schema migrations (separate ticket).

## Locked decisions

### 1. `getStoreProvider()` becomes per-request

**Decision:** Signature changes from `getStoreProvider()` → `getStoreProvider(workspaceId: string)`. All 95 callsites pass their resolved workspace_id (from `resolveWorkspaceContext(req, userId)`).

**Escape hatch:** Genuinely cross-workspace callers (admin endpoints, principles-generator) call `getStoreProviderAllWorkspaces()` — a deliberate, named function. No silent cross-workspace reads.

**Rationale:** Audit finding #1 — the singleton pinned to `default-workspace` makes every downstream fix cosmetic. Fixing this first unlocks everything.

### 2. `cachedStore` becomes per-workspace `Map<workspaceId, Store>`

**Decision:** `server.mjs` `cachedStore` migrates from `let cachedStore = null` to `const cachedStoreByWorkspace = new Map<string, Store>()`. Lazy-populated per workspace on first read. Invalidated on workspace-scoped LISTEN events (or, if NOTIFY remains global, the relevant workspace's Map entry clears on every event).

**WS broadcasts:** Outbound WS messages are scoped — each connected client's session resolves to a workspace_id; broadcasts go only to clients in the matching workspace.

**Rationale:** Audit finding #2 — global cache leaks default-workspace data to all clients in cloud mode. Per-workspace Map is the surgical fix; removing the cache entirely (every read hits Postgres) was an alternative but adds latency for OSS and high-traffic dashboards.

### 3. OSS mode unchanged (zero regression risk)

**Decision:** When `DATABASE_URL` is unset, the Map has one entry, the workspace_id is the string `'default-workspace'`, every code path behaves identically to today's OSS deployment.

**Rationale:** OSS path must stay first-class. Single-user, single-workspace, file-store → identical behavior pre- and post-refactor.

### 4. Anonymous `/api/store` GET — gated in cloud mode

**Decision:** Anonymous GET stays available when `DATABASE_URL` is unset (OSS-localhost). In cloud mode, anonymous GET returns 401 unless `ALLOW_ANONYMOUS_READS=true` env override is set (transition aid). Authenticated GET (session cookie OR workspace-scoped API token) always works.

**Rationale:** Audit § 6 product question — cloud mode serving default-workspace data anonymously is a real data-leak risk; OSS-localhost it's fine.

### 5. Multi-workspace login UX — selector dropdown

**Decision:** When a user belongs to multiple workspaces, login flow shows a workspace selector after credential validation. Session cookie stores `{ userId, workspaceId }`. User can switch active workspace via existing `POST /api/workspaces` endpoint.

**Single-workspace users:** No UI change. Their one workspace becomes the session workspace automatically.

**Subdomain routing** (`acme.orgstudio.dev`) is explicitly OUT of slice A — v2 concern.

**Rationale:** Audit § 6 — multi-tenant auth needs a workspace selection mechanism. Selector dropdown is the lowest-friction option; subdomain routing is the right long-term answer but requires DNS + cert plumbing.

### 6. System-global tables get workspace_id

**Decision:** Add `workspace_id` column to:
- `org_studio_bootstrap_pings`
- `org_studio_dispatch_attempts`
- `org_studio_skill_installs`
- `org_studio_watchdog_pauses`

Backfill existing rows to `'default-workspace'`. All queries filtered.

**Rationale:** Agents belong to workspaces. Acme's agent crash-ping shouldn't show in Beta's dashboard. Defaulting to system-global was an oversight, not a design.

**Deferred to:** Schema migration ticket (separate from slice A code refactor).

### 7. `org_studio_comments` gets workspace_id

**Decision:** Add `workspace_id` column with NOT NULL constraint. Backfill existing rows to `'default-workspace'`. Update INSERT + both SELECTs in `store-provider.ts` (lines 943, 1044, 1081) to filter.

**Interim (slice A code-only):** Until the column is added, the app derives workspace from the parent task/project of each comment via JOIN. Slower but safe.

**Rationale:** Audit finding #3 — `scope_key` collision across workspaces is a real bug. Even with one workspace today, the moment a second is added, comments cross-contaminate.

**Deferred to:** Schema migration ticket.

### 8. `ON CONFLICT` keys fixed for agent_metrics, settings, heartbeats

**Decision:** Migration adds `workspace_id` to the conflict columns:
- `org_studio_agent_metrics`: was `(agent_id, date, section_id)`, becomes `(workspace_id, agent_id, date, section_id)`
- `org_studio_settings`: was `(id)`, becomes `(workspace_id, id)`
- `org_studio_heartbeats`: was `(agent_id)`, becomes `(workspace_id, agent_id)`

**Pre-flight check:** Scan existing rows for cross-workspace collisions on the old keys. With one workspace today, expected collision count = 0. Documented empirically before migration runs.

**Rationale:** Audit findings #4 + #5 — cross-workspace rows overwrite each other silently. With only `default-workspace` data today, this is latent, not active — but it activates the instant we add a second workspace.

**Deferred to:** Schema migration ticket.

### 9. Vision cron + outbox worker — single cron, per-workspace ticks

**Decision:** One cron schedule. Each tick iterates over all workspaces and processes per-workspace work. No N cron schedulers.

**Rationale:** Matches existing scheduler pattern. Adding N crons adds N processes to monitor for zero functional gain.

### 10. `principles-generator.ts` — per-workspace

**Decision:** Filtered per-workspace. Each workspace gets its own principles derived from its own kudos. No cross-workspace aggregation.

**Rationale:** Acme's team should not inherit Beta's principles. Principles are a workspace artifact, not a global one.

## Implementation order

**Slice A (this ticket, code-only, reversible, → ships to `done`):**

1. Extend `scripts/test-workspace-isolation.mjs` to cover all 15 tables (currently only 2). Tests must pass against current code before refactor (establishes baseline).
2. Refactor `getStoreProvider()` to `getStoreProvider(workspaceId)`. Add `getStoreProviderAllWorkspaces()` escape hatch. Update all 95 callsites. Build green + isolation tests pass.
3. Refactor `cachedStore` to per-workspace Map. Refactor WS broadcasts to scope by workspace. Build green + isolation tests pass.
4. Remove hardcoded `'default-workspace'` constants from: `outbox.ts:65`, `heartbeats.ts:52`, `vision-cron.ts:99,116`, `scheduler/status/route.ts:50`, `server.mjs:2351`, `auth.ts:111,186`, `roadmap/[projectId]/route.ts:718,743`, `roadmap/[projectId]/versions/[version]/items/route.ts:59,68`. Replace with `resolveWorkspaceContext()`-derived values.
5. Anonymous `/api/store` GET gating in cloud mode. Env flag respected.
6. Multi-workspace login selector. Session cookie carries workspaceId.
7. `principles-generator.ts` per-workspace filter.
8. For `org_studio_comments` and the 4 system-global tables (which lack workspace_id columns until migrations land), implement code-level workarounds: derive workspace via JOIN where possible; for tables with no parent-key path, accept current cross-workspace behavior and flag in a TODO until the migration ticket lands.
9. Squash-merge to main, `npm run deploy`, post deploy summary.

**Slice A-migration (separate ticket, irreversible, → goes through Review):**

1. Add `workspace_id` to `comments`, `bootstrap_pings`, `dispatch_attempts`, `skill_installs`, `watchdog_pauses`. Backfill to `default-workspace`. Update queries to filter.
2. Fix `ON CONFLICT` keys on `agent_metrics`, `settings`, `heartbeats`. Pre-flight collision check.
3. Remove the slice A code-level workarounds.
4. Squash-merge to main via PR, Review checkpoint with Basil, then deploy.

## Out of scope for slice A (deliberately)

- Signup + invites + email verification (slice D, separate ticket)
- Workspace creation UI (slice C, separate ticket)
- Admin re-gate to workspace owner/admin role (slice B, separate ticket)
- Per-agent API tokens enable rollout (#1383, separate ticket)
- Subdomain-based workspace routing (v2)
- Workspace soft-delete (`done when` (a) constraint, but not slice A)

## Reversibility classification

- Slice A code refactor: **fully reversible** (`git revert <sha>` + `npm run deploy`). Ships to `done`.
- Slice A-migration schema changes: **partially reversible** (column adds are reversible, ON CONFLICT key changes require careful rollback). Ships through `review`.
