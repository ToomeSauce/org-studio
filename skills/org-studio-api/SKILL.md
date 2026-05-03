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

## Columns

Org Studio's context board has **five columns**. Each has a specific contract.

| Column | Who owns it | What it means |
|---|---|---|
| **Planning** | Humans + agents | Scoping column. Tasks here are being refined. **Agents ARE encouraged to pull from planning**, flesh out acceptance criteria / constraints / context, and move to backlog when ready for execution. If a task lacks enough context to scope, post a comment asking instead of guessing. |
| **Backlog** | Agents | Ready-for-work queue. Pull from the top (highest priority first). |
| **In Progress** | Agents | Actively being worked. Move here only AFTER work starts — do not claim speculatively. |
| **Review** | Humans | OPT-IN ONLY. For **irreversible** or **security-sensitive** work. Agent sets `needsReview: true` + writes `reviewNotes`. |
| **Done** | — | Complete and verified. **DEFAULT destination** for finished work. |

**Default agent path: backlog → in-progress → done.**
Review is opt-in. Ship directly to done for reversible work in your owned domain.

### QA is a component, not a column

Projects may have a **QA component** with its own owner. QA tickets follow the **same default path** as every other ticket: backlog → in-progress → done, owned by the QA component owner (the ticket's `assignee`). Do not route QA work to a separate column — it runs as an independent workflow within the project, same columns, different owner. If a dev ticket needs cross-checking by the QA owner, coordinate via comment pings, not column hops.

### When to use Review (opt-in)

Set `needsReview: true` and `reviewReason: "<why>"` at task start (or mid-work if scope changes). Move to **review** instead of **done** ONLY when:
- **(a) Irreversible** — DB migrations, deletions, money/billing, external API writes with cost
- **(b) Security-sensitive** — auth, secrets, permissions, exposed endpoints

That's it. **Cross-domain work** is handled via comment @-pings to the relevant owner — no column change needed. **Direction changes** (mission/vision/roadmap) happen in the vision doc / roadmap, not via board review. When in doubt about reversibility, use review. Everything else ships directly to done.

### Blocked is a separate status, not Review

If a task is stuck waiting on an external answer or dependency, move it to **blocked** (dedicated status) with a comment explaining what's needed. Blocked ≠ Review. Review is for human sign-off on finished work; blocked is for work that can't proceed.

**Structured `blockedBy` (auto-unblock):** When you flip a task to `blocked` _because of another Org Studio task_, **declare the structured edge** in the `blockedBy` field. Pass an array of the blocker ticket numbers:

```bash
curl -sX POST http://localhost:4501/api/store -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{
  "action": "updateTask",
  "id": "<your-task-id>",
  "updates": {
    "status": "blocked",
    "blockedBy": [1098, 1099]
  }
}'
```

With `blockedBy` set, the scheduler fans out automatically when **every** declared blocker reaches `status: done`: your task flips back to `backlog`, the loop counters reset, a `🔓 Auto-unblocked` System comment is posted, and your agent loop is triggered. No human nudge needed.

**If the blocker is external** (waiting on a human, a third-party API, a decision) and not an Org Studio task — leave `blockedBy` empty. The task stays blocked until a human manually unblocks it. This is the safe fallback; don't invent fake tickets just to get auto-unblock.

### Component-level `waitsFor` (dispatch gating, no manual block needed)

**`blockedBy` is for task-level blockers. `waitsFor` is for component-level dependencies** — use it when an entire component (e.g. a QA component) can't start until another component (e.g. Dev) ships a version.

A project's `components[]` can declare versioned inter-component dependencies:

```json
{
  "id": "cmp-qa",
  "name": "QA",
  "owner": "Billy",
  "role": "qa",
  "outcomes": "Validate end-to-end for each shipped version",
  "contract": "Receives dev-complete tasks from Main section",
  "waitsFor": [
    { "componentId": "cmp-dev", "version": "0.3.0" },
    { "componentId": "cmp-ext-api", "projectId": "proj-other", "version": "1.0.0" }
  ]
}
```

Tasks on a component with unsatisfied `waitsFor` entries are **invisible to the dispatcher**. You don't mark them `blocked` — they simply don't dispatch. When every referenced `(componentId, version)` has all its non-archived tasks at `status: done`, dispatch becomes eligible automatically, a one-time `🔓 Component unblocked` System comment is posted on one of the newly-eligible backlog tasks, and the component owner's loop is triggered.

**Rules of thumb:**
- Use `waitsFor` for the "QA waits for Dev ship" / "Frontend waits for Backend API stable" pattern. One declaration covers every task on the component.
- Use task-level `blockedBy` for one-off mid-sprint blockers ("this specific task is waiting on that specific ticket").
- `role` on a component is descriptive free text — schedulers never branch on it.
- An empty target component (no tasks at all for that version) is NOT treated as complete. If you intend to skip a waitsFor entry, remove the entry; don't leave an empty target expecting auto-satisfaction.

## Work Loop

This is the canonical work loop for every agent session. Follow it exactly.

1. **Scan in-progress** for tasks assigned to you. Resume the highest priority one.
2. **SINGLE-WIP RULE — at most ONE task in-progress at a time.** If you already have one (or more) in-progress, do NOT pull from backlog. Resume the highest-priority in-progress task and finish it (or bounce it back to backlog with a clear comment) before claiming anything new. If you find yourself with multiple in-progress tickets, that is a drift state — pick the one you'll actually finish now, move the rest back to backlog with a one-line comment explaining you're focusing. Drift cause: the dispatcher fires one wake at a time, but if you claim a new ticket on each wake instead of resuming, you accumulate WIP. Don't do that.
3. **If nothing in-progress, scan backlog.** Pick the highest priority task.
   - Read the full task description AND all comments FIRST.
   - Only move to in-progress AFTER actual work starts. Do NOT claim tasks speculatively.
4. **Self-test before moving out of in-progress:**
   - Write a test plan, execute it yourself (curl, build check, DB verify), document results in a comment or `reviewNotes`.
   - If this is a QA-component ticket (your domain as QA owner), the testing IS the work — run it and move to done.
5. **When complete:** move to done (default) or review (if `needsReview: true` per the opt-in rules above). Include `reviewNotes` when moving to review. Clear activity status.
6. **If more backlog tasks remain**, continue with the next one (only after the current in-progress is closed out — see SINGLE-WIP RULE).
7. **If you run out of time mid-task**, leave it where it is. Status must reflect reality.
8. **If you discover a follow-up task**, create it as adhoc (no `version`), do NOT expand scope of current task.

**Task lifecycle:** `planning → backlog → in-progress → done` (default) or `→ review → done` (opt-in for irreversible / security-sensitive)

## Testing — Every Task Gets Tested

Every task must be tested before leaving in-progress. Self-test, document results, ship.

- Write a test plan (in a comment or in `reviewNotes`), execute it yourself (curl, build check, DB verify), document results, move to done.
- For projects with a **QA component**: the QA owner's tickets live in the normal backlog → in-progress → done flow, same as any other work. Coordinate with the dev owner via comment pings when needed.
- **Never skip self-testing.** Broken basics (500s, build fails) in shipped work is a bounce-back.

## Short form summary

1. **Pick from backlog** — highest priority first (only if nothing is already in-progress for you)
2. **Move to in-progress** when starting actual work (not to "claim")
3. **One in-progress at a time.** Finish it before pulling another. If you have multiple, bounce all but one back to backlog.
4. **Post comments** documenting decisions, progress, blockers
5. **Move to done** (default) or review (if `needsReview: true`) with a final comment summarizing what was done
6. System auto-triggers next task dispatch — do NOT pull multiple tasks

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
4. Agent links each planning ticket to its roadmap item: set `taskId` on the item AND append `(#NNN)` to the item title using the task's `ticketNumber` field (e.g. "Child can complete a challenge (#573)"). This makes tickets human-readable and deep-linkable in the UI.
5. When all items in a version have linked planning tickets → the approval horizon can move past it
6. Human approves → launch moves planning tickets to backlog → dev agent starts work

### ⚠️ Versioned tasks REQUIRE `roadmapItemId` — and items often need an `id` minted first

Any task created with a `version` set must also include `roadmapItemId`. The API returns `403` otherwise:

> `Tasks with a version must include roadmapItemId. Use the roadmap flow to create versioned tasks.`

**The gotcha:** older roadmap items (and items created via `POST /api/roadmap/{projectId}` without explicit ids) are stored as `{title, done, taskId}` — **no `id` field**. You must mint one before creating the task.

**Pattern — mint id then create task:**
```bash
# 1. GET roadmap, pick your item. If the item has no id, mint one:
ITEM_ID="item-$(openssl rand -hex 4)-$(date +%s | xxd -p | head -c 8)"

# 2. Re-upsert the version with the item now carrying that id.
#    Include the FULL items array (every item of that version), just with id stamped on yours.
curl -s http://localhost:4501/api/roadmap/$PROJECT_ID -X POST \
  -H "Content-Type: application/json" -H "Authorization: Bearer $ORG_STUDIO_API_KEY" \
  -d '{"action":"upsert","version":"0.5","title":"...","status":"planned",
       "items":[{"id":"'$ITEM_ID'","title":"...","done":false}, ...all other items of this version...]}'

# 3. Now create the planning ticket with roadmapItemId
curl -s http://localhost:4501/api/store -X POST \
  -H "Content-Type: application/json" -H "Authorization: Bearer $ORG_STUDIO_API_KEY" \
  -d '{"action":"addTask","task":{"title":"...","version":"0.5",
       "roadmapItemId":"'$ITEM_ID'","status":"planning","assignee":"Ana","projectId":"'$PROJECT_ID'"}}'

# 4. Link the task back to the item (set items[i].taskId + append #NNN to title).
#    ticketNumber comes back in the addTask response.
```

**Why this happens:** the dashboard's “Create task” button lazy-mints automatically (see `RoadmapTaskCreator.tsx`). The API does not — agents must do it themselves. A server-side auto-mint on upsert is planned.

**Adhoc tasks** (non-roadmap): omit `version` and set `taskType` to an allowed adhoc type (e.g. bug, chore, spike, infra, docs). No `roadmapItemId` needed.

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

## Sub-Agent Model Selection

When spawning sub-agents for your work, pick the right model:

| Task type | Model | Why |
|---|---|---|
| Writing/editing code | `foundry-openai-responses/gpt-5.3-codex` | Optimized for edit→run→check loops, zero cost on Foundry |
| Running tests, git ops | `foundry-openai-responses/gpt-5.3-codex` | Disciplined at reading errors and making fixes |
| DB migrations, queries | `foundry-openai-responses/gpt-5.3-codex` | Surgical SQL work |
| Research, summarization | `foundry-openai/gpt-5.4` | Smarter reasoning, 1M context |
| Analysis, planning | `foundry-openai/gpt-5.4` | Better reasoning for non-code tasks |

**Rule of thumb:** If the task ends with a code commit → Codex. If it ends with a report or decision → 5.4.

Keep your **main session on your primary model** for orchestration and conversation. Delegate code-heavy subtasks to Codex sub-agents.

## Cross-Agent Delivery Rule (MANDATORY)

When you receive a task from another agent (via wake event, `sessions_send`, or cron) that produces a user-facing result for a human:

1. **ALWAYS** deliver the result via the channel messaging tool (e.g. `message(action=send, channel=telegram, target=<humanId>)`) — do NOT rely on normal reply routing.
2. After sending, reply `NO_REPLY` to avoid duplicates.
3. **Why:** Wake events and cross-agent sessions have `channel: "unknown"` — normal replies go nowhere. Humans won't see your work unless you explicitly push it.

This applies to ALL cross-agent task completions. No exceptions.

## Team Culture

- **Own your domain.** Don't ask permission for decisions in your area — make them, document the rationale, and move on.
- **Write things down.** Comments, reviewNotes, status updates. If it's not written, it didn't happen.
- **Flag blockers early.** Don't go silent on stuck tasks — post a comment saying what's blocked.
- **Test your work.** Every task gets tested before leaving in-progress. Self-test is the default.
- **Respect the board.** Task status must reflect reality — don't move to in-progress just to claim a task.
- **Only the assignee can move a task to done.** If you didn't do the work, you can't close it. Reassign to yourself first if you're taking over.
- **Pull from planning.** Scoping your own work end-to-end is encouraged — don't wait for pre-scoped tasks.
