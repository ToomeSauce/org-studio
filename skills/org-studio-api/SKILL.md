---
name: org-studio-api
description: Interact with Org Studio — the org design and task management platform for hybrid human+AI teams. Use when creating/updating tasks, reading/writing roadmaps, managing vision docs, querying agent metrics, or understanding how event-driven task dispatch works. Covers all Org Studio REST APIs including store (tasks/projects), roadmap (versions), vision docs, kudos/flags, metrics, coaching insights, and weekly digests. Also explains the push-based trigger system — task assignments automatically wake agents, no polling needed.
---

# Org Studio API

Org Studio is a Next.js dashboard for managing hybrid human+agent teams. Agents interact via REST APIs.

## Base URL

```
http://localhost:4501
```

## Authentication

**POST requests** require Bearer token:
```
Authorization: Bearer <ORG_STUDIO_API_KEY>
```
**GET requests** are unauthenticated.

## Event-Driven Triggers (Push-Based)

Org Studio uses **push-based triggers** — not polling. When work lands in an agent's backlog, the system automatically wakes the agent. Never set up polling crons as a workaround.

**What triggers automatically:**
- Task created/moved to `backlog` → assigned agent wakes immediately
- Task moves to `qa` → QA agent wakes
- Task bounces from QA → dev agent wakes
- Task reassigned while in-progress → new assignee wakes
- Version approved/launched → creates backlog tasks + triggers dev agent
- All version tasks complete → auto-advance checks for next version

**Mechanism:** Store API detects events → calls `/api/scheduler { action: 'trigger', agentId }` → scheduler sends dispatch via Gateway RPC → agent gets task details.

## Quick Reference

| Action | Method | Endpoint |
|--------|--------|----------|
| Read store | GET | `/api/store` |
| Create task | POST | `/api/store` `{action:"addTask",...}` |
| Update task | POST | `/api/store` `{action:"updateTask",...}` |
| Add comment | POST | `/api/store` `{action:"addComment",...}` |
| Read roadmap | GET | `/api/roadmap/{projectId}` |
| Upsert version | POST | `/api/roadmap/{projectId}` `{action:"upsert",...}` |
| Delete version | POST | `/api/roadmap/{projectId}` `{action:"delete",...}` |
| Read vision doc | GET | `/api/vision/{projectId}/doc` |
| Update vision doc | PUT | `/api/vision/{projectId}/doc` |
| Read ORG.md | GET | `/api/org-context?agent={agentId}` |
| Read kudos | GET | `/api/kudos?agentId={id}&limit=20` |
| Create kudos | POST | `/api/kudos` |
| Team metrics | GET | `/api/metrics/team` |
| Agent metrics | GET | `/api/metrics/{agentId}?limit=7` |
| Quality scorecard | GET | `/api/metrics/quality-scorecard` |
| Coaching insights | GET | `/api/metrics/coaching-insights?agent={id}` |
| Weekly digest | GET | `/api/metrics/weekly-digest` |

For detailed API schemas and examples, read `references/api-reference.md` in this skill directory.

## Task Workflow

```
backlog → in-progress → [qa] → review → done
```

1. **Pick from backlog** — highest priority first
2. **Move to in-progress** when starting actual work (not to "claim")
3. **Post comments** documenting decisions, progress, blockers
4. **Move to done** with `reviewNotes` summarizing what was done + verification checklist
5. System auto-triggers next task dispatch — do NOT pull multiple tasks

### Status Update Example

```bash
curl -s http://localhost:4501/api/store -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ORG_STUDIO_API_KEY" \
  -d '{"action":"updateTask","id":"<task-id>","updates":{"status":"in-progress"}}'
```

### Comment Example

```bash
curl -s http://localhost:4501/api/store -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ORG_STUDIO_API_KEY" \
  -d '{"action":"addComment","taskId":"<task-id>","comment":{"author":"YourName","content":"Approach: using X because Y","type":"comment"}}'
```

## Roadmap Management

Read `references/api-reference.md` for full roadmap API (upsert versions, items, status tracking). Key points:

- Versions have `status`: `planned`, `current`, `shipped`
- Items have `title` and `done` boolean
- Use `action: "upsert"` to create or update a version
- Include `version`, `title`, `status`, and `items` array

## Metrics & Performance

Agents see a **Performance** section in their ORG.md (`GET /api/org-context?agent=X`) with:
- You vs Team Avg table (throughput, first-pass rate, bounces, active days)
- 7-day trend
- Auto-generated coaching insights

Read `references/metrics-reference.md` for the full metrics API surface.

## @Mentions

Include `@AgentName` in comment content to notify another agent cross-runtime:
```json
{"action":"addComment","taskId":"...","comment":{"author":"Gem","content":"@Ana can you check the auth middleware?","type":"comment"}}
```
Matches against teammate name or agentId (case-insensitive). Notifications route cross-runtime (Hermes ↔ OpenClaw).
