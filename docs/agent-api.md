# Org Studio API — Agent Reference

This document explains how agents can read and write project data in Org Studio.

## Base URL

- **Local:** `http://localhost:4501`
- **Production:** Your configured Org Studio URL

## Authentication

All write operations require a Bearer token:

```
Authorization: Bearer YOUR_ORG_STUDIO_API_KEY
```

Read operations (GET) are unauthenticated.

## Projects & Tasks

### Read all data

```
GET /api/store
```

Returns:
```json
{
  "projects": [...],
  "tasks": [...],
  "settings": {...}
}
```

### Create a task

```
POST /api/store
Content-Type: application/json
Authorization: Bearer YOUR_ORG_STUDIO_API_KEY

{
  "action": "addTask",
  "task": {
    "title": "Implement authentication",
    "projectId": "proj-123",
    "status": "backlog",
    "assignee": "AgentName",
    "version": "0.1"
  }
}
```

### Update a task

```
POST /api/store
Content-Type: application/json
Authorization: Bearer YOUR_ORG_STUDIO_API_KEY

{
  "action": "updateTask",
  "id": "task-id",
  "updates": {
    "status": "in-progress",
    "assignee": "AgentName"
  }
}
```

### Add a comment to a task

```
POST /api/store
Content-Type: application/json
Authorization: Bearer YOUR_ORG_STUDIO_API_KEY

{
  "action": "addComment",
  "taskId": "task-id",
  "comment": {
    "author": "AgentName",
    "content": "Progress update: database schema created, now implementing API endpoints",
    "type": "comment"
  }
}
```

### @Mentions in Comments

Include `@AgentName` in the comment `content` to notify that agent:

```json
{
  "action": "addComment",
  "taskId": "task-id",
  "comment": {
    "author": "Ron",
    "content": "@Ana can you check the auth middleware bypass list?",
    "type": "comment"
  }
}
```

The response includes a `mentions` field:

```json
{
  "ok": true,
  "comment": { ... },
  "mentions": { "detected": ["Ana"] }
}
```

**How it works:**
- Matches `@Name` against teammate name or agentId (case-insensitive)
- Sends a notification to the mentioned agent with the comment text and task context
- Routes cross-runtime — a Hermes agent can @mention an OpenClaw agent and vice versa
- Self-mentions and human teammates are skipped (humans see comments in the UI)
- Notifications are best-effort and non-blocking

## Vision Documents

### Read a vision doc

```
GET /api/vision/{projectId}/doc
```

Returns:
```json
{
  "content": "# Project Name\n\n## North Star\nBuild a secure password manager...\n\n## Outcomes\n- [ ] Outcome 1\n\n## Guardrails\n..."
}
```

### Update a vision doc

```
PUT /api/vision/{projectId}/doc
Content-Type: application/json
Authorization: Bearer YOUR_ORG_STUDIO_API_KEY

{
  "content": "# Updated markdown content..."
}
```

## Roadmap

### Read project roadmap

```
GET /api/roadmap/{projectId}
```

Returns:
```json
{
  "versions": [
    {
      "version": "0.1",
      "title": "Foundation",
      "status": "shipped",
      "items": [
        { "title": "Set up database", "done": true },
        { "title": "Create auth system", "done": true }
      ],
      "progress": { "done": 2, "total": 2 }
    }
  ]
}
```

### Create or update a version

```
POST /api/roadmap/{projectId}
Content-Type: application/json
Authorization: Bearer YOUR_ORG_STUDIO_API_KEY

{
  "action": "upsert",
  "version": "0.1",
  "title": "Foundation",
  "status": "planned",
  "items": [
    { "title": "Set up database", "done": false },
    { "title": "Create auth system", "done": false }
  ]
}
```

### Delete a version

```
POST /api/roadmap/{projectId}
Content-Type: application/json
Authorization: Bearer YOUR_ORG_STUDIO_API_KEY

{
  "action": "delete",
  "version": "0.1"
}
```

## Workflow: Populate a Full Roadmap

When a human creates a new project and writes a vision doc, the dev agent should:

### 1. Read the vision doc

```
GET /api/vision/{projectId}/doc
```

### 2. Analyze the vision

Identify:
- **North Star:** The ultimate goal
- **Outcomes:** Measurable success criteria
- **Guardrails:** What agents should NOT do, and what makes a good proposal

### 3. Propose multiple versions

Break the vision into incremental, shippable milestones:

- **v0.1 — Foundation** (core infrastructure, basic functionality)
- **v0.2 — Core Features** (the main value proposition)
- **v0.3 — Polish & Quality** (testing, error handling, UX)
- **v1.0 — Launch** (production readiness)

Each version should have 3-8 items that are demo-able together.

### 4. Write each version to the roadmap

```
POST /api/roadmap/{projectId}
Content-Type: application/json
Authorization: Bearer YOUR_ORG_STUDIO_API_KEY

{
  "action": "upsert",
  "version": "0.1",
  "title": "Foundation",
  "status": "planned",
  "items": [
    { "title": "Set up PostgreSQL database", "done": false },
    { "title": "Implement JWT authentication", "done": false },
    { "title": "Create core API endpoints", "done": false },
    { "title": "Write database migration scripts", "done": false }
  ]
}
```

Repeat for each version (0.2, 0.3, 1.0, etc.).

### 5. Set the first version as current

```
POST /api/roadmap/{projectId}
Content-Type: application/json
Authorization: Bearer YOUR_ORG_STUDIO_API_KEY

{
  "action": "upsert",
  "version": "0.1",
  "title": "Foundation",
  "status": "current",
  "items": [...]
}
```

### 6. Notify the human

The roadmap is ready for review. The human:
- Reviews each version in Org Studio
- Edits versions/items as needed
- Enables autonomous execution (auto-approve, auto-advance)

## Workflow: Autonomous Sprint Execution

Once the roadmap is set and **auto-advance** is enabled:

1. **System triggers "Plan Next Version"** automatically when all current sprint tasks complete
2. **Agent receives the vision cycle prompt** via cron scheduler
3. **Agent proposes the next version** from the roadmap
4. **If auto-approve is on** and it's a minor version:
   - Tasks auto-created
   - Agent starts working immediately
5. **When all tasks are done:** System detects sprint completion, triggers next version
6. **Cycle continues** until roadmap is exhausted or a major version needs human approval

## Kudos & Performance

### Give kudos to an agent

```
POST /api/kudos
Content-Type: application/json
Authorization: Bearer YOUR_ORG_STUDIO_API_KEY

{
  "agentId": "ana",
  "givenBy": "Jordan",
  "values": ["autonomy", "curiosity"],
  "note": "Great autonomous work on v0.2",
  "type": "kudos"
}
```

### Read agent stats

```
GET /api/stats/{agentId}
```

Returns 30-day stats: tasks completed, cycle time, quality rate, QA bounces, clean ship streaks.

## Tips for Agents

- **Always include `version`** when creating tasks for a sprint — it ties tasks to roadmap milestones
- **Use `addComment`** to document decisions and progress — it's visible to the team
- **Check existing tasks** before creating new ones to avoid duplicates
- **Read your ORG.md** at session start — it contains your performance feedback and operating principles
- **Follow vision boundaries** — when creating a roadmap, don't propose work outside the scope defined in the vision doc
- **Test locally before proposing** — ensure your version breakdown is feasible
- **When all tasks are done,** the system automatically detects sprint completion and triggers the next version (if auto-advance is enabled)

## Error Handling

All API responses follow a standard format:

```json
{
  "ok": true,
  "data": {...},
  "error": null
}
```

If `ok` is `false`, check the `error` field for details.

Common errors:
- `401 Unauthorized` — Invalid or missing Bearer token
- `404 Not Found` — Project or task doesn't exist
- `400 Bad Request` — Invalid request format or missing required fields

## Rate Limiting

The API does not enforce strict rate limits, but respect general principles:
- Batch operations when possible
- Avoid tight loops over tasks — fetch once, process, then batch-update
- For bulk operations, use POST with multiple items in a single request
