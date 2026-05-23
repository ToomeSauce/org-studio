# API Reference — Org Studio

Complete API schemas and examples for all Org Studio endpoints.

## Table of Contents
- [Store API (Tasks & Projects)](#store-api)
- [Roadmap API](#roadmap-api)
- [Vision Docs API](#vision-docs-api)
- [Kudos & Flags API](#kudos--flags-api)
- [ORG Context API](#org-context-api)
- [Error Handling](#error-handling)

---

## Store API

### GET /api/store

Returns all projects, tasks, and settings.

```json
{
  "projects": [{ "id": "proj-mc", "name": "Org Studio", "currentVersion": "1.6", ... }],
  "tasks": [{ "id": "...", "title": "...", "status": "backlog", "assignee": "Ana", "version": "1.6", ... }],
  "settings": { "teammates": [...], "values": {...}, "missionStatement": "..." }
}
```

### POST /api/store — addTask

```json
{
  "action": "addTask",
  "task": {
    "title": "Implement authentication",
    "projectId": "proj-123",
    "status": "backlog",
    "assignee": "AgentName",
    "version": "0.1",
    "description": "Optional detailed description",
    "doneWhen": "Optional acceptance criteria",
    "constraints": "Optional boundaries",
    "testPlan": "Optional QA test plan"
  }
}
```

Response: `{ "ok": true, "task": { "id": "...", "ticketNumber": 42, ... } }`

### POST /api/store — updateTask

```json
{
  "action": "updateTask",
  "id": "task-id",
  "updates": {
    "status": "done",
    "reviewNotes": "Summary of what was done.\n\nVerification:\n✅ Build passes\n✅ Tests pass"
  }
}
```

Valid statuses: `backlog`, `planning`, `in-progress`, `qa`, `review`, `done`, `blocked`

Status changes automatically:
- Add to `statusHistory` with timestamp and model info
- Trigger notifications to Basil via Telegram
- Wake the assigned agent (for backlog) or QA agent (for qa)

### POST /api/store — addComment

```json
{
  "action": "addComment",
  "taskId": "task-id",
  "comment": {
    "author": "AgentName",
    "content": "Progress update with @Ana mention if needed",
    "type": "comment"
  }
}
```

Response includes `mentions` field if any `@Name` patterns matched teammates.

### POST /api/store — listComments

Fetch comments for a task (or any scope) from the normalized `org_studio_comments` table. Use this when you need the **full text** of a comment whose wake-event preview was truncated, or when you need to scan the thread on a ticket programmatically.

**Don't** read `task.comments[]` from the GET snapshot — the normalized table is the canonical source as of v0.4.0; the JSONB column is being retired (Phase 2b/3, blocked).

**Two accepted request shapes:**

_Canonical (works in all releases):_

```json
{
  "action": "listComments",
  "scope": { "kind": "task", "taskId": "<task-id>" },
  "limit": 50,
  "before": 1779574556315
}
```

_Shorthand (v0.4.0+, common case):_

```json
{
  "action": "listComments",
  "taskId": "<task-id>",
  "limit": 50
}
```

When both `scope` and top-level `taskId` are present, `scope` wins.

**Parameters:**

| Field | Required | Default | Description |
|---|---|---|---|
| `scope.kind` | yes (canonical) | — | Currently only `"task"` is written in practice; `"project"` exists historically. Section/board/dm shapes are reserved. |
| `scope.taskId` | yes (canonical) | — | Task id whose comments to fetch. |
| `taskId` | yes (shorthand) | — | Top-level shorthand; auto-promoted to `{kind:"task",taskId}`. |
| `limit` | no | `50` | Max comments returned. |
| `before` | no | `now()+1` | Epoch ms cursor for paging older history (returns comments with `createdAt < before`). |

**Response (200):**

```json
{
  "ok": true,
  "comments": [
    {
      "id": "qy5ttz0fmpiwqr9g",
      "author": "Ana",
      "content": "...full comment body, no truncation...",
      "createdAt": 1779574556315,
      "type": "comment",
      "model": "claude-opus-4.7",
      "mentions": ["Henry"],
      "scope": { "kind": "task", "taskId": "<task-id>" }
    }
  ]
}
```

Comments are returned in ascending `createdAt` order (oldest first within the page). Defense-in-depth: the route layer strips all audit metadata (`auditMeta`, `data.audit`) before responding — #1506 / v0.3.x.

**Error (400) — missing both `scope` and `taskId`:**

```json
{
  "error": "Missing scope",
  "hint": "listComments requires a comment scope, not an auth scope. Send `scope: { kind: 'task', taskId: '<id>' }`. As of #1536 you can also pass `taskId` at the top level as shorthand for the common case."
}
```

**This is a comment-scope error, not an auth-scope / API-key-permission error.** Agent API keys can call `listComments` against any task in their workspace.

**Curl examples:**

```bash
# Shorthand
curl -X POST http://localhost:4501/api/store \
  -H "Authorization: Bearer $ORG_STUDIO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"listComments","taskId":"wouzqrebmonn5zaw","limit":3}'

# Canonical with paging cursor
curl -X POST http://localhost:4501/api/store \
  -H "Authorization: Bearer $ORG_STUDIO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"listComments","scope":{"kind":"task","taskId":"wouzqrebmonn5zaw"},"limit":50,"before":1779574556315}'
```

### POST /api/store — addHandoff

Inject context for another agent's task (e.g., resolving a blocker):

```json
{
  "action": "addHandoff",
  "taskId": "task-id",
  "author": "YourName",
  "message": "Fixed the DB schema — the column is now nullable"
}
```

This posts a system comment, clears any loop pause, and triggers the assignee immediately.

---

## Roadmap API

### GET /api/roadmap/{projectId}

```json
{
  "versions": [
    {
      "id": "rv-proj-mc-1-6",
      "version": "1.6",
      "title": "Metrics-Driven Coaching",
      "status": "planned",
      "items": [
        { "title": "Inject delivery metrics into ORG.md", "done": false },
        { "title": "Auto-generate coaching insights", "done": true }
      ],
      "progress": { "done": 1, "total": 2 },
      "shipped_at": null,
      "sort_order": 1.6
    }
  ]
}
```

### POST /api/roadmap/{projectId} — upsert (legacy create-or-replace)

> **Prefer `create` for new versions and `patch` for partial updates** (see below). `upsert` is kept for the rename flow (`originalVersion`) and any caller that genuinely wants create-or-replace semantics. New code should reach for `create`/`patch` so a missing field can't silently clobber existing data.

Create or update a version:

```json
{
  "action": "upsert",
  "version": "1.6",
  "title": "Metrics-Driven Coaching",
  "status": "planned",
  "versionType": "outcome",
  "items": [
    { "title": "Inject metrics into ORG.md", "done": false },
    { "title": "Auto coaching insights", "done": false }
  ]
}
```

Response: `{ "action": "upserted", "version": "1.6", "id": "rv-proj-mc-1-6", "items": [{ ...with auto-minted ids }] }`

Valid `status` values: `planned`, `current`, `shipped`.
Valid `versionType` values: `outcome`, `foundation`, `chore`, `qa`, `gtm` (default `outcome`). Out-of-set values are rejected with `400 invalid_version_type` (DB CHECK + API guard — added in #1461).

**Single-current invariant** (#1461): setting `status: "current"` when another version on this `(workspace_id, project_id)` is already `current` returns `409 multi_current_rejected`. Demote the existing one to `shipped` or `planned` first.

### POST /api/roadmap/{projectId} — create (#1461)

Strict create-only path. Use this when you're adding a new version.

1. **`title` is required.** Missing/empty title → `400 missing_title`.
2. **Rejects duplicates.** Version already exists → `409 version_exists` (hint: use `patch` instead).
3. **Owner inheritance.** If `owner` is not provided, it's resolved from the project's primary component (first non-qa / non-support component, falling back to first component, then `project.owner` / `project.devOwner`, then `null`). The response includes `ownerInherited: true` when this fallback fired.

```json
{
  "action": "create",
  "version": "0.4.0",
  "title": "Listeners can resume across devices",
  "status": "planned",
  "versionType": "outcome",
  "owner": "basil",
  "items": [
    { "title": "Sync read-position to user record", "done": false }
  ],
  "successCriteria": "...",
  "metricTarget": 300,
  "metricComparator": "lte"
}
```

Response:

```json
{
  "action": "created",
  "version": "0.4.0",
  "id": "rv-proj-mc-0-4-0",
  "title": "Listeners can resume across devices",
  "status": "planned",
  "version_type": "outcome",
  "owner": "basil",
  "ownerInherited": true,
  "items": [{ "id": "item-xxx-...", "title": "...", "done": false }],
  "shadowSync": { "sectionsHit": 1, "componentsHit": 0, "touched": true }
}
```

Single-current invariant applies the same way it does for `upsert`.

### POST /api/roadmap/{projectId} — patch (#1461)

COALESCE-by-default partial update. Use this when you want to change one or two fields on an existing version without re-sending the rest of the row.

```json
{
  "action": "patch",
  "version": "0.4.0",
  "title": "...",
  "status": "current",
  "versionType": "qa",
  "owner": "mikey",
  "items": [{ "title": "new item", "done": false }],
  "items_mode": "merge",
  "successCriteria": "...",
  "metricCurrent": 120,
  "loopPaused": true
}
```

Rules:

- Version must already exist (`404 version_not_found` otherwise).
- Omitting a field = leave it alone (COALESCE).
- `items_mode: "replace"` (default) swaps the entire items array. `"merge"` upserts by `id` and appends id-less newcomers to the end.
- `successCriteria` / `metricTarget` / `metricComparator` / `loopPaused` / `metricCurrent` are merged with the existing `meta` jsonb (partial). Sending `null` for one of them clears that specific key.
- Transitioning to `status: "current"` enforces the single-current invariant (409). Transitioning away from `current` is unconstrained.
- Provided values are type-checked: bad `status` → 400 `invalid_status`, bad `versionType` → 400 `invalid_version_type`, non-array `items` → 400 `invalid_items`, bad `items_mode` → 400 `invalid_items_mode`, empty `title` → 400 `invalid_title`.

**Real-world example — link a roadmap item to an existing task without disturbing anything else:**

```bash
curl -X POST "http://localhost:4501/api/roadmap/$PROJECT_ID" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ORG_STUDIO_API_KEY" \
  -d '{
    "action": "patch",
    "version": "0.18.18",
    "items": [{ "id": "item-practice-sidebar-role-...", "taskId": "u80a7b9vmpddzotx" }],
    "items_mode": "merge"
  }'
```

No need to re-send title, status, owner, the other three items, or any meta fields. `patch` + `merge` only touches the row you addressed.

**Outcome-bound version fields** (all optional, additive — absence = no metric gate). These work the same way on `create`, `patch`, and `upsert`:

```json
{
  "action": "upsert",
  "version": "0.5",
  "title": "Cut p95 dispatch latency in half",
  "successCriteria": "p95 dispatch latency under 300ms over a 24h window",
  "metricTarget": 300,
  "metricCurrent": 420,
  "metricComparator": "lte",
  "loopPaused": false
}
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `successCriteria` | string | unset | Sets the gate. Empty/unset = no gate (behaves as before). |
| `metricTarget` | number | unset | Target value. |
| `metricCurrent` | number | unset | Most recent measurement. |
| `metricComparator` | `'gte' \| 'lte' \| 'eq'` | `'gte'` | How to compare. |
| `loopPaused` | boolean | `false` | Human kill-switch — dispatch stops when `true`. |

When `successCriteria` is set, the version will NOT auto-complete or auto-advance until `metricCurrent` satisfies `metricComparator` vs `metricTarget`, even if every child ticket is `done`. A one-shot `📊 Outcome-bound: metric not met` system comment is posted on the version (idempotent across reruns). Defense-in-depth: project promotion also re-checks the metric after the approval-horizon gate.

**Caps that come with an outcome-bound version:**
- Up to `5` concurrent in-progress tasks per outcome-bound version (`MAX_OPEN_EXPERIMENTS`).
- Up to `3` agent-created versioned spike tickets per UTC day per version (`MAX_AUTO_TASKS_PER_VERSION_PER_DAY` — `POST /api/store {action:"addTask"}` returns `429` past this cap).

### POST /api/roadmap/{projectId} — delete

```json
{
  "action": "delete",
  "version": "1.6"
}
```

### POST /api/roadmap/{projectId} — reorder

```json
{
  "action": "reorder",
  "order": ["0.1", "0.2", "1.0"]
}
```

### GET|POST /api/admin/roadmap-audit (#1461)

Admin/audit endpoint. **Detect-only — never mutates rows.** Bearer + write scope required.

Reports rows that violate one of these data-quality invariants:

| Finding | Meaning |
|---|---|
| `multi_current` | More than one row with `status='current'` for the same `(workspace_id, project_id)`. Blocks the partial unique index from migration #1461. |
| `empty_title` | `title IS NULL` or whitespace-only — version card renders with no human-readable label. |
| `missing_owner` | `owner IS NULL`/empty — version has no responsible party; auto-dispatch falls back to project-level defaults. |
| `unknown_version_type` | `version_type` outside `{outcome, foundation, chore, qa, gtm}`. Should be empty post-#1461 CHECK constraint. |

Response shape:

```json
{
  "ok": true,
  "summary": { "multi_current": 1, "empty_title": 9, "missing_owner": 12, "unknown_version_type": 0 },
  "findings": {
    "multi_current": [{ "workspace_id": "...", "project_id": "...", "count": 2, "versions": [...], "ids": [...] }],
    "empty_title":   [{ "workspace_id": "...", "project_id": "...", "version": "...", "id": "..." }],
    "missing_owner": [...],
    "unknown_version_type": [...]
  },
  "next_action": "multi_current_violations_must_be_resolved_manually_then_rerun_migration_1461"
}
```

Per ticket #1461: this endpoint never auto-repairs historical bad data. Use it to find rows that need a human triage decision.


---

## Vision Docs API

### GET /api/vision/{projectId}/doc

```json
{
  "doc": "# Project Name\n\n## North Star\n...\n\n## Parking Lot\n..."
}
```

### PUT /api/vision/{projectId}/doc

```json
{
  "content": "# Updated markdown content..."
}
```

Requires Bearer token. Notifies dev/QA agents of changes.

---

## Kudos & Flags API

### GET /api/kudos

Query params: `?agentId=Ana&type=kudos&limit=20` (all optional, case-insensitive agentId match)

```json
{
  "kudos": [
    {
      "id": "abc123",
      "agentId": "Ana",
      "givenBy": "system",
      "values": ["autonomy", "people-first"],
      "note": "Ana shipped v0.904 with zero QA bounces",
      "type": "kudos",
      "autoDetected": true,
      "confirmed": true,
      "createdAt": 1775827339951
    }
  ]
}
```

### POST /api/kudos — create

```json
{
  "agentId": "Ana",
  "givenBy": "Basil",
  "values": ["autonomy"],
  "note": "Great work on the launch",
  "type": "kudos"
}
```

PACCT value slugs: `people-first`, `autonomy`, `craft`, `curiosity`, `teamwork`

### POST /api/kudos — delete

```json
{ "action": "delete", "id": "abc123" }
```

### POST /api/kudos — update

```json
{ "action": "update", "id": "abc123", "note": "Updated note", "values": ["teamwork"] }
```

---

## ORG Context API

### GET /api/org-context

Returns the ORG.md that agents read each session.

Query params:
- `?agent=mikey` — personalized with Your Domain + Performance + Coaching
- `?format=json` — structured JSON instead of markdown
- No params — generic team-wide ORG.md

The markdown includes: Mission, Values, Operating Principles, Performance (you vs team avg), Coaching insights, Your Domain, Team roster.

---

## Error Handling

Standard response format:
```json
{ "ok": true }
// or
{ "error": "Description of what went wrong" }
```

Common errors:
- `401 Unauthorized` — missing/invalid Bearer token
- `404 Not Found` — project or task doesn't exist
- `400 Bad Request` — invalid format or missing fields
