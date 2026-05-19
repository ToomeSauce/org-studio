# 1392 — Vision-doc rename hygiene: GC orphan vision_docs rows

**Status:** Shipped. GC script + isolation test in place. Live DB state currently clean (zero orphans).

**Reversibility:** GC script writes a snapshot to `org_studio_vision_docs_backup` AND a JSON file under `data/backups/` before deleting anything. Restoring an accidentally-deleted vision_doc is one `INSERT … SELECT FROM org_studio_vision_docs_backup` away.

---

## 1. What the ticket asked

> *Currently a renamed project leaves its old vision_docs row behind keyed on the previous project id. Discovered during #1387 B.2 smoke testing — I overwrote a stale proj-mc orphan that had been left behind from the proj-mc → proj-org-studio rename, mistook it for live data, and triggered a false alarm. Fix: at project-rename time, UPDATE org_studio_vision_docs SET project_id=new WHERE project_id=old (or DELETE if old is unreferenced). Add a one-time GC script for existing orphans. Doneness: scripts/test-workspace-isolation.mjs gains a rename test verifying the vision_docs row follows the project and no orphans remain after rename.*

## 2. Investigation findings

### 2a. There is no project-rename API path

`updateProject` in `/api/store/route.ts:1670` accepts `{ id, updates }` and calls `provider.updateProject(id, updates)` — but it updates the `data` JSON blob, not the row's primary key `id`. There is no `renameProject` action, no SQL helper, nothing in `roadmap-rename.ts` that renames a project (that file is about roadmap version row id rewrites, a different scope).

The `proj-mc → proj-org-studio` rename referenced in the ticket was a **hand-edit** — either a direct SQL UPDATE or a one-off script run by Basil/me. That hand-edit didn't think about all the FK tables.

### 2b. Five tables key off `project_id`

```
org_studio_kudos
org_studio_roadmap_versions
org_studio_tasks
org_studio_vision_docs
(+ *_backup historical tables, intentionally excluded)
```

Any future hand-rename will orphan rows in **all five**, not just vision_docs. But this ticket is scoped to vision_docs only — the rest are out of scope (and would be cleanly solved by adding a real `renameProject` API action, see §5).

### 2c. Current DB state: zero orphans

```sql
SELECT v.project_id, v.workspace_id
FROM org_studio_vision_docs v
LEFT JOIN org_studio_projects p
  ON v.project_id = p.id AND v.workspace_id = p.workspace_id
WHERE p.id IS NULL;
-- → 0 rows
```

The earlier `proj-mc` orphan was already cleaned up (presumably during #1387 B.2 work or by Basil manually). So the "one-time GC for existing orphans" doesn't have any rows to chew on right now — but the script needs to exist for the next time someone hand-renames.

## 3. What I shipped

### 3.1 `scripts/gc-orphan-vision-docs.mjs`

- Idempotent: zero orphans → exit 0, no work
- `--dry-run` flag for report-only
- Live mode: snapshots to `org_studio_vision_docs_backup` AND a JSON file under `data/backups/vision-docs-gc-<stamp>.json`, then deletes in one transaction with ROLLBACK on error
- Connects via `process.env.DATABASE_URL`; Postgres-only (errors out if unset)
- Clearly documents the broader-scope gap in its header comment

### 3.2 Isolation test in `scripts/test-workspace-isolation.mjs`

- **Static assertions:** script exists, has `--dry-run`, uses `LEFT JOIN on org_studio_projects`, snapshots to backup table, wraps mutations in BEGIN/COMMIT/ROLLBACK
- **Functional test (Postgres-gated):** insert a fake orphan, run the script live, assert the orphan is gone and the snapshot is in the backup table, run again and assert it's a no-op
- Cleans up the backup-table snapshot at end so the test leaves no residue

### 3.3 Verified end-to-end

```
=== insert fake orphan ===
inserted: test-orphan-1392-1779151387814

=== dry-run reports 1 orphan ===
Found 1 orphan vision_docs row(s)
(dry-run — no rows deleted.)

=== live run deletes it ===
📦 Snapshotted 1 row(s) to org_studio_vision_docs_backup
🗑️  Deleted 1 orphan row(s) from org_studio_vision_docs
💾 JSON snapshot: data/backups/vision-docs-gc-2026-05-19T00-43-10-175Z.json

=== verify gone (no-op) ===
✅ No orphans. Nothing to do.
```

## 4. What this ticket does NOT do (deliberately)

- **No `renameProject` API action.** That's a bigger ticket — needs to atomically update 5 tables in one transaction, plus deal with `org_studio_projects.id` PK rewrite (which cascades through every FK row). #1392 only asked for vision_docs cleanup.
- **No prevention for the other 4 tables.** If someone hand-renames again, `tasks`/`roadmap_versions`/`kudos` will still orphan. The GC script does NOT clean those up — it's vision_docs only, matching the ticket.
- **No automatic GC trigger.** The script is run-on-demand. If we want it cronned, that's a one-line addition to `cron.json` once we have an upstream rename feature.

## 5. Recommended follow-up

**Single ticket — `renameProject` action** with proper FK update:

```sql
BEGIN;
UPDATE org_studio_projects        SET id = $new WHERE id = $old AND workspace_id = $ws;
UPDATE org_studio_tasks            SET project_id = $new WHERE project_id = $old AND workspace_id = $ws;
UPDATE org_studio_vision_docs      SET project_id = $new WHERE project_id = $old AND workspace_id = $ws;
UPDATE org_studio_roadmap_versions SET project_id = $new WHERE project_id = $old AND workspace_id = $ws;
UPDATE org_studio_kudos            SET project_id = $new WHERE project_id = $old AND workspace_id = $ws;
COMMIT;
```

That makes hand-renames safe and obviates the need for this GC script (though leaving the script in place is fine — it's defensive).

Until that lands, **anyone hand-renaming a project should run `scripts/gc-orphan-vision-docs.mjs` immediately after** to clean up the vision_docs side. Document this in the team runbook / ORG.md once we have one.

---

*Author: mikey · Date: 2026-05-18 · Branch: mikey/1392-vision-doc-rename-hygiene*
