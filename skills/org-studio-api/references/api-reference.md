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

### POST /api/roadmap/{projectId} — upsert

Create or update a version:

```json
{
  "action": "upsert",
  "version": "1.6",
  "title": "Metrics-Driven Coaching",
  "status": "planned",
  "items": [
    { "title": "Inject metrics into ORG.md", "done": false },
    { "title": "Auto coaching insights", "done": false }
  ]
}
```

Response: `{ "action": "upserted", "version": "1.6", "id": "rv-proj-mc-1-6" }`

Valid `status` values: `planned`, `current`, `shipped`

**Outcome-bound version fields** (all optional, additive — absence = no metric gate):

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

PACT value slugs: `people-first`, `autonomy`, `curiosity`, `teamwork`

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
