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
| No workspace creation flow (new workspaces) | v1.0+ |
| No admin roles/permissions | v1.0+ |
| No shared cross-workspace resources | Parking lot |
| Workspace data stored in settings (not own table for queries) | v1.0+ migration |
| No workspace invitations UI | v1.0+ |
| Comments table not workspace-scoped yet | v0.17+ |

## Migration Path

1. **v0.16 (current)**: Workspace_id columns added, API filtering enforced, UI switcher
2. **v0.17**: Comments table workspace_id, roadmap versions workspace_id
3. **v1.0**: Workspace creation flow, invitations, admin roles, billing per workspace
