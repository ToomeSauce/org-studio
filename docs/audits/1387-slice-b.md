# #1387 Slice B — Workspace-role gates + admin audit

**Status:** Done. Branches pushed, all merged into `mikey/1387-b4-isolation-tests-and-docs`.

**Date:** 2026-05-18

**Author:** Mikey

## Scope

Slice A (commits `2628627`, `8eedd00`) made the codebase workspace-aware: the data layer scopes reads/writes by `workspace_id`, sessions track which workspace the caller is acting in, and the schema has the matching composite keys.

Slice B closes the **identity gate** on write endpoints. Before B, any caller with a valid session cookie or bearer token could mutate any workspace's data — the data layer prevented cross-workspace **writes** (via stamping) but didn't prevent a member of workspace-A from POSTing into workspace-B if they fudged the workspace context.

Slice B adds a role-based authorization check at the request boundary AND an audit trail for break-glass (global API key) usage so that ops/incident access remains possible without being silent.

## Decisions

### B.1 — Role hierarchy: `owner > admin > member`

We support three named roles via the `WORKSPACE_ROLE_ORDER` array, even though the current schema only persists `owner | member`. The `admin` tier is reserved as forward-compat for a future migration; today, gating on `admin` resolves to `owner`-only.

**Why three tiers up front:** when the schema expands later (it will — workspace billing/permissions will want a non-owner privileged tier), zero callsites need to change. The cost is one unused enum value.

### B.1 — `requireWorkspaceRole()` returns a discriminated union

```ts
| { allowed: true;  via: 'session' | 'agent-token' | 'break-glass'; userId: string | null; role?: WorkspaceRole }
| { allowed: false; reason: 'unauthenticated' | 'not-a-member' | 'insufficient-role'; response: NextResponse }
```

Callers `if (!result.allowed) return result.response;` — the helper builds the 401/403 response so each endpoint stays a one-liner.

`via` is the **most important field for B.3**: every break-glass call passes the gate (so existing agent loops keep working) but writes an audit row.

### B.2 — Wire scope

Wired into:

| Endpoint | Method | minRole | Notes |
|---|---|---|---|
| `/api/backups` | POST | `owner` | Destructive (restore overwrites store.json). File-mode-only in cloud; OSS users see no change. |
| `/api/vision/[id]/doc` | PUT | `member` | Vision-doc writes. |
| `/api/store` | POST | `member` | The big one — every Org Studio mutation flows through here. |

**Dropped from original B.2 plan after audit:**

- `/api/admin/tokens` — already `requireAdmin()` (bearer-must-equal-global-key). Workspace-owner gate would *loosen* it. Stays as-is.
- `/api/scheduler` admin actions — same shape as above.
- `/api/health` — no POST/PUT/DELETE; GET-only with built-in workspace scoping on the response payload. Nothing to gate.

### B.2 — OSS / file-mode handling

`requireWorkspaceRole` falls back to "every authenticated caller is owner-of-default-workspace" in OSS mode (matches the existing `listUserWorkspaceMemberships` shape from slice A). Single-user installs see zero behavior change.

### B.3 — Audit table

```sql
CREATE TABLE org_studio_admin_audit (
  id            BIGSERIAL PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  user_id       TEXT,
  action        TEXT NOT NULL,
  endpoint      TEXT NOT NULL,
  method        TEXT NOT NULL,
  via           TEXT NOT NULL CHECK (via IN ('session','agent-token','break-glass')),
  request_meta  JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_admin_audit_workspace_created ON org_studio_admin_audit (workspace_id, created_at DESC);
CREATE INDEX idx_admin_audit_action_created    ON org_studio_admin_audit (action, created_at DESC);
```

Append-only by convention (no UPDATE/DELETE API exposed from `admin-audit.ts`).

### B.3 — `auditBreakGlassIfNeeded()` semantics

- **Only writes when `via === 'break-glass'`.** Session and agent-token paths are already tracked by their own auth layers (session timestamps, per-agent token usage rows).
- **Never throws.** Audit-write failures log to stderr but don't break the calling endpoint — an audit failure can't justify dropping a legitimate mutation.
- **Silent no-op when `DATABASE_URL` is not set.** OSS/file-mode has no multi-user surface worth auditing.
- **Best effort.** Fire-and-forget from the request handler.

### B.4 — Isolation test extension

`scripts/test-workspace-isolation.mjs` added 24 hard assertions for slice B:

- **Static (15):** module exports, gate calls, audit calls, migration presence, schema columns.
- **Behavioral (5):** live server checks — unauthenticated 401 on three endpoints, audit row appearance on break-glass.

Total assertions: **80 passed / 0 failed / 2 todos** (deferred TODOs are A-slice items, all closed in code).

## Reversibility tier

Slice B is **fully reversible**:

1. **`git revert` the B.2 + B.3 + B.4 commits.** Removes the gate calls, audit calls, and test section. Endpoints return to slice A behavior (auth-only).
2. **`DROP TABLE org_studio_admin_audit;`** to undo the schema. Audit rows lost but no downstream consumer depends on them.
3. Helper modules (`workspace-auth.ts requireWorkspaceRole`, `admin-audit.ts`) can stay in place harmlessly with no callsites — pure dead code.

## Risks (mitigated)

| Risk | Mitigation |
|---|---|
| Locking out existing agent loops that use global API key | Break-glass path stays open in B.2; B.3 records each call so it's traceable. Tightening further is a separate ticket gated on per-agent-token rollout (#1383). |
| Cross-workspace silent leak via stale resolved workspace | Slice A's data-layer partition catches this regardless (read of cross-workspace row returns null). B.2 adds the identity gate as defense in depth. |
| Audit write failure breaks legitimate mutation | `writeAdminAudit` swallows errors and logs. Never throws. |
| Audit table growth | Append-only; retention pruning is future work. At current break-glass volume (~50/day), expect ~18K rows/year. Trivial. |

## Follow-up tickets to file

1. **Vision-doc rename hygiene** — when a project id is renamed, the matching `org_studio_vision_docs` row must be migrated/garbage-collected. Today, the row is orphaned. (Discovered during B.2 smoke testing — see incident note on #1387 ticket comments.)
2. **Per-agent token migration for agent loops (#1383)** — once agents use per-agent tokens instead of the global key, break-glass audit volume drops to near-zero and we can tighten role-gates further (e.g. require `owner` for destructive store actions).
3. **Admin-audit UI** — Settings → Audit Log page for owners to browse their workspace's audit history.
4. **Per-mutation audit granularity** — currently `/api/store` POST records `action: 'store.mutation'` at the request boundary. If we need to distinguish `addTask` vs `addComment` etc. in the audit, add a second audit call inside the switch after `action` is known.

## Touched files

- `src/lib/workspace-auth.ts` (B.1 — helper)
- `src/lib/admin-audit.ts` (B.3 — helper, new file)
- `migrations/1387-b3-admin-audit-table.mjs` (B.3 — schema)
- `src/app/api/backups/route.ts` (B.2)
- `src/app/api/vision/[id]/doc/route.ts` (B.2)
- `src/app/api/store/route.ts` (B.2 #4)
- `scripts/test-workspace-isolation.mjs` (B.4 — +24 assertions)
- `scripts/test-workspace-role-gate.mjs` (B.1 — focused unit test, also passing)
- `src/app/api/test/workspace-role/route.ts` (B.1 — test-hook endpoint, gated on `ORG_STUDIO_TEST_HOOKS=1`)
- `docs/audits/1387-slice-b.md` (B.5 — this file)

## Branches

- `mikey/1387-b1-workspace-role-gate` — B.1 helper
- `mikey/1387-b2-vision-backups-role-gate` — B.2 (2 endpoints)
- `mikey/1387-b3-admin-audit` — B.3 (audit table + helper + wired into B.2 endpoints)
- `mikey/1387-b2-4-store-role-gate` — B.2 #4 (`/api/store`)
- `mikey/1387-b4-isolation-tests-and-docs` — B.4 + B.5 (this doc)

All pushed to GitHub `ToomeSauce/org-studio`. None merged to `main` yet — Basil's review window.
