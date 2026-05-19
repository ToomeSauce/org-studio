# #1393 — Tenant identity DDL + backfill

**Date:** 2026-05-18
**Author:** Mikey
**Status:** Shipped. Migration + backfill run against staging-Azure 2026-05-18 22:39 EDT.
**Branch:** `mikey/1393-tenant-identity` (stacked on `mikey/1392-vision-doc-rename-hygiene`).

## Scope

Closes #1387 doneWhen items 1, 2, and the remaining half of 6. Items 3, 4, 5, 7, 9 closed earlier in Slice A/B + #1390/#1391. Item 8 (public signup) is deferred to #1394 per Basil 2026-05-18.

This is the keystone work — until this lands, `workspace_id` columns everywhere point at the literal string `'default-workspace'` with no parent row to anchor them. After this ships, `default-workspace` is a real `org_studio_workspaces` row owned by a real `org_studio_users` row (`basil`).

**Not in scope:** public signup flow, password storage, OAuth, invite flow, email service wiring, login pages. All deferred to #1394.

## What was already in place before this ticket

Discovered during ticket bring-up (and worth recording so the next person doesn't reinvent it):

- ✅ `org_studio_workspaces` table existed (added in `migrate-workspace-id.mjs` from Slice A) with columns `(id, name, owner, created_at, data jsonb)`.
- ✅ `org_studio_workspace_memberships` existed with `(workspace_id, user_id, role, joined_at)` and a `(workspace_id, user_id)` composite PK.
- ✅ Default rows: `default-workspace` with `owner='system'`, and 10 membership rows (`basil`/owner + 9 agents/member).
- ✅ Slice A/B made `getStoreProvider(workspaceId)` per-request and `cachedStore` per-workspace.
- ✅ `org_studio_sessions` had `(workspace_id, user_id)` columns. `org_studio_admin_audit` had `user_id` (all null pre-#1393).
- ❌ **No `org_studio_users` table.** No `workspaces.deleted_at`. No `workspaces.plan`. No CHECK on membership role.

The original ticket scope assumed all of this needed to be built. About half was already there.

## What this ticket adds

### Schema changes (migrate-1393-tenant-identity.mjs)

1. **`org_studio_users` table:** `id` (PK, text), `email` (text, unique-CI via `LOWER()` index), `password_hash` (nullable), `oauth_subject` (nullable, indexed), `created_at`, `last_login_at`.
2. **`org_studio_workspaces.deleted_at`:** nullable BIGINT for soft-delete. Partial index `WHERE deleted_at IS NULL` for fast "list active workspaces" queries.
3. **`org_studio_workspaces.plan`:** TEXT, NOT NULL, default `'oss'`. Free-form for now; `admin-create-workspace.mjs` validates against `(oss|internal|paid)`.
4. **`memberships_role_check` CHECK constraint:** `role IN ('owner', 'admin', 'member', 'viewer')`. `admin` is forward-compat per Slice B B.1 (today only `owner` is privileged in `requireWorkspaceRole`).

All DDL is `IF NOT EXISTS` / pre-checked, wrapped in a single `BEGIN/COMMIT`. Re-runnable, idempotent. Supports `--dry-run`.

### Backfill (backfill-1393-tenants.mjs)

1. INSERT `basil` user row (`id='basil'`, `email=$BASIL_EMAIL` defaulting to `basil@catpilot.ai`, password_hash NULL, oauth_subject NULL). `ON CONFLICT DO NOTHING`.
2. Verify `default-workspace` ↔ `basil` membership is `role='owner'`; promote if not, insert if missing.
3. Update `default-workspace.plan` from `'oss'` (the column default) to `'internal'` to mark it as the Catpilot-internal workspace.

Idempotent: re-runs are no-ops. Wrapped in transaction. Supports `--dry-run`.

Existing 9 agent membership rows (mikey, ana, henry, sam, billy, kate, hermes-*) are left alone — they're internal agent loops, not human logins, and `workspace-auth.ts` already tolerates membership-without-user (see line 257, "stale membership row → skip").

### Admin CLI (admin-create-workspace.mjs)

Atomically creates user + workspace + owner-membership in one transaction. Args: `--name`, `--owner-email`, `--workspace-id` (optional, defaults to slug + random suffix), `--plan` (oss|internal|paid), `--dry-run`. Outputs the three created rows as JSON on stdout for shell composition.

Used to provision the second test workspace for the staging soak prereq, and as the ops tool for creating workspaces in lieu of a public signup flow until #1394 ships.

### App-layer changes (workspace-auth.ts)

- `WorkspaceMembership.role` widened to `'owner' | 'admin' | 'member' | 'viewer'`.
- `Workspace` interface gained optional `plan?: string` and `deletedAt?: number | null` (optional so callers running against pre-migration DBs don't break).
- `loadWorkspaceData()` does an `information_schema` probe on first call to detect whether `deleted_at` + `plan` columns exist. If present, query selects them and filters `WHERE deleted_at IS NULL`. If absent, falls back to the legacy SELECT — keeps OSS deployments on older schemas working.

After migrate-1393 has run everywhere, the legacy branch becomes dead code; can be removed in a followup.

## Migration runbook

### Pre-flight (already done for staging-Azure)

1. Snapshot 10 workspace-scoped tables to JSON: `data/backups/pre-1393-20260519T023917Z.json` (10MB, 3934 rows).
2. Dry-run both scripts against the target DB — both passed.

### Live run (commands actually executed against staging-Azure)

```bash
cd /home/openclaw_user/org-studio
set -a; source .env.local; set +a

# 1. Migration
node scripts/migrate-1393-tenant-identity.mjs
#   → org_studio_users created, deleted_at + plan columns added, role CHECK installed

# 2. Backfill
BASIL_EMAIL=basil@catpilot.ai node scripts/backfill-1393-tenants.mjs
#   → basil user inserted, default-workspace.plan='internal'

# 3. Idempotency check (re-runs)
node scripts/migrate-1393-tenant-identity.mjs   # no-op
BASIL_EMAIL=basil@catpilot.ai node scripts/backfill-1393-tenants.mjs   # no-op
```

### Verification

```bash
# Test suite (includes #1393 section)
DATABASE_URL=$DATABASE_URL node scripts/test-workspace-isolation.mjs
# Result: 130 passed, 0 failed, 2 todos.
```

### Rollback

If the migration needs to be undone in the same window:

```sql
BEGIN;
DROP TABLE org_studio_users CASCADE;
ALTER TABLE org_studio_workspaces DROP COLUMN IF EXISTS deleted_at;
ALTER TABLE org_studio_workspaces DROP COLUMN IF EXISTS plan;
ALTER TABLE org_studio_workspace_memberships DROP CONSTRAINT IF EXISTS memberships_role_check;
COMMIT;
```

No existing rows are modified by the migration (only NEW columns + NEW table + 1 new row in workspaces.plan default + 1 INSERT in users). Rolling back the DDL cannot lose any pre-1393 data. The plan='internal' UPDATE on default-workspace is reverted by `UPDATE org_studio_workspaces SET plan='oss' WHERE id='default-workspace'`.

If rollback is needed after >1 week of usage, restore from the pre-1393 JSON snapshot in `data/backups/`.

### Staging soak protocol (>=1 week, per #1387 prereq)

After this ticket ships:

1. Run `admin-create-workspace.mjs --name "Soak Test" --owner-email soak@catpilot.test --plan paid` to provision the second workspace.
2. Manually create a project in the soak workspace via the API with `X-Workspace-Id: ws-soak-...` header.
3. Verify cross-workspace isolation: `default-workspace` projects do not leak into soak listings, vice versa.
4. Run for >=1 week. Watch for: cachedStore-related staleness across the two workspaces, WS broadcasts crossing the boundary, audit rows attributing the wrong workspace.
5. Once clean for 7 consecutive days, the public-cutover prereq is met. (Public cutover itself is gated on #1394.)

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| DDL fails partway, leaves schema half-migrated | Single transaction BEGIN/COMMIT, all DDL inside |
| Backfill overwrites existing data | INSERT ON CONFLICT DO NOTHING; UPDATE WHERE plan='oss' (won't touch non-default) |
| App-layer code breaks against pre-1393 DB | `information_schema` probe in `loadWorkspaceData()` falls back to legacy SELECT |
| `admin` role appears in DB but old code unioned only `'owner' | 'member'` | Type widened to `'owner' | 'admin' | 'member' | 'viewer'` in this ticket; no downstream code narrowed on the old union |
| Soft-deleted workspace still in cache, leaks data | `loadWorkspaceData()` filters `deleted_at IS NULL`; cache TTL flushes within 60s |
| `basil` email is wrong | Backfill is opt-in via `BASIL_EMAIL`; can be UPDATE'd post-hoc; field is only used for future login flow which is #1394 |

## What's NOT done (and why)

- **Public signup, login, password storage** — deferred to #1394 per Basil 2026-05-18.
- **`requireWorkspaceRole()` helper** — described in Slice B audit doc but not actually implemented in src/. The current write-gate is `requireWriteScope` from `auth.ts`. The role enum widening I did here is forward-compat for whenever that helper does land.
- **Workspace-creation hooks (#1393 doneWhen item 7)** — partially shipped: `admin-create-workspace.mjs` is the entry point, but there's no cachedStore-preheat hook on creation. The cachedStore is lazy by design (`cachedStoreByWorkspace` Map), so it materializes on first read post-creation. No explicit hook needed.
- **Multi-table SELECT with workspace.deleted_at JOIN** — the soft-delete filter is in `workspace-auth.loadWorkspaceData()` only. If a future query bypasses that helper and goes directly against `org_studio_workspaces`, it'd see deleted rows. Mitigated by: the partial index nudges devs toward `WHERE deleted_at IS NULL`. A followup ticket could add a Postgres VIEW for "active workspaces only" if this becomes a real issue.

## Test coverage added

`scripts/test-workspace-isolation.mjs` § "tenant identity DDL + backfill (#1393)" adds ~18 assertions:

- Static: 4 file-existence + 7 source-content asserts (migration is transaction-wrapped, supports dry-run, creates users table, adds columns, role enum, backfill idempotency markers, CLI tx-wrapped)
- Live (when DATABASE_URL set): users table + columns, workspaces deleted_at + plan, memberships role CHECK exists and includes all 4 roles, basil user present, default-workspace plan=internal + deleted_at=null, admin CLI live run creates 3 rows + emits JSON, soft-delete filter behavior, soft-deleted row is recoverable

Suite total post-#1393: **130 passed, 0 failed, 2 todos** (vs. 112 after #1392).

## Files touched

- `scripts/migrate-1393-tenant-identity.mjs` (NEW)
- `scripts/backfill-1393-tenants.mjs` (NEW)
- `scripts/admin-create-workspace.mjs` (NEW)
- `src/lib/workspace-auth.ts` (MODIFIED — widened role union, added optional fields, added information_schema probe in loadWorkspaceData)
- `scripts/test-workspace-isolation.mjs` (MODIFIED — +1 test function, +18 assertions)
- `docs/audits/1393-tenant-identity.md` (NEW — this file)
- `data/backups/pre-1393-20260519T023917Z.json` (snapshot taken; not committed)
