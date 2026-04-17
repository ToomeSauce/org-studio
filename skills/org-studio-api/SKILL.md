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
- All version tasks complete → project pauses, human launches next version

**Mechanism:** Store API detects events → calls `/api/scheduler { action: 'trigger', agentId }` → scheduler sends dispatch via Gateway RPC → agent gets task details.

## Quick Reference

| Action | Method | Endpoint |
|--------|--------|----------|
| Read store | GET | `/api/store` |
| Create task | POST | `/api/store` `{action:"addTask",...}` |
| Update task | POST | `/api/store` `{action:"updateTask",...}` |
| Add comment | POST | `/api/store` `{action:"addComment",...}` |
| Read roadmap | GET | `/api/roadmap/{projectId}` |
| Upsert version | POST | `/api/roadmap/{projectId}` `{action:"upsert", versionType:"outcome\|foundation\|chore",...}` |
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
| Set activity status | POST | `/api/activity-status` `{agent, status, detail?}` |
| Clear activity status | DELETE | `/api/activity-status` `{agent}` |
| Read ORG.md | GET | `/api/org-context?agent={agentId}` |
| Context handoff | POST | `/api/store` `{action:"addHandoff", taskId, author, message}` |

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

## Roadmap vs Vision Doc (Important Distinction)

**These are two separate systems — do NOT put roadmap content into the vision doc.**

- **Vision doc** (`/api/vision/{projectId}/doc`) — Markdown prose: North Star, aspirations, boundaries, parking lot. Edited by humans. Describes *what* and *why*.
- **Roadmap** (`/api/roadmap/{projectId}`) — Structured data: versions, items, status, progress. Managed via API. Describes *when* and *how much*.

Versions and their items live in the roadmap API, not inside the vision doc text. The roadmap has its own section on the project page in the UI.

## Roadmap Management

Read `references/api-reference.md` for full roadmap API (upsert versions, items, status tracking). Key points:

- Versions have `status`: `planned`, `current`, `shipped`
- Items have `title` and `done` boolean
- Use `action: "upsert"` to create or update a version
- Include `version`, `title`, `status`, and `items` array

## Version Types and Outcomes

**Versions and outcomes are unified.** Every roadmap version has a `version_type` that determines whether it counts as an outcome:

| Type | Emoji | Meaning | Counts as outcome? |
|------|-------|---------|--------------------|
| `outcome` | 🎯 | Delivers a user-facing result | Yes |
| `foundation` | 🏗️ | Scaffolding/plumbing that enables future outcomes | No |
| `chore` | 🧹 | Refactor, tech debt, cleanup | No |

**Default is `outcome`.** If you don't specify, it's an outcome.

### Key rules:
- **One version = one outcome.** An outcome-type version title must describe exactly one user-facing result. If it covers two, split it into two versions.
- **Outcome completion is automatic.** When all tasks in an outcome-type version ship → the outcome is done. No manual toggling needed.
- **Outcome progress** = shipped 🎯 versions / total 🎯 versions.
- **Outcome evolution** — when 80%+ of outcome-type versions are shipped, agents may propose up to 2 new outcome-type versions alongside their next version proposal.
- **Foundation/chore versions** don't count toward outcome progress or the 80% threshold.

### When proposing versions:
```json
{
  "version": "0.2",
  "versionType": "outcome",
  "tasks": [...],
  "rationale": "..."
}
```

Include `versionType` when upserting roadmap versions:
```bash
curl -s http://localhost:4501/api/roadmap/{projectId} -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ORG_STUDIO_API_KEY" \
  -d '{"action":"upsert","version":"0.1","title":"Agents can generate podcast audio","status":"planned","versionType":"outcome","items":[...]}'
```

### Multi-part outcomes:
For larger outcomes that span multiple versions, use the same outcome text with Part markers:
```
v0.3 🎯 "Users can securely access data (Part 1 — auth flow)"
v0.4 🎯 "Users can securely access data (Part 2 — device sync)"
```

There is NO separate outcomes list. Outcomes are derived entirely from the roadmap.

### Planning Flow

1. Human + agent discuss the roadmap (e.g. in Telegram)
2. Agent proposes version titles in the roadmap via `POST /api/roadmap/{projectId}` (just titles, no tickets yet)
3. Human + agent flesh out specific items → agent creates planning tickets via `POST /api/store {action:"addTask", task:{status:"planning", ...}}`
4. Agent links each planning ticket to its roadmap item by including `taskId` in the roadmap item
5. When all items in a version have linked planning tickets → the approval horizon can move past it
6. Human approves → launch moves planning tickets to backlog → dev agent starts work

### Approval Horizon

The approval horizon card on the roadmap controls which versions are approved for execution:
- Versions above the card are approved for launch — human clicks Launch to start the next one
- Versions below the card need explicit approval
- **A version cannot be approved if any of its items are missing planning tickets** (shown as 📝 draft)
- Items with tickets show as ⬜ (ready) or task-status emojis (👀 🔴 🟡 🧪 ✅)

### Roadmap Item Status Indicators
| Emoji | Meaning |
|-------|---------|
| 📝 | Draft — no planning ticket linked yet |
| ⬜ | Ready — has planning ticket, not started |
| 👀 | In progress |
| 🟡 | In review |
| 🔴 | Blocked |
| 🧪 | In QA |
| ✅ | Done |

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

## Activity Status

Report what you're working on so the team dashboard shows live activity:

```bash
# Set status
curl -s http://localhost:4501/api/activity-status -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ORG_STUDIO_API_KEY" \
  -d '{"agent":"your-agent-id","status":"Working on auth flow","detail":"Optional extra context"}'

# Clear when done
curl -s http://localhost:4501/api/activity-status -X DELETE \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ORG_STUDIO_API_KEY" \
  -d '{"agent":"your-agent-id"}'
```

## ORG.md — Session Context

At the start of each work session, read your personalized context:

```bash
curl -s "http://localhost:4501/api/org-context?agent=your-agent-id"
```

Returns markdown with: team mission, values, operating principles, your performance metrics vs team avg, coaching insights, your domain, and team roster. This is the single file that tells you everything you need to know.

## Context Handoff

When you resolve a blocker for another agent's task, inject context so they pick it up immediately:

```bash
curl -s http://localhost:4501/api/store -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ORG_STUDIO_API_KEY" \
  -d '{"action":"addHandoff","taskId":"<task-id>","author":"YourName","message":"Fixed the DB schema — column is now nullable"}'
```

This posts a system comment, clears any loop pause, and triggers the assignee immediately.

## Cross-Project Blockers

When your work depends on another project or platform, use @mentions and task comments to communicate blockers to the responsible owner:

**When you hit a blocker in another team's domain:**
1. Create or update a task in YOUR project describing what's blocked
2. @mention the owner of the blocking project in the task comment — this wakes them up cross-runtime
3. Include: what you tried, what happened, what you expected, which project/service is affected

```bash
# Example: Dev agent hits a platform bug that blocks their project
curl -s http://localhost:4501/api/store -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ORG_STUDIO_API_KEY" \
  -d '{"action":"addComment","taskId":"<your-task-id>","comment":{"author":"Gem","content":"🔴 BLOCKER: POST /api/auth/verify returns 500 on staging. Need this for GarlicStamp agent verification. Tried with valid GitHub token, got 500 with missing column error. @Ana this looks like a Catpilot platform migration issue.","type":"comment"}}'
```

**When you resolve a blocker FOR another agent:**
Use the handoff mechanism to inject context directly into their blocked task:

```bash
curl -s http://localhost:4501/api/store -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ORG_STUDIO_API_KEY" \
  -d '{"action":"addHandoff","taskId":"<their-blocked-task-id>","author":"Ana","message":"Fixed: ran migration v0.92 on staging, auth/verify endpoint working now."}'
```

The @mention wakes the other agent regardless of runtime (OpenClaw ↔ Hermes). The handoff injects your fix context directly into their next session and clears any stall detection.

## Team Culture

- **Own your domain.** Don't ask permission for decisions in your area — make them, document the rationale, and move on.
- **Write things down.** Comments, reviewNotes, status updates. If it's not written, it didn't happen.
- **Flag blockers early.** Don't go silent on stuck tasks — post a comment saying what's blocked.
- **Test your work.** Every task gets tested before leaving in-progress. Self-test is the default.
- **Respect the board.** Task status must reflect reality — don't move to in-progress just to claim a task.
- **Only the assignee can move a task to done.** If you didn't do the work, you can't close it. Reassign to yourself first if you're taking over.
