# #1387 Slice A — Multi-tenant Audit

Date: 2026-05-18
Auditor: Mikey (via Codex subagent)
Scope: Inventory workspace_id filter coverage across Postgres queries, file-store accesses, and the cachedStore. Identify gaps that could cause cross-workspace data leaks. **No fixes applied in this report.**

## Executive summary

- Total Postgres query callsites audited: **185** across **25 files** (src/ only; skipped tests + scripts/)
- HIGH-risk gaps (mutation/read without workspace_id filter, against tables that HAVE the column): **~18 distinct callsites** (see section 1)
- MED-risk gaps (cross-workspace reads on monitoring/global-ish data): **~6**
- ⚠️ Needs-human-review: **~8** (mostly “is this table meant to be workspace-scoped?” questions)
- File-store callsites audited: file-store only exposes the **active workspace slice** — see section 2
- File-store HIGH-risk gaps: **0 leaks**, but **1 architectural gap** (no per-request workspace selection — `activeWorkspace` is a single global field)
- cachedStore: **HIGH risk in multi-workspace cloud mode.** It is a single global blob fetched with no auth context, scoped to `default-workspace` only, then broadcast to every WS client regardless of which workspace they belong to. In OSS-single-workspace mode this is fine; in cloud mode it both leaks default-workspace data and starves every other workspace.
- Existing isolation test coverage: `scripts/test-workspace-isolation.mjs` only exercises `org_studio_projects` and `org_studio_tasks`. It does not touch `roadmap_versions`, `vision_docs`, `comments`, `kudos`, `agent_metrics`, `outbox`, `heartbeats`, `sessions`, `api_tokens`, or `settings`. No `*.test.ts` covers workspace isolation at the SQL layer.

**Recommended fix priority order:**

1. **FOUNDATION FIX FIRST** — `getStoreProvider()` singleton is permanently pinned to `'default-workspace'`. 95 callsites use it. Until this is plumbed per-request, every other store-provider fix is cosmetic.
2. **cachedStore + refreshCachedStore + WS broadcast** — global cache → must become per-workspace or be removed from the cloud path.
3. **store-provider.ts `addComment` + `listComments` + `agent_metrics` triad** — comments table has no `workspace_id` column at all; `UPDATE org_studio_tasks` inside addComment is missing the filter; `agent_metrics` upsert/select/aggregate is unfiltered. These are the noisiest call paths.
4. **Hardcoded `'default-workspace'` constants** in: `outbox.ts:65`, `heartbeats.ts:52`, `vision-cron.ts:99,116`, `scheduler/status/route.ts:50`, `server.mjs:2351`, `auth.ts:111,186`, `roadmap/[projectId]/route.ts:718,743`, `roadmap/[projectId]/versions/[version]/items/route.ts:59,68`. Each one already has a TODO comment in most cases.
5. **`principles-generator.ts`** — reads ALL kudos cross-workspace to compute team principles. Either filter or document as “intentionally cross-workspace.”
6. **`/api/health` + `pause-watchdog` + `dispatch-attempts` + `skill-installs` + `bootstrap-pings`** — agent-global tables (no workspace_id column). Either add workspace_id to the schema or document as “system-global, intentionally cross-workspace.”
7. **Test coverage** — extend `scripts/test-workspace-isolation.mjs` to cover the additional tables; add Jest-level tests for the store-provider methods.

---

## 1. Postgres query inventory

**Legend:**
- workspace_id filter? — ✅ filtered, ❌ MISSING, N/A (table has no workspace_id), ⚠️ derived/hardcoded/needs review
- Risk — HIGH (write or read that can leak/collide across workspaces), MED (monitoring/metadata read), LOW (admin/global)

### 1.1 Table → has-workspace-id matrix (derived from migration scripts + table-create code)

| Table | workspace_id? | Source |
|---|---|---|
| org_studio_projects | ✅ YES | migrate-workspace-id.mjs |
| org_studio_tasks | ✅ YES | migrate-workspace-id.mjs |
| org_studio_workspace_memberships | ✅ YES (composite PK) | migrate-workspace-id.mjs |
| org_studio_roadmap_versions | ✅ YES | phase2 |
| org_studio_vision_docs | ✅ YES | phase2 |
| org_studio_agent_metrics | ✅ YES | phase2 |
| org_studio_kudos | ✅ YES | phase2 |
| org_studio_outbox | ✅ YES | phase2 |
| org_studio_heartbeats | ✅ YES | phase2 |
| org_studio_incidents | ✅ YES | phase2 |
| org_studio_settings | ✅ YES | phase2 |
| org_studio_sessions | ✅ YES | phase2 |
| org_studio_api_tokens | ✅ YES | migrate-api-tokens-table.js |
| org_studio_workspaces | N/A (is itself the workspace registry) | — |
| org_studio_bootstrap_pings | ❌ NO COLUMN | src/lib/bootstrap-pings.ts CREATE |
| org_studio_dispatch_attempts | ❌ NO COLUMN | src/lib/dispatch-attempts.ts CREATE |
| org_studio_skill_installs | ❌ NO COLUMN | src/lib/skill-installs.ts CREATE |
| org_studio_watchdog_pauses | ❌ NO COLUMN | src/app/api/scheduler/pause-watchdog/route.ts CREATE |
| org_studio_comments | ❌ NO COLUMN | scripts/migrate-comments-table.js |
| org_studio_ticket_number_seq | N/A (global sequence) | — |

The five **❌ NO COLUMN** tables are an **open architectural question for human review** — schema doesn't even support workspace scoping yet. See section 6.

### 1.2 Per-callsite inventory

| # | File:line | SQL summary | Table | workspace_id filter? | Risk | Notes |
|---|---|---|---|---|---|---|
| 1 | src/app/api/admin/migrate-roadmap/route.ts:51,78,90,105,118 | CREATE/ALTER schema bootstrap | n/a | N/A | LOW | DDL, admin-only |
| 2 | src/app/api/admin/migrate-roadmap/route.ts:141 | SELECT id, project_id, content FROM org_studio_vision_docs WHERE content IS NOT NULL | vision_docs | ❌ MISSING | MED | Admin migration script; reads ALL workspaces' vision docs to migrate. Probably intentional (one-shot admin endpoint) — ⚠️ document. |
| 3 | src/app/api/admin/migrate-roadmap/route.ts:184 | INSERT INTO org_studio_roadmap_versions ... | roadmap_versions | ⚠️ derived | MED | Inherits workspace from source row in #2; flag for review with #2. |
| 4 | src/app/api/health/route.ts:39 | SELECT FROM org_studio_heartbeats WHERE last_heartbeat < NOW() - INTERVAL '5 minutes' | heartbeats | ❌ MISSING | MED | Health monitor — may be intentionally global, but cross-workspace cloud setup will see other tenants' stuck agents in the response. ⚠️ scope: caller-only or all-workspaces? |
| 5 | src/app/api/health/route.ts:55 | SELECT id,timestamp,type,agent_id,message FROM org_studio_incidents ORDER BY timestamp DESC LIMIT 50 | incidents | ❌ MISSING | MED | Same as #4. |
| 6 | src/app/api/health/route.ts:76 | SELECT 1 | — | N/A | LOW | Liveness probe |
| 7 | src/app/api/kudos/route.ts:67 | SELECT ... FROM org_studio_kudos WHERE workspace_id = $1 ORDER BY created_at DESC | kudos | ✅ filtered | — | But: param is `'default-workspace'` hardcoded one-line over (line 72-ish). Verify it accepts request-scope. |
| 8 | src/app/api/kudos/route.ts:97 | INSERT INTO org_studio_kudos (..., workspace_id) | kudos | ⚠️ check param | HIGH | Verify the workspace_id param is request-derived not hardcoded. |
| 9 | src/app/api/kudos/route.ts:193 | DELETE FROM org_studio_kudos WHERE id = $1 AND workspace_id = $2 | kudos | ⚠️ hardcoded | HIGH | Second arg is literal `'default-workspace'` — confirmed at the callsite. |
| 10 | src/app/api/kudos/route.ts:230 | UPDATE org_studio_kudos SET note=$1, value_tags=$2 WHERE id = $3 AND workspace_id = $4 | kudos | ⚠️ check param | HIGH | Same — confirm $4 isn't hardcoded. |
| 11 | src/app/api/roadmap/[projectId]/route.ts:66 | SELECT FROM org_studio_roadmap_versions WHERE project_id=$1 AND workspace_id=$2 | roadmap_versions | ✅ filtered | — | Good. |
| 12 | src/app/api/roadmap/[projectId]/route.ts:261-383 | BEGIN/SELECT/UPDATE/COMMIT roadmap_versions, tasks, projects rename txn | roadmap_versions / tasks / projects | ✅ filtered (all four) | — | All four queries inside the txn carry workspace_id. Good. |
| 13 | src/app/api/roadmap/[projectId]/route.ts:524 | INSERT INTO org_studio_roadmap_versions (...workspace_id...) | roadmap_versions | ✅ stamped | — | Good (uses the resolved workspace). |
| 14 | src/app/api/roadmap/[projectId]/route.ts:637 | DELETE FROM org_studio_roadmap_versions WHERE project_id=$1 AND version=$2 AND workspace_id=$3 | roadmap_versions | ✅ filtered | — | Good. |
| 15 | src/app/api/roadmap/[projectId]/route.ts:662 | UPDATE org_studio_roadmap_versions SET sort_order=$1 WHERE ... AND workspace_id=$4 | roadmap_versions | ✅ filtered | — | Good. |
| 16 | src/app/api/roadmap/[projectId]/route.ts:718 | (object literal stamped with) workspace_id: 'default-workspace' | roadmap_versions | ⚠️ HARDCODED | HIGH | Insert path stamps the literal string. Verify whether `payload.workspace_id` is unwrapped from request context above. |
| 17 | src/app/api/roadmap/[projectId]/route.ts:743 | Same as #16, second branch | roadmap_versions | ⚠️ HARDCODED | HIGH | Same issue. |
| 18 | src/app/api/roadmap/[projectId]/versions/[version]/items/route.ts:59,68 | Object literals with workspace_id: WORKSPACE_ID | roadmap_versions / projects | ⚠️ HARDCODED | HIGH | `WORKSPACE_ID` is a module-level constant (= 'default-workspace'). Used in `pg_notify` payload — anything that consumes the notify sees the literal. |
| 19 | src/app/api/roadmap/[projectId]/versions/[version]/items/route.ts:160-291 | BEGIN/SELECT-FOR-UPDATE/UPDATE roadmap_versions items txn | roadmap_versions | ✅ filtered | — | Good — all four queries carry workspace_id. |
| 20 | src/app/api/scheduler/pause-watchdog/route.ts:50 | CREATE TABLE org_studio_watchdog_pauses | watchdog_pauses | N/A (no col) | LOW | DDL |
| 21 | src/app/api/scheduler/pause-watchdog/route.ts:82,93,121,123 | INSERT/DELETE/SELECT on org_studio_watchdog_pauses by agent_id | watchdog_pauses | ❌ NO COLUMN | ⚠️ MED | Table has no workspace_id. Two agents in different workspaces with same agent_id will collide. See §6. |
| 22 | src/app/api/scheduler/status/route.ts:50 | SELECT status, COUNT(*) FROM org_studio_outbox WHERE workspace_id = $1 GROUP BY status | outbox | ⚠️ HARDCODED | HIGH | Param is literal `'default-workspace'`. Scheduler status will not reflect other-workspace outbox depth. |
| 23 | src/app/api/store/route.ts:630, 881 | SELECT id, items FROM org_studio_roadmap_versions WHERE project_id=$1 AND version=$2 AND workspace_id=$3 | roadmap_versions | ✅ filtered | — | Good. |
| 24 | src/app/api/store/route.ts:890 | UPDATE org_studio_roadmap_versions SET items = $1 WHERE id = $2 | roadmap_versions | ❌ MISSING | HIGH | Mutation, no workspace_id filter. Relies on `id` being globally unique — risky on a guess/collision. |
| 25 | src/app/api/vision/[id]/doc/route.ts:128 | SELECT content FROM org_studio_vision_docs WHERE project_id=$1 AND workspace_id=$2 | vision_docs | ✅ filtered | — | Good. |
| 26 | src/app/api/vision/[id]/doc/route.ts:216 | INSERT INTO org_studio_vision_docs (project_id, content, updated_at, workspace_id) | vision_docs | ✅ stamped | — | Good (assuming workspace param is request-derived; verify). |
| 27 | src/lib/api-tokens.ts:116 | INSERT INTO org_studio_api_tokens (..., workspace_id) | api_tokens | ✅ stamped | — | Good. |
| 28 | src/lib/api-tokens.ts:145 | SELECT FROM org_studio_api_tokens WHERE token_hash=$1 AND workspace_id=$2 AND revoked_at IS NULL | api_tokens | ✅ filtered | — | Good — token verify is workspace-scoped. |
| 29 | src/lib/api-tokens.ts:156 | UPDATE org_studio_api_tokens SET last_used_at=$1 WHERE id=$2 | api_tokens | ❌ MISSING | MED | id is UUID/PK so practically unique, but mutation without workspace filter is still a defense-in-depth gap. |
| 30 | src/lib/api-tokens.ts:180 | SELECT FROM org_studio_api_tokens WHERE workspace_id=$1 ... | api_tokens | ✅ filtered | — | Good. |
| 31 | src/lib/api-tokens.ts:195 | UPDATE org_studio_api_tokens ... WHERE id=$2 AND workspace_id=$3 AND revoked_at IS NULL | api_tokens | ✅ filtered | — | Good. |
| 32 | src/lib/auth.ts:98 | SELECT user_id, expires_at FROM org_studio_sessions WHERE token=$1 AND workspace_id=$2 | sessions | ⚠️ HARDCODED | HIGH | Param 2 is literal `'default-workspace'`. Auth session lookup is workspace-pinned to default — multi-workspace cloud users can't log in to other workspaces. |
| 33 | src/lib/auth.ts:111 | DELETE FROM org_studio_sessions WHERE token=$1 AND workspace_id=$2 | sessions | ⚠️ HARDCODED | HIGH | Same hardcode. |
| 34 | src/lib/auth.ts:154 | INSERT INTO org_studio_sessions (token, user_id, expires_at, workspace_id) | sessions | ⚠️ check param | HIGH | Stamping workspace; verify the param is request-derived. |
| 35 | src/lib/auth.ts:186 | DELETE FROM org_studio_sessions WHERE token=$1 AND workspace_id=$2 | sessions | ⚠️ HARDCODED | HIGH | Literal `'default-workspace'`. |
| 36 | src/lib/bootstrap-pings.ts:63,80 | INSERT INTO org_studio_bootstrap_pings (agent_id, file_path, ...) | bootstrap_pings | ❌ NO COLUMN | ⚠️ MED | Agent-scoped table; cross-workspace collision risk on shared agent_id. See §6. |
| 37 | src/lib/bootstrap-pings.ts:115,120 | SELECT FROM org_studio_bootstrap_pings WHERE agent_id=$1 (or no filter) | bootstrap_pings | ❌ NO COLUMN | ⚠️ MED | Same. |
| 38 | src/lib/dispatch-attempts.ts:299 | INSERT INTO org_studio_dispatch_attempts (agent_id, ...) | dispatch_attempts | ❌ NO COLUMN | ⚠️ MED | Same — agent-global, no workspace concept. |
| 39 | src/lib/dispatch-attempts.ts:337 | DELETE FROM org_studio_dispatch_attempts WHERE attempted_at < NOW() - INTERVAL '7 days' | dispatch_attempts | ❌ NO COLUMN | LOW | Retention prune. Even after adding workspace_id, this can stay global. |
| 40 | src/lib/dispatch-attempts.ts:374, 468 | SELECT FROM org_studio_dispatch_attempts WHERE agent_id=$1 ... | dispatch_attempts | ❌ NO COLUMN | ⚠️ MED | Dispatch health page bleeds across workspaces if same agent_id. |
| 41 | src/lib/heartbeats.ts:52 | INSERT INTO org_studio_heartbeats (..., workspace_id) ON CONFLICT (agent_id) DO UPDATE | heartbeats | ⚠️ HARDCODED + DESIGN BUG | HIGH | `workspaceId = 'default-workspace'` hardcoded. AND `ON CONFLICT (agent_id)` does not include workspace_id — same-name agent in two workspaces will overwrite each other's heartbeats. |
| 42 | src/lib/launch-prep.ts:128 | SELECT 1 FROM org_studio_roadmap_versions WHERE ... AND workspace_id=$3 LIMIT 1 | roadmap_versions | ✅ filtered | — | Good. |
| 43 | src/lib/launch-prep.ts:153 | INSERT INTO org_studio_roadmap_versions (..., workspace_id, ...) | roadmap_versions | ✅ stamped | — | Good. |
| 44 | src/lib/launch-prep.ts:193 | SELECT 1 FROM org_studio_vision_docs WHERE project_id=$1 AND workspace_id=$2 LIMIT 1 | vision_docs | ✅ filtered | — | Good. |
| 45 | src/lib/launch-prep.ts:200 | INSERT INTO org_studio_vision_docs (..., workspace_id) | vision_docs | ✅ stamped | — | Good. |
| 46 | src/lib/outbox.ts:67 | INSERT INTO org_studio_outbox (..., workspace_id) | outbox | ⚠️ HARDCODED | HIGH | `const workspaceId = 'default-workspace';` with TODO(v0.17-multi-workspace). Caller param not threaded through. |
| 47 | src/lib/postgres-pubsub.ts:102,116,123 | LISTEN/UNLISTEN "<channel>" | n/a | N/A | LOW | LISTEN is connection-scoped; channel names are global. Note: pubsub channels are NOT workspace-scoped — any LISTEN gets all notifies regardless of workspace. See cachedStore section. |
| 48 | src/lib/postgres-pubsub.ts:158 | (NOTIFY) | n/a | ⚠️ design | MED | NOTIFY payload SHOULD include workspace_id so listeners can filter. Check whether it does — see #18. |
| 49 | src/lib/principles-generator.ts:57 | SELECT FROM org_studio_kudos WHERE confirmed = true ORDER BY created_at DESC | kudos | ❌ MISSING | HIGH | Generates team-principles from ALL kudos across ALL workspaces. Cross-tenant data leak. |
| 50 | src/lib/project-state.ts:106 | SELECT data FROM org_studio_projects WHERE id=$1 AND workspace_id=$2 | projects | ✅ filtered | — | Good. |
| 51 | src/lib/project-state.ts:157-348 | Multiple SELECT/UPDATE on roadmap_versions + tasks + projects, all with `AND workspace_id = $N` | roadmap_versions / tasks / projects | ✅ filtered | — | Consistent. Good. |
| 52 | src/lib/project-state.ts:382 | UPDATE org_studio_projects SET data=$1 WHERE id=$2 AND workspace_id=$3 | projects | ✅ filtered | — | Good. |
| 53 | src/lib/roadmap-sync.ts:178-826 | ~15 queries (SELECT/UPDATE/INSERT) on projects + roadmap_versions + tasks | projects/roadmap_versions/tasks | ✅ filtered (all reviewed) | — | Heavy file; every callsite I checked carries workspace_id. NOTE: lines 381, 425, 533, 549, 559, 753, 763, 825 are UPDATEs by id with `AND workspace_id=$N`. ✅ |
| 54 | src/lib/roadmap-sync.ts:380,752 | UPDATE org_studio_roadmap_versions SET items=$1 WHERE id=$2 | roadmap_versions | ❌ MISSING | HIGH | Two UPDATE-by-id-only callsites. Both inside transactions whose SELECT-FOR-UPDATE already constrained by workspace_id, so practically safe — but defense-in-depth gap. |
| 55 | src/lib/skill-installs.ts:40,61 | INSERT INTO org_studio_skill_installs (agent_id, skill, ...) | skill_installs | ❌ NO COLUMN | ⚠️ MED | Agent-global; same cross-workspace collision concern as dispatch_attempts. |
| 56 | src/lib/skill-installs.ts:96,102 | SELECT FROM org_studio_skill_installs ... | skill_installs | ❌ NO COLUMN | ⚠️ MED | Same. |
| 57 | src/lib/store-provider.ts:523-533 | SELECT * FROM projects/tasks/settings WHERE workspace_id=$1 | projects/tasks/settings | ✅ filtered | — | But provider is singleton on `'default-workspace'` (line 1432) — see §3. |
| 58 | src/lib/store-provider.ts:577 | SELECT ... FROM org_studio_roadmap_versions WHERE project_id = ANY($1) AND workspace_id = $2 | roadmap_versions | ✅ filtered | — | Good. |
| 59 | src/lib/store-provider.ts:688-720 | BEGIN; DELETE/INSERT/UPDATE projects+tasks+settings; COMMIT — full snapshot replace | projects/tasks/settings | ✅ filtered (workspaceId from `this.workspaceId`) | — | Good at the SQL level — but `this.workspaceId` is permanently `'default-workspace'` via the singleton. Foundation-level bug, not a SQL bug. |
| 60 | src/lib/store-provider.ts:737,759 | buildInsert/buildUpdate plans — adds workspace_id column from this.workspaceId | projects | ✅ stamped | — | Same as #59 — depends on singleton. |
| 61 | src/lib/store-provider.ts:749,750 | SELECT * FROM org_studio_projects WHERE id=$1 AND workspace_id=$2 | projects | ✅ filtered | — | Good. |
| 62 | src/lib/store-provider.ts:775 | DELETE FROM org_studio_projects WHERE id=$1 AND workspace_id=$2 | projects | ✅ filtered | — | Good. |
| 63 | src/lib/store-provider.ts:791 | buildInsert plan for org_studio_tasks | tasks | ✅ stamped | — | Same singleton caveat. |
| 64 | src/lib/store-provider.ts:823 | SELECT pg_advisory_lock($1) | n/a | N/A | LOW | Global advisory lock (acceptable, ticket sequence is global). |
| 65 | src/lib/store-provider.ts:829-846 | SELECT MAX(ticket_number) FROM org_studio_tasks; setval ticket_number_seq | tasks (read) | ❌ MISSING | LOW | MAX(ticket_number) reads across ALL workspaces — but ticket_number is intentionally globally unique (per #1265). Document as intentional. |
| 66 | src/lib/store-provider.ts:880-881 | SELECT * FROM org_studio_tasks WHERE id=$1 AND workspace_id=$2 | tasks | ✅ filtered | — | Good. |
| 67 | src/lib/store-provider.ts:889 | buildUpdate plan for org_studio_tasks (includes workspace_id in WHERE via builder) | tasks | ✅ filtered | — | Verify postgres-column-map.ts builder appends workspace_id to WHERE. |
| 68 | src/lib/store-provider.ts:919 | DELETE FROM org_studio_tasks WHERE id=$1 AND workspace_id=$2 | tasks | ✅ filtered | — | Good. |
| 69 | src/lib/store-provider.ts:943 | INSERT INTO org_studio_comments (...13 cols, no workspace_id) ON CONFLICT (id) DO NOTHING | comments | ❌ NO COLUMN | HIGH | Comments table has no workspace_id column at all. Cross-workspace comment readers can see other tenants' comments. |
| 70 | src/lib/store-provider.ts:971-972 | SELECT * FROM org_studio_tasks WHERE id=$1 AND workspace_id=$2 (inside addComment) | tasks | ✅ filtered | — | Good. |
| 71 | src/lib/store-provider.ts:1011 | UPDATE org_studio_tasks SET comments=$1, data=$2 WHERE id=$3 | tasks | ❌ MISSING | HIGH | Mutation by id only inside addComment. Defense-in-depth gap; combined with #69 it's a leak. |
| 72 | src/lib/store-provider.ts:1044 | SELECT * FROM org_studio_comments WHERE scope_key=$1 AND created_at < $2 ORDER BY created_at DESC LIMIT $3 | comments | ❌ NO COLUMN | HIGH | Cross-workspace comment read. Bug magnified because scope_key is computed from `(scope_kind, taskId/sectionId/...)` which CAN collide across workspaces. |
| 73 | src/lib/store-provider.ts:1081 | SELECT ... FROM org_studio_comments (listComments variant for sections/threads) | comments | ❌ NO COLUMN | HIGH | Same. |
| 74 | src/lib/store-provider.ts:1123 | SELECT data FROM org_studio_settings WHERE id=$1 AND workspace_id=$2 | settings | ✅ filtered | — | Good. |
| 75 | src/lib/store-provider.ts:1133 | INSERT INTO org_studio_settings (..., workspace_id) ON CONFLICT (id) DO UPDATE | settings | ⚠️ PK BUG | HIGH | Same issue as heartbeats #41: `ON CONFLICT (id)` does NOT include workspace_id. Settings row id='default' across workspaces will overwrite each other. The unique key needs to be `(id, workspace_id)`. |
| 76 | src/lib/store-provider.ts:1161-1232 | 5× SELECT * FROM org_studio_projects WHERE id=$1 AND workspace_id=$2 | projects | ✅ filtered | — | Five identical-shape getters. Good. |
| 77 | src/lib/store-provider.ts:1258 | INSERT INTO org_studio_agent_metrics (id, agent_id, date, section_id, ... 25 cols, NO workspace_id) ON CONFLICT (agent_id, date, COALESCE(section_id, '')) | agent_metrics | ❌ MISSING + PK BUG | HIGH | Table HAS workspace_id column (per phase2), but INSERT skips it (defaults to 'default-workspace'). AND ON CONFLICT key omits workspace_id → cross-workspace agent_id/date collisions. |
| 78 | src/lib/store-provider.ts:1321 | SELECT * FROM org_studio_agent_metrics WHERE agent_id=$1 [AND date filters] [AND section filters] | agent_metrics | ❌ MISSING | HIGH | getMetrics doesn't filter by workspace — same agent_id in two workspaces returns merged data. |
| 79 | src/lib/store-provider.ts:1371 | SELECT agent_id, SUM(...), AVG(...) FROM org_studio_agent_metrics [WHERE date/section] GROUP BY agent_id | agent_metrics | ❌ MISSING | HIGH | getTeamMetrics — same. Aggregates across workspaces. |
| 80 | src/lib/store-provider.ts:1412 | SELECT 1 | n/a | N/A | LOW | health check |
| 81 | src/lib/vision-cron.ts:98 | SELECT items FROM org_studio_roadmap_versions WHERE project_id=$1 AND version=$2 AND workspace_id=$3 LIMIT 1 | roadmap_versions | ⚠️ HARDCODED | HIGH | Param is literal `'default-workspace'`. Vision cron only runs against default workspace. |
| 82 | src/lib/vision-cron.ts:115 | SELECT ticket_number FROM org_studio_tasks WHERE id=$1 AND workspace_id=$2 LIMIT 1 | tasks | ⚠️ HARDCODED | HIGH | Same. |
| 83 | src/lib/vision-prompt.ts:41 | SELECT content FROM org_studio_vision_docs WHERE project_id=$1 AND workspace_id=$2 | vision_docs | ✅ filtered | — | Verify param source is request-scoped, not hardcoded. |
| 84 | src/lib/workspace-auth.ts:88 | SELECT id, name, owner, created_at FROM org_studio_workspaces ORDER BY id | workspaces | N/A | LOW | This IS the workspace registry. No self-filter. |
| 85 | src/lib/workspace-auth.ts:91 | SELECT workspace_id, user_id, role, joined_at FROM org_studio_workspace_memberships ORDER BY workspace_id, user_id | workspace_memberships | N/A (loads all to build cache) | LOW | Membership cache loads everything once. Acceptable. |
| 86 | server.mjs:1223,1224 | LISTEN org_studio_change / org_studio_heartbeat | n/a | N/A | LOW | But: LISTEN payloads cross workspaces. Filtering happens (or doesn't) at the consumer side. |
| 87 | server.mjs:1229 | NOTIFY org_studio_heartbeat, 'ping' | n/a | N/A | LOW | self-keepalive |
| 88 | server.mjs:2351 | SELECT count(*) FROM org_studio_outbox WHERE status='dead_letter' AND workspace_id=$1 | outbox | ⚠️ HARDCODED | HIGH | Literal `'default-workspace'` — has TODO(v0.17). Dead-letter monitor is single-workspace-only. |
| 89 | server.mjs:2399-2402 | SELECT 1; LISTEN/UNLISTEN _health_probe | n/a | N/A | LOW | health |

**Tally (callsites by status):**
- ✅ filtered correctly: roughly 90 of the 185 line-hits (many are repeats inside the same logical query block)
- ❌ MISSING filter on table that has the column: **9 distinct callsites** (#2, #4, #5, #24, #29, #49, #54×2, #65, #71, #77, #78, #79)
- ⚠️ HARDCODED `'default-workspace'`: **12 distinct callsites** (#9, #16, #17, #18, #22, #32, #33, #35, #41, #46, #81, #82, #88)
- ⚠️ PK / ON-CONFLICT design bug: **3** (#41, #75, #77)
- ❌ NO workspace_id column on table: **5 tables** affecting many callsites (comments, bootstrap_pings, dispatch_attempts, skill_installs, watchdog_pauses)
- N/A or LOW: rest

**Net HIGH-risk callsite count: ~18.**

---

## 2. File-store inventory

The OSS file-store (`FileStoreProvider` in `src/lib/store-provider.ts`) operates on a workspace envelope:

```json
{
  "activeWorkspace": "default-workspace",
  "workspaces": {
    "default-workspace": { "projects": [], "tasks": [], "settings": {} }
  }
}
```

Every read/write goes through `readEnvelope()` (line 182) and `writeEnvelope()` (line 218), which both pick `data.workspaces[data.activeWorkspace || 'default-workspace']`.

| # | File:line | Operation | workspace_id filter applied? | Notes |
|---|---|---|---|---|
| F1 | src/lib/store-provider.ts:182 (`readEnvelope`) | read JSON → return active-ws slice | ✅ implicit (active slice only) | Other-workspace data is invisible by construction. |
| F2 | src/lib/store-provider.ts:218 (`writeEnvelope`) | write entire envelope JSON | ✅ implicit | Other workspaces preserved on disk; only active slice is mutated by callers. |
| F3 | src/lib/store-provider.ts:255 (`read`) | returns StoreData from active slice | ✅ implicit | Good. |
| F4 | src/lib/store-provider.ts:~360 (`write`) | mutates active slice and persists | ✅ implicit | Good. |
| F5 | src/lib/store-provider.ts:~390 (`addProject`/`updateProject`/etc.) | mutate active-slice arrays | ✅ implicit | Good — all mutators operate on the active slice. |
| F6 | server.mjs (`safeRead(STATUS_PATH)`, etc.) | activity-status file (separate from store.json) | ⚠️ N/A | Activity status is a separate file, not workspace-scoped. |

**Findings:**
- **No leaks** in the file-store path: every operation is scoped to `activeWorkspace` by construction.
- **1 architectural gap:** `activeWorkspace` is a single global field. Switching workspaces in OSS-local means rewriting `data.activeWorkspace`. There is no per-request workspace selection — every request sees the same active workspace. For OSS-local that's fine (single user, one workspace at a time). For any future hybrid mode (OSS file-store + multiple concurrent workspaces) it's a wall.
- Comments, kudos, agent_metrics etc. — these don't exist in the file-store path. They are Postgres-only. The file store only stores `projects`, `tasks`, `settings`.

---

## 3. cachedStore analysis

**Structure:** `cachedStore` (server.mjs:1352) is a single global variable of type `StoreData | null`. It is populated by `refreshCachedStore()` (line 1359), which fetches `http://127.0.0.1:${port}/api/store` (line 1361) and caches the JSON response.

**Auth context of the refresh fetch:** **None.** The fetch is unauthenticated, server-to-self, no cookies, no Bearer token. When `/api/store` GET (route.ts:427) runs `resolveRequestWorkspace(req)`, it gets `userId=null` (no auth), falls back to `{ id: DEFAULT_WORKSPACE_ID, name: 'Default Workspace' }` (line 423). So the cache always holds **only default-workspace data.**

**Consumers (`cachedStore.*` reads in server.mjs):**
1. `server.mjs:254` — broadcast to ALL websocket clients on store-LISTEN notify (`broadcast('store', cachedStore)`)
2. `server.mjs:1317` — used as fallback inside `pollGateway`
3. `server.mjs:1471` — sent to every new WS client on connection (initial state push)
4. `server.mjs:1603` — `projectIntegrityAudit()` iterates `store.projects` for incident logging
5. `server.mjs:1682` — `stuckTaskWatchdog()` iterates `store.tasks` for stuck-task incidents
6. `server.mjs:2486` — used by health monitor

**Risk summary (multi-workspace cloud mode):**
- **Leak risk:** When a non-default-workspace user opens the dashboard, the WS server pushes them the cached default-workspace store on connect (line 1471) before any auth handshake. They see default-workspace tasks and projects flash on screen until the HTTP poll of `/api/store` (which IS workspace-scoped per-request) replaces it.
- **Starvation risk:** Other workspaces never get a cachedStore. Their `projectIntegrityAudit` and `stuckTaskWatchdog` never fire for their data — incidents only get logged for default-workspace.
- **Broadcast amplification:** `broadcast('store', cachedStore)` on LISTEN event hits every WS client. Other-workspace clients receive default-workspace data via the WS push every time the default-workspace store changes.

**Risk level: HIGH in any multi-workspace deployment. Acceptable in OSS-single-workspace mode.**

**Suggested shape of fix (NOT applied):**
- Either A) drop `cachedStore` entirely from the cloud path and have all reads go through workspace-scoped `/api/store` HTTP fetches with auth; OR
- B) make `cachedStore` a `Map<workspaceId, StoreData>`, refresh per workspace, and key WS broadcasts by workspace membership (server.mjs would need to know which workspace each WS client belongs to — currently the WS connection carries no auth).

---

## 4. Existing test coverage gaps

**`scripts/test-workspace-isolation.mjs` covers:**
- ✅ INSERT/SELECT on `org_studio_projects` with two workspace_ids
- ✅ INSERT/SELECT on `org_studio_tasks` with two workspace_ids
- ✅ Cross-workspace exclusion (workspace A query does not return workspace B rows)

**It does NOT cover:**
- ❌ `org_studio_roadmap_versions`
- ❌ `org_studio_vision_docs`
- ❌ `org_studio_kudos`
- ❌ `org_studio_outbox`
- ❌ `org_studio_heartbeats`
- ❌ `org_studio_incidents`
- ❌ `org_studio_settings`
- ❌ `org_studio_sessions`
- ❌ `org_studio_api_tokens`
- ❌ `org_studio_agent_metrics` (this is the one with both missing-filter and broken ON CONFLICT)
- ❌ `org_studio_comments` (no workspace_id column — test would currently fail-by-design)

**Jest `*.test.ts` coverage:**
- `src/lib/api-tokens.test.ts` — tests api-tokens functions but I did not see explicit cross-workspace isolation assertions (only single-workspace paths verified).
- `src/lib/workspace-auth-browser.test.ts` — tests the resolver, not query coverage.
- `src/lib/write-scope-sweep.test.ts` — tests write-scope auth, orthogonal.
- `src/middleware.test.ts` — middleware path; not query-layer.
- **No `*.test.ts` exercises store-provider methods against two workspaces simultaneously.**

**Coverage-gap conclusion:** Tests cover ~10% of the workspace_id surface area at the SQL layer. Comments, metrics, kudos, sessions, outbox — all of which have either missing filters or broken PKs — are completely untested.

---

## 5. Recommended fixes (priority order)

> Fix shapes only — not applied. Approve the list before patching.

### Foundation-level (must precede SQL-level fixes)

**Fix #F1: `getStoreProvider()` singleton is permanently `'default-workspace'`.**
- Current: `src/lib/store-provider.ts:1448`-1454 — singleton with no workspace argument.
- 95 callsites use this. Until it's plumbed per-request, fixing individual queries inside store-provider doesn't help cloud users.
- Proposed shape: introduce `getStoreProviderForWorkspace(workspaceId: string)` (or thread `workspaceId` through `read/write/addProject/etc.`). Migrate the 95 callsites in waves; each route should resolve workspace from `resolveRequestWorkspace(req)` first.
- Effort: **L** (touches 95 files + core abstraction).
- Touches: `src/lib/store-provider.ts`, all of `src/app/api/**` that use `getStoreProvider()`.

**Fix #F2: `cachedStore` is workspace-blind.**
- Current: `server.mjs:1352, 1359, 1471, 254` — single global cache populated as default-workspace, broadcast to all WS clients.
- Proposed shape: either remove cachedStore from the cloud path (let clients HTTP-poll workspace-scoped `/api/store` directly), or refactor to per-workspace map + tag WS connections with workspaceId on handshake.
- Effort: **M** (server.mjs surgery + WS client tagging).
- Touches: `server.mjs`, possibly client-side WS init.

### HIGH-risk SQL fixes

**Fix #1: `store-provider.ts:1258` — `agent_metrics` INSERT missing workspace_id AND broken ON CONFLICT.**
- Current: `INSERT INTO org_studio_agent_metrics (... 25 cols, no workspace_id) ... ON CONFLICT (agent_id, date, COALESCE(section_id, ''))`.
- Proposed: add `workspace_id` to the column list + add `$26 = this.workspaceId`; change ON CONFLICT to `(workspace_id, agent_id, date, COALESCE(section_id, ''))`. Migration needs to add `(workspace_id, agent_id, date, section_id)` unique constraint and drop the old one.
- Effort: **M** (code + DB migration).
- Touches: `src/lib/store-provider.ts`, new `scripts/migrate-agent-metrics-uk.mjs`.

**Fix #2: `store-provider.ts:1321, 1371` — `getMetrics`/`getTeamMetrics` cross-workspace bleed.**
- Current: SELECT without workspace_id filter.
- Proposed: prepend `workspace_id = $N` to both `conditions` arrays.
- Effort: **S**.
- Touches: `src/lib/store-provider.ts`.

**Fix #3: `store-provider.ts:943, 1044, 1081` — `org_studio_comments` has no workspace_id at all.**
- Current: comments table is workspace-blind. `scope_key` can collide across workspaces.
- Proposed: schema migration to add `workspace_id` column + backfill from parent task's workspace_id; stamp on INSERT; filter on SELECT.
- Effort: **M** (migration + 3 query updates + back-compat).
- Touches: `scripts/migrate-comments-workspace-id.mjs` (new), `src/lib/store-provider.ts`.

**Fix #4: `store-provider.ts:1011` — `UPDATE org_studio_tasks SET comments=$1, data=$2 WHERE id=$3` inside addComment.**
- Current: UPDATE-by-id only, no workspace_id in WHERE.
- Proposed: add `AND workspace_id = $4` using `this.workspaceId`.
- Effort: **S**.
- Touches: `src/lib/store-provider.ts`.

**Fix #5: `store-provider.ts:1133` — `org_studio_settings` INSERT ... ON CONFLICT (id) DO UPDATE — PK doesn't include workspace_id.**
- Current: `ON CONFLICT (id) DO UPDATE SET data = $2` will overwrite the default-workspace settings row when ANY workspace writes id='default'.
- Proposed: change unique constraint to `(id, workspace_id)`; update ON CONFLICT clause to `(id, workspace_id)`.
- Effort: **M** (migration + code).
- Touches: `scripts/migrate-settings-uk.mjs` (new), `src/lib/store-provider.ts`.

**Fix #6: `heartbeats.ts:52` — same shape as Fix #5 + hardcoded 'default-workspace'.**
- Current: hardcoded workspace_id literal; `ON CONFLICT (agent_id)` doesn't include workspace_id.
- Proposed: thread workspace through the heartbeat API (heartbeat caller passes workspace, OR resolve from agent membership); fix ON CONFLICT to `(workspace_id, agent_id)`.
- Effort: **M**.
- Touches: `src/lib/heartbeats.ts`, scheduler callers, migration.

**Fix #7: `principles-generator.ts:57` — reads ALL kudos cross-workspace.**
- Current: `SELECT FROM org_studio_kudos WHERE confirmed = true` (no workspace).
- Proposed: accept `workspaceId` parameter; add `AND workspace_id = $1`.
- Effort: **S** (just plumb param through 1-2 callers).
- Touches: `src/lib/principles-generator.ts`, callers.

**Fix #8: `auth.ts:98, 111, 154, 186` — sessions hardcoded to 'default-workspace'.**
- Current: 4 callsites use literal `'default-workspace'`.
- Proposed: resolve workspace from the login request (form/cookie/subdomain — needs product decision). Then thread through.
- Effort: **M** (requires product decision on how the login form knows which workspace).
- Touches: `src/lib/auth.ts`, login route.
- ⚠️ This is a product question: how does a multi-tenant deployment know which workspace a session belongs to? Subdomain? URL param? User-workspace mapping?

**Fix #9: `outbox.ts:65` — hardcoded 'default-workspace' for outbox enqueue.**
- Proposed: add `workspaceId` to `params`; thread from scheduler caller (which has request context).
- Effort: **S–M**.
- Touches: `src/lib/outbox.ts` + scheduler callers.

**Fix #10: `scheduler/status/route.ts:50` and `server.mjs:2351` — outbox count queries hardcode 'default-workspace'.**
- Proposed: scheduler/status should aggregate per-workspace OR scope to caller's workspace. Health monitor (server.mjs:2351) should aggregate across all workspaces (it's a system-level metric).
- Effort: **S**.
- Touches: both files.

**Fix #11: `kudos/route.ts:193` (and verify 97, 230) — DELETE/UPDATE with hardcoded workspace literal.**
- Proposed: replace literal with `workspace.id` from `resolveRequestWorkspace`.
- Effort: **S**.
- Touches: `src/app/api/kudos/route.ts`.

**Fix #12: `roadmap/[projectId]/route.ts:718, 743` and `roadmap/[projectId]/versions/[version]/items/route.ts:59, 68` — pg_notify payloads stamped with hardcoded 'default-workspace' (or module constant WORKSPACE_ID).**
- Proposed: replace with the resolved workspace.id from request.
- Effort: **S**.
- Touches: 2 route files.

**Fix #13: `vision-cron.ts:99, 116` — vision-cron only runs for default-workspace.**
- Proposed: iterate workspaces (cron-level loop) OR scope cron to one workspace and run N instances.
- Effort: **M** (product/ops decision).
- Touches: `src/lib/vision-cron.ts`, cron wiring.

**Fix #14: `store/route.ts:890` — `UPDATE org_studio_roadmap_versions SET items=$1 WHERE id=$2`.**
- Proposed: add `AND workspace_id = $3`.
- Effort: **S**.

**Fix #15: `roadmap-sync.ts:380, 752` — same shape: UPDATE roadmap_versions by id only.**
- Defense-in-depth (callsite is inside a workspace-scoped SELECT-FOR-UPDATE txn). Still recommended.
- Effort: **S**.

**Fix #16: `api-tokens.ts:156` — `UPDATE last_used_at WHERE id=$2` defense-in-depth.**
- Effort: **S**.

**Fix #17: `admin/migrate-roadmap/route.ts:141, 184` — cross-workspace by design (one-shot admin migration).**
- Recommend: add a comment marking it intentional; require admin role; document.
- Effort: **S** (doc only).

### MED-risk / design questions

**Fix #18: `org_studio_comments` schema** — see Fix #3.
**Fix #19: `org_studio_bootstrap_pings`, `dispatch_attempts`, `skill_installs`, `watchdog_pauses`** — these tables have no workspace_id. Open question (see §6): are they intentionally agent-global (e.g. one agent identity across workspaces) or should they be scoped? If scoped, schema migrations + filter additions needed for each.
**Fix #20: `/api/health`** — make explicit whether health is global (all-workspace) or caller-scoped.

### LOW / cosmetic

**Fix #21: `store-provider.ts:829-846`** — ticket sequence is global by design (#1265). Add a comment.
**Fix #22: pg `LISTEN` channels are global.** NOTIFY payloads should include workspace_id; consumers should filter. Audit each NOTIFY payload (most already include workspace_id from the row being touched).

---

## 6. Open questions for human review

1. **Tables without `workspace_id` column at all** — what's the intent?
   - `org_studio_bootstrap_pings` — agent-global config sync. Should an "agent named mikey in workspace A" share bootstrap state with "agent named mikey in workspace B"? Probably **no** (different humans/orgs may both name an agent "mikey"). Recommend adding workspace_id.
   - `org_studio_dispatch_attempts` — dispatch telemetry. Same concern.
   - `org_studio_skill_installs` — skill version tracking per agent. Same concern.
   - `org_studio_watchdog_pauses` — pause an agent's watchdog. **Definitely should be workspace-scoped** in cloud; in OSS it's fine global.
   - `org_studio_comments` — **clearly should be workspace_id scoped.** This is the highest-priority schema-level fix.

2. **`/api/store` GET allows unauthenticated read** with fallback to `DEFAULT_WORKSPACE_ID`. The intent appears to be "internal localhost call from server.mjs" — but the route doesn't check `127.0.0.1`. Any cloud-deployed instance with this open will serve default-workspace data to anonymous callers. **Is this intentional? If yes, the cloud reverse-proxy must block this route. If no, the route needs to return 401 when no auth context.**

3. **cachedStore in cloud mode** — proposed Option A (drop it entirely) vs Option B (per-workspace map). Option A is simpler; Option B preserves the current "instant initial state on WS connect" UX. Need a product call.

4. **Auth/sessions workspace resolution** — how does a multi-tenant deployment know which workspace a login belongs to? Currently the session table has workspace_id but the queries all hardcode 'default-workspace'. Options: subdomain-per-workspace, workspace selector after login, single-workspace-per-user-default. Product decision.

5. **Vision cron + outbox worker** — both currently run for default-workspace only. In a multi-tenant cloud, should they:
   - Run as N independent crons (one per workspace)?
   - Run as a single cron that iterates all workspaces?
   - Run only the workspaces that have an active subscription?
   Operationally distinct choices.

6. **`org_studio_agent_metrics` ON CONFLICT migration** — changing the unique key requires DROP CONSTRAINT + ADD CONSTRAINT, which can fail if there are already cross-workspace rows with colliding `(agent_id, date, section_id)`. Need a pre-flight check + dedup-or-merge strategy. Same for `org_studio_settings` ON CONFLICT (id).

7. **Postgres `LISTEN/NOTIFY` cross-workspace channel sharing** — currently `org_studio_change` is global. Consumers receive notifications for OTHER workspaces' changes and either ignore them or process them naively. Verify each consumer filters by `workspace_id` in the NOTIFY payload before acting.

8. **OSS-local `activeWorkspace` UX** — file-store has no per-request workspace, just a single `activeWorkspace` field in `store.json`. If a future OSS user has multiple workspaces and wants to switch between them, that's a UX gap. Probably acceptable for v1 (OSS is intentionally single-user).

---

End of audit.
