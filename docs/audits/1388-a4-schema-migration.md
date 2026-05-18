# #1388 A.4-schema — Migration Audit

**Date applied:** 2026-05-18 (UTC)
**Author:** Mikey
**Parent ticket:** #1387 slice A (code refactor completed at commit `2628627`)
**Status:** Applied locally + staging (single Postgres backs both). Source code + isolation tests updated; deployed at BUILD_ID `Wb6hipo1qlRLnSZw3k11F`.

## Goal

Slice A made the code workspace-aware. This migration makes the SCHEMA workspace-aware in the three tables where `ON CONFLICT` clauses still assumed single-tenancy, so two workspaces can hold the same logical row (`agent_id`, `date`, `id`, etc.) without collision.

## Tables touched

| Table | Before | After |
|---|---|---|
| `org_studio_agent_metrics` | UNIQUE INDEX `(agent_id, date, COALESCE(section_id,''))` | UNIQUE INDEX `(workspace_id, agent_id, date, COALESCE(section_id,''))` |
| `org_studio_settings` | PRIMARY KEY `(id)` | PRIMARY KEY `(workspace_id, id)` |
| `org_studio_heartbeats` | PRIMARY KEY `(agent_id)` | PRIMARY KEY `(workspace_id, agent_id)` |

Plus: `workspace_id` is now `NOT NULL` on all three tables.

## Pre-flight (verified)

Migration script first checks for cross-workspace key collisions on the OLD keys. With all rows currently `workspace_id = 'default-workspace'`, there are zero collisions to worry about:

```
[migrate]   org_studio_agent_metrics: 0 cross-workspace collisions ✓
[migrate]   org_studio_settings: 0 cross-workspace collisions ✓
[migrate]   org_studio_heartbeats: 0 cross-workspace collisions ✓
```

The migration aborts if any pre-flight collision is found, so this guard remains in place if the migration is re-run after multi-workspace data lands.

## Exact DDL (forward)

The migration script (`migrations/1388-a4-schema-workspace-id-conflict-keys.mjs`) emits these statements. All are idempotent — re-running the script is safe and a no-op once applied.

```sql
-- 1. agent_metrics
UPDATE org_studio_agent_metrics SET workspace_id = 'default-workspace' WHERE workspace_id IS NULL;
ALTER TABLE org_studio_agent_metrics ALTER COLUMN workspace_id SET NOT NULL;
CREATE UNIQUE INDEX CONCURRENTLY ux_agent_metrics_ws_agent_date_section
  ON org_studio_agent_metrics (workspace_id, agent_id, date, COALESCE(section_id, ''::text));
DROP INDEX IF EXISTS ux_agent_metrics_agent_date_section;

-- 2. settings (transactional swap)
UPDATE org_studio_settings SET workspace_id = 'default-workspace' WHERE workspace_id IS NULL;
ALTER TABLE org_studio_settings ALTER COLUMN workspace_id SET NOT NULL;
BEGIN;
  ALTER TABLE org_studio_settings DROP CONSTRAINT org_studio_settings_pkey;
  ALTER TABLE org_studio_settings ADD PRIMARY KEY (workspace_id, id);
COMMIT;

-- 3. heartbeats (transactional swap)
UPDATE org_studio_heartbeats SET workspace_id = 'default-workspace' WHERE workspace_id IS NULL;
ALTER TABLE org_studio_heartbeats ALTER COLUMN workspace_id SET NOT NULL;
BEGIN;
  ALTER TABLE org_studio_heartbeats DROP CONSTRAINT org_studio_heartbeats_pkey;
  ALTER TABLE org_studio_heartbeats ADD PRIMARY KEY (workspace_id, agent_id);
COMMIT;
```

Backups were taken before this ran:

```
data/backups/pre-1388-a4-schema-2026-05-18T19-19-53Z.json
  org_studio_agent_metrics: 255 rows
  org_studio_settings:        1 row
  org_studio_heartbeats:      8 rows
```

The backup file contains full row dumps + the original index/constraint definitions for each table.

## Code changes

Source-level changes needed so the new ON CONFLICT clauses match the new keys. All committed together with the migration script.

| File | Change |
|---|---|
| `src/lib/heartbeats.ts:60` | `ON CONFLICT (agent_id)` → `ON CONFLICT (workspace_id, agent_id)` |
| `src/lib/store-provider.ts:707` | settings INSERT: `ON CONFLICT (id)` → `ON CONFLICT (workspace_id, id)` |
| `src/lib/store-provider.ts:1136` | settings INSERT (updatePartial): same |
| `src/lib/store-provider.ts:1267` | agent_metrics INSERT: `ON CONFLICT (agent_id, date, COALESCE(section_id,''))` → `ON CONFLICT (workspace_id, agent_id, date, COALESCE(section_id,''))`, plus include `workspace_id` in the column list / values (it was missing) |
| `src/lib/store-provider.ts:1311` (`getMetrics`) | Add `workspace_id = $1` to SELECT WHERE |
| `src/lib/store-provider.ts:1363` (`getTeamMetrics`) | Same |
| `scripts/test-workspace-isolation.mjs` | A.4-schema TODO assertions flipped to hard assertions; all test ON CONFLICT clauses updated to use the new keys |

## Verification

1. **Pre-migration test run:** Hard A.4-schema assertions FAILED (as expected — schema didn't have the keys yet). 53 passed, 3 failed.
2. **Post-migration test run:** **56 passed, 0 failed, 2 deferred TODOs.** All slice-A TODOs closed.
3. **Live binary sanity:** cross-workspace upserts verified end-to-end via probe script — same `agent_id`, `(agent_id, date)`, and `settings.id` now coexist in `default-workspace` and `other-workspace` without overwriting each other.
4. **Service logs:** no errors after restart at BUILD_ID `Wb6hipo1qlRLnSZw3k11F`.

```
Results: 56 passed, 0 failed, 2 todos (deferred)
✅ All hard isolation assertions passed.
```

## Reversibility (rollback path)

**This is forward-only DDL.** The migration is not auto-reversible. If you need to roll back:

1. **Code revert** (safe, easy):
   ```bash
   git revert <merge-commit-of-1388>
   npm run deploy
   ```
   This restores the old `ON CONFLICT (agent_id)` etc. clauses. The schema still has the new (workspace_id, ...) keys — Postgres will accept the *narrower* ON CONFLICT clause as long as the new index/PK is **strictly more selective** than the old one. **This is the safe operating point for a code-only rollback.**

2. **Full schema rollback** (rare — only if the new PKs cause production trouble):
   ```sql
   -- heartbeats: restore old PK
   BEGIN;
     ALTER TABLE org_studio_heartbeats DROP CONSTRAINT org_studio_heartbeats_pkey;
     -- WARNING: this will fail if multi-workspace data has landed (multiple
     -- rows per agent_id). Restore from backup first if so.
     ALTER TABLE org_studio_heartbeats ADD PRIMARY KEY (agent_id);
   COMMIT;

   -- settings: restore old PK
   BEGIN;
     ALTER TABLE org_studio_settings DROP CONSTRAINT org_studio_settings_pkey;
     ALTER TABLE org_studio_settings ADD PRIMARY KEY (id);
   COMMIT;

   -- agent_metrics: restore old unique index
   CREATE UNIQUE INDEX CONCURRENTLY ux_agent_metrics_agent_date_section
     ON org_studio_agent_metrics (agent_id, date, COALESCE(section_id, ''::text));
   DROP INDEX ux_agent_metrics_ws_agent_date_section;
   ```

3. **Full data rollback** (catastrophic only): restore each table from the timestamped backup in `data/backups/pre-1388-a4-schema-*.json`. The backup contains the original row data + the original constraints/indexes definitions.

## Notes for future work

- A.4-schema closes the multi-workspace gap for these 3 hot-path tables. The audit identifies several other tables (`watchdog_pauses`, `bootstrap_pings`, `skill_installs`) where the PK is also `(agent_id, ...)` without `workspace_id` — those are **decision #6 system-global tables** in the slice-A decisions doc and intentionally remain single-keyed for now.
- The `heartbeats` sweep in `lib/heartbeats.mjs` scans heartbeats fleet-wide (across all workspaces) by design; the new PK doesn't change that — it just means the same agent_id can appear once per workspace and each row is swept independently. This is the intended behavior.
- `agent_metrics` previously had no `workspace_id` in the INSERT — that was a latent bug, fixed here while the surrounding code was being touched.
