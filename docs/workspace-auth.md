# Workspace Auth — Multi-Workspace Support (v0.16)

## Overview

Org Studio v0.16 introduces multi-workspace support. All projects, tasks, and related data are scoped to a workspace. Users log in → resolve their active workspace → all queries return only data from that workspace.

**Single-workspace instances are unaffected.** When no workspace configuration exists, everything transparently uses `default-workspace`.

## Architecture

### Workspace Resolution Chain

When a request arrives, the middleware resolves the active workspace in this order:

1. **X-Workspace-Id header** — for API clients
2. **Query parameter** (`?workspace_id=...`) — for direct API calls
3. **Session cookie** (`org_studio_workspace_id`) — for browser sessions
4. **Default** — `default-workspace`

### Auth Middleware (`src/lib/workspace-auth.ts`)

The workspace auth module provides:

| Function | Purpose |
|---|---|
| `resolveWorkspaceContext(req, userId?)` | Resolves and validates workspace from request |
| `filterByWorkspace(records, workspaceId)` | Filters an array of records by workspace_id |
| `stampWorkspace(record, workspaceId)` | Stamps workspace_id on a record before mutation |
| `belongsToWorkspace(record, workspaceId)` | Checks if a record belongs to a workspace |
| `getUserWorkspaces(userId)` | Lists all workspaces a user has access to |
| `invalidateWorkspaceCache()` | Busts the workspace data cache |

### Workspace Context Type

```typescript
interface WorkspaceContext {
  id: string;      // e.g. 'default-workspace' or 'ws-abc123'
  name: string;    // Human-readable name
  owner?: string;  // Creator's userId
  createdAt?: number;
}
```

## API Enforcement

### Store API (`/api/store`)

**GET** — All results filtered by the request's workspace:
```
GET /api/store
→ Returns only projects/tasks where workspace_id matches
```

**POST** — All mutations validated and stamped:
- `addTask` / `addProject` — `workspace_id` auto-stamped from context
- `updateTask` / `updateProject` — Cross-workspace mutation returns 403
- `deleteTask` / `deleteProject` — Cross-workspace deletion returns 403
- `addComment` — Validates task belongs to current workspace

### Workspace API (`/api/workspaces`)

**GET** — Returns current workspace context and list of accessible workspaces:
```json
{
  "ok": true,
  "current": { "id": "default-workspace", "name": "Default Workspace", "owner": "system" },
  "workspaces": [{ "id": "default-workspace", "name": "Default Workspace", "owner": "system" }],
  "multiWorkspace": false
}
```

**POST** — Switch workspace:
```json
{ "action": "switch", "workspaceId": "ws-abc123" }
```

## Switching Workspaces (User Flow)

1. Go to **Settings** → **Workspace** section
2. Current workspace name, ID, and owner are displayed
3. If you belong to multiple workspaces, a **Switch Workspace** dropdown appears
4. Click the desired workspace → cookie is set → page reloads with new data
5. The workspace persists across page reloads (cookie-based)

## Database Schema

### New Columns

```sql
-- Added to org_studio_projects and org_studio_tasks
ALTER TABLE org_studio_projects ADD COLUMN workspace_id TEXT DEFAULT 'default-workspace';
ALTER TABLE org_studio_tasks ADD COLUMN workspace_id TEXT DEFAULT 'default-workspace';

-- Indexes
CREATE INDEX idx_projects_workspace_id ON org_studio_projects (workspace_id);
CREATE INDEX idx_tasks_workspace_id ON org_studio_tasks (workspace_id);
```

### New Tables

```sql
CREATE TABLE org_studio_workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  created_at BIGINT,
  data JSONB DEFAULT '{}'
);

CREATE TABLE org_studio_workspace_memberships (
  workspace_id TEXT REFERENCES org_studio_workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT DEFAULT 'member',
  joined_at BIGINT,
  PRIMARY KEY (workspace_id, user_id)
);
```

### Backfill

All existing data is backfilled with `workspace_id = 'default-workspace'`.

Run: `node scripts/migrate-workspace-id.mjs`

## Testing Cross-Workspace Isolation

### Test 1: API-Level Isolation

```bash
# Get a task from workspace-1
TASK_ID="some-task-in-ws1"

# Try to update it from workspace-2 context
curl -X POST http://localhost:4501/api/store \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Workspace-Id: workspace-2" \
  -d '{"action": "updateTask", "id": "'$TASK_ID'", "updates": {"title": "hacked"}}'

# Expected: 403 Forbidden — task belongs to another workspace
```

### Test 2: Read Isolation

```bash
# Query store from workspace-2 context
curl http://localhost:4501/api/store \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Workspace-Id: workspace-2"

# Expected: Only workspace-2 projects/tasks returned
# workspace-1 data is invisible
```

### Test 3: Backward Compatibility

```bash
# Query without any workspace context
curl http://localhost:4501/api/store \
  -H "Authorization: Bearer $API_KEY"

# Expected: All 'default-workspace' data returned
# Existing integrations continue working unchanged
```

## UI Components

### WorkspaceSwitcher (`src/components/WorkspaceSwitcher.tsx`)

Two components:
- **`WorkspaceSwitcher`** — Dropdown for switching workspaces (compact or full variant)
- **`WorkspaceInfoCard`** — Shows current workspace details (name, ID, owner, created date)

Both components fetch from `/api/workspaces` and handle the switch flow.

### Settings Page

The Settings page (`src/app/(dashboard)/settings/page.tsx`) includes a **Workspace** section at the top showing:
- Current workspace name and ID
- Owner
- Switch workspace button (if in multiple workspaces)

## Known Limitations

| Limitation | Target Version |
|---|---|
| No workspace creation flow (new workspaces) | Future 0.x |
| No admin roles/permissions | Future 0.x |
| No shared cross-workspace resources | Parking lot |
| Workspace data stored in settings (not own table for queries) | Future 0.x |
| No workspace invitations UI | Future 0.x |
| Comments table not workspace-scoped yet | v0.17+ |

## Migration Path

1. **v0.16 (current)**: Workspace_id columns added, API filtering enforced, UI switcher
2. **v0.17**: Comments table workspace_id, roadmap versions workspace_id
3. **Future OSS**: Optional workspace creation and invitation flow for trusted multi-user self-hosting

## workspace_id backfill + NOT NULL (#1622, F-13) — Runbook

**Problem (F-13):** `filterByWorkspace`/`belongsToWorkspace` coalesce a NULL
`workspace_id` to `default-workspace`. Any unstamped legacy row is therefore
visible to the default workspace. Phases 1–2 added the column + backfilled
NULLs but left it NULLABLE, so a future unstamped INSERT can re-open the leak.

**Fix:** guarantee `workspace_id` is non-null at the DB level.

**Script:** `scripts/migrate-workspace-id-phase3-notnull.mjs` (idempotent).

### Scope (target tables)
Tenant-scoped tables that already carry `workspace_id` and are read through the
workspace filter or a direct `WHERE workspace_id = $1` query:
`projects, tasks, sessions, vision_docs, api_tokens, roadmap_versions,
agent_metrics, kudos, outbox, heartbeats, incidents, settings,
workspace_memberships, admin_audit`.

**Excluded (by design):**
- `org_studio_workspaces`, `org_studio_users` — not tenant-scoped (they define
  tenants / are cross-workspace); a NOT NULL `workspace_id` is nonsensical.
- `*_backup` tables — archival, never read through the filter.
- Tables with no `workspace_id` today (`comments`, `embeddings`,
  `dispatch_attempts`, `notification_*`, `bootstrap_pings`, `skill_installs`,
  `watchdog_pauses`) — NOT filtered by workspace (comments inherit isolation via
  their parent task; the rest are operational/agent-scoped). Adding the column
  there is a new feature (see Migration Path v0.17+), not a backfill.

### Step 1 — backfill + verify (reversible, ships to `done`)
```
node scripts/migrate-workspace-id-phase3-notnull.mjs
```
Ensures the column exists, UPDATEs any NULL → `default-workspace`, and asserts
**0 NULLs per table** (exits 1 if any remain). This is the DONE-WHEN check.
Verified 2026-06-04: 0 NULLs across all 14 target tables.

### Step 2 — apply NOT NULL (IRREVERSIBLE; human sign-off required)
Do **not** run against the cloud DB until #1622 is signed off.
```
CONFIRM_NOT_NULL=yes node scripts/migrate-workspace-id-phase3-notnull.mjs --apply-not-null
```
Re-verifies 0 NULLs, then `ALTER COLUMN workspace_id SET NOT NULL` on each
still-nullable target inside a single transaction. The `CONFIRM_NOT_NULL=yes`
env guard prevents accidental firing. (6 tables are already NOT NULL and are
skipped; 8 remain to be constrained: projects, tasks, sessions, vision_docs,
roadmap_versions, kudos, outbox, incidents.)

### Rollback
- **Backfill (Step 1):** reversible by design — it only sets a column that
  already defaults to `default-workspace`.
- **NOT NULL (Step 2):** literal SQL reversal, per constrained table:
  ```
  ALTER TABLE <table> ALTER COLUMN workspace_id DROP NOT NULL;
  ```
  "Irreversible" in the operational sense: once enforced in prod, any INSERT
  path that forgets to stamp `workspace_id` starts erroring. Before apply,
  confirm every INSERT supplies it (auth.ts / api-tokens.ts / outbox.ts /
  heartbeats.ts / launch-prep.ts all default to `default-workspace` — verified
  2026-06-04). If an unstamped path surfaces post-apply, run the DROP NOT NULL
  above + redeploy.

**Regression test:** `src/__tests__/workspace-id-backfill-1622.test.ts` locks the
filter semantics (explicit isolation + the documented NULL→default legacy path)
so the coalesce isn't accidentally tightened before NOT NULL is enforced.
