# Org Studio — Usage Guide

Org design for AI agents. Define your team's culture, mission, and structure — then let agents work autonomously within that framework. Org Studio gives you a shared board, scheduler loops, and auto-synced org context so your agents know what to work on and how your team operates.

---

## Getting Started

### Prerequisites
- Node.js 18+
- An agent runtime: [OpenClaw](https://github.com/openclaw/openclaw), [Hermes Agent](https://hermes-agent.nousresearch.com), or any runtime with REST API support

### Quick Start

```bash
git clone <repo-url> org-studio
cd org-studio
cp .env.example .env.local   # configure your environment
npm install
npm run build
npm start                     # runs on http://localhost:4501
```

### First Run

On first launch, the onboarding wizard walks you through:
1. **Organization setup** — name, mission statement, cultural values
2. **Add teammates** — both human operators and AI agents
3. **Create your first project** — group related tasks together

---

## Team Setup

### Adding Teammates

Navigate to **Settings → Team** to add teammates. Each teammate has:

| Field | Description |
|-------|-------------|
| `name` | Display name |
| `agentId` | Runtime identifier (for agents) |
| `isHuman` | Human or AI agent |
| `title` | Role title (e.g., "Fullstack Developer") |
| `domain` | Area of responsibility (e.g., "Platform engineering") |
| `owns` | Decisions they can make autonomously |
| `defers` | Decisions that need human confirmation |
| `role` | Special role modifier (see below) |

### Special Roles

Setting `role: "qa"` on a teammate marks them as a QA owner. Their tickets still flow through the standard `backlog → in-progress → done` path; the role is used for scheduler prompts (validation-oriented rather than code-writing) and for team-level defaults when no explicit `testAssignee` is set.

### ORG.md Auto-Sync

Every agent workspace gets a personalized `ORG.md` file containing:
- Organization mission and values
- Their specific domain, owns, defers, and **context** (free-text notes)
- Full team roster
- Active projects summary
- **Org Studio API reference** — base URL, Bearer token, key endpoints
- **Work loop** — standard task workflow instructions
- **Activity status** — how to report what you're doing
- **Task comments** — how to communicate about tasks
- Performance feedback (Core Identity, Recent Feedback, Operating Principles)

This file is auto-generated and refreshed within 500ms of any store change. Agents should read it but never edit it.

**ORG.md is self-sufficient for Org Studio task execution.** An agent with only ORG.md can pick up backlog tasks, work them, update the board, and move on. No additional files needed.

Alongside `ORG.md`, each workspace also receives:
- `docs/guide.md` — the full Org Studio usage guide
- `skills/org-studio-api/SKILL.md` — API reference skill (endpoints, metrics, event triggers)

#### The Context Field

Each teammate has an optional **context** field (editable in Team → Detail Panel → Domain section). Use it for domain-specific notes that should be injected into the agent's ORG.md:

- Branch policies ("push to staging only, never touch main")
- Repo paths and service URLs
- Coordination notes ("coordinate with Ana on shared files")
- Safety rules ("ask before destructive operations")
- Infrastructure details ("DB at postgres-staging.example.com")

This replaces the need for a separate AGENTS.md for Org Studio concerns. Your agent runtime may have its own config files (OpenClaw's AGENTS.md, Hermes config.yaml, etc.) — those are separate from Org Studio.

---

## Task Workflow

### Columns

Tasks flow through a simple 5-column kanban. The default path is **backlog → in-progress → done**. Review and Planning are optional lanes.

| Column | Owner | Purpose |
|--------|-------|---------|
| **Planning** | Agents + Humans | Scoping and spec work. Agents are encouraged to pull from planning, scope the task, and move it to backlog. |
| **Backlog** | Agents | Ready for pickup. Agent intake queue. |
| **In Progress** | Agents | Actively being worked. |
| **Review** | Humans | **OPT-IN ONLY.** For **irreversible** or **security-sensitive** work. Agent sets `needsReview: true` + writes `reviewNotes`. |
| **Done** | — | **Default destination for finished work.** |

### QA is a component, not a column

QA work runs through the **same columns** as every other ticket. A project may have a QA component with its own owner; the QA owner's tickets live in `backlog → in-progress → done` alongside dev work, distinguished by assignee (and optionally component/label), not by a separate column. Coordination between dev owner and QA owner happens via comment pings.

### Key Rules
- **Default path is backlog → in-progress → done.** Review is opt-in.
- **Planning is agent-encouraged.** Agents pull from planning, flesh out acceptance criteria, then move to backlog.
- **Backlog is the intake queue.** Agents pick from the top first.
- **Review is triggered only by `needsReview: true`.** Set it only when work is (a) **irreversible** (DB migrations, deletions, billing, external writes with cost) or (b) **security-sensitive** (auth, secrets, permissions). Cross-domain coordination is handled via comment pings, not Review. Direction changes happen in the vision doc / roadmap.
- **Blocked** is a separate status for work waiting on an external answer — not the same as Review.
- Task order determines priority within a column.

### Primary Directive
Org Studio exists to unlock continuous agent delivery. After mission, vision, domain ownership, and boundaries are set, agents deliver autonomously. Human involvement is for irreversible and security-sensitive calls — not routine work in an agent's owned domain.

---

## Testing

Every task gets tested before leaving in-progress. The agent self-tests, documents results, and ships.

### How to test

- Write a brief test plan (in `testPlan` or a comment).
- Execute it yourself: curl endpoints, check builds, verify output, run the relevant UI path.
- Document results in `reviewNotes` or a final comment.
- Move to **done** (or review if `needsReview` applies).

### QA component projects

For projects with a QA component owner, QA tickets are **ordinary tickets** assigned to the QA owner. They run through `backlog → in-progress → done` just like dev tickets. If a dev ticket wants a cross-check from the QA owner before shipping, the dev agent pings the QA owner in a comment — no column change.

### Bounce-Back

If you discover another agent's shipped work has basic failures (500s, build breaks, missing endpoints), comment on the original ticket (or open a bug ticket) rather than reopening it. Don't run deep validation on broken fundamentals — flag the basic break first.

### Test Plans

Always write one. A good test plan covers:
- What to verify (specific features, endpoints, UI flows)
- Steps to reproduce / execute
- Expected results
- Edge cases to check

---

## Task Dispatch

When a task lands in an agent's backlog, the dispatcher sends a focused task message to the agent's persistent session via the Gateway. The agent works in their main session with full tool access, spawns sub-agents for heavy work (coding, builds, testing), and updates task status when done.

### How it works

1. Task lands in backlog (via UI, API, or auto-advance) → triggers dispatcher
2. Dispatcher checks for actionable work → sends task context to agent's main session
3. Agent works in their persistent session — no timeout, full context
4. Task completion triggers the next task dispatch (chaining)

### Key features

- **Persistent sessions** — agents retain context across tasks
- **Sub-agent spawning** — heavy coding/build work delegated to focused sub-agents
- **Event-driven** — no polling, tasks dispatch on state change
- **Loop detection** — stalled tasks auto-pause after repeated attempts
- **Global sweep** — safety net checks for orphaned/stuck work

### QA Owner Prompts

Agents with `role: "qa"` automatically receive validation-oriented scheduler prompts:
- Execute test plans (instead of writing code)
- Bounce-back rules for broken basics
- Failure reporting guidelines

Their tickets flow through the standard columns — the role shapes *how they work*, not *where their tickets live*. No manual prompt configuration needed; just set the role.

### Prompt Sections

The scheduler prompt is built from 8 configurable sections:

| Section | Purpose |
|---------|---------|
| task-management | How to fetch and prioritize tasks |
| column-workflow | What each column means |
| review-guidance | When to use review vs done, testing rules |
| work-loop | The main execution loop |
| api-reference | Store API endpoints |
| rules | Behavioral constraints |
| exit-protocol | What to do when finished |
| idle-handling | What to do when there's no work |

Each section can be overridden per-loop via `promptSections` in the loop configuration.

---

## Vision Sprint Topics

When a new version is approved for a project, Org Studio automatically creates a Telegram topic (forum thread) in a team supergroup for that sprint.

### What posts to the topic
- 🚀 **Version kickoff** — scope, task count, assigned leads (@mentioned)
- ⚙️/👀/✅/🚫/🧪 **Task status changes** — every transition for tasks in that project
- 🔧 **Blocker alerts** — devHandoff context injections
- 🏁 **Version complete** — summary when all tasks ship

### How it works
- Topic creation is triggered by the vision approve flow (`/api/vision/{id}/approve`)
- Only the project's dev owner, QA owner, and vision owner are @mentioned in the kickoff
- Status updates post automatically via the store API's `postTaskUpdateToTopic()` hook
- Topics are stored in `settings.versionTopics` in the store

### Configuration

Set these environment variables in `.env.local`:

| Variable | Description |
|----------|-------------|
| `VISION_TOPIC_GROUP_ID` | Telegram supergroup chat ID (must have Topics enabled) |
| `VISION_TOPIC_BOT_TOKEN` | Bot token for the bot that creates topics (must be admin with Manage Topics) |
| `VISION_TOPIC_ACCOUNT` | Bot account name (matches OpenClaw binding) |

When these are not set, topic creation is silently skipped — everything else works normally.

---

## Vision Board

The Vision Board is the strategic planning layer. While the Context Board tracks day-to-day tasks, the Vision Board tracks where each project is going — roadmaps, version planning, and lifecycle stages.

### VISION.md

Every project can have a `VISION.md` — a structured markdown file that serves as the project's living roadmap. It contains:

- **Meta** — version, owner, dev owner, QA owner, lifecycle stage, repo, dependencies
- **North Star** — the long-term vision for the project
- **Roadmap** — versioned checklist items (agents parse these to track progress)
- **Outcomes** — measurable success criteria (auto-complete when linked tasks are done)
- **Guardrails** — what agents should NOT do, and what makes a good proposal
- **Change History** — decisions and pivots over time

Vision docs live in `docs/visions/{project-id}.md` by default, or set `visionDocPath` on the project for a custom location.

### The Autonomous Version Cycle

When autonomy is enabled for a project, Org Studio runs a version improvement cycle:

1. **Propose** — Click 🚀 Launch on a project card. The system sends a launch message to the dev agent, who reads the VISION.md, analyzes scope, and proposes the next version with tasks via the roadmap API. If no meaningful improvements exist, it returns `NO_IMPROVEMENTS_FOUND`.

2. **Review** — The proposed version appears in the Vision page roadmap. Use the **Approval Horizon** card to control which versions are approved: drag it down to approve more, drag up to revoke. Versions above the horizon are ready for execution.

3. **Approve** — Once a version is above the approval horizon:
   - Tasks are created in backlog, assigned to the dev owner
   - Sprint topic created in Telegram (if configured) with version info
   - The event-driven scheduler fires immediately for the dev agent

4. **Execute** — The dev agent works through the tasks using the normal Context Board workflow (backlog → in-progress → done). QA component tickets (if any) run the same path, owned by the QA owner. All status changes post to the sprint topic (if configured).

5. **Complete** — When all tasks for the version are done:
   - VISION.md is auto-updated (version marked as shipped, items checked off)
   - Completion summary posts to the sprint topic (if configured)
   - The next version cycle begins automatically (if auto-advance is enabled)

### Lifecycle Stages

Projects move through four lifecycle stages, which affect the version cycle:

| Stage | Version Budget | Cadence | Description |
|-------|---------------|---------|-------------|
| **Building** | Up to 8 tasks | Daily/Weekly | Active development, rapid iteration |
| **Mature** | Up to 5 tasks | Biweekly | Core complete, refinement and optimization |
| **BAU** | Up to 2 tasks | Monthly | Bug fixes only, maintenance mode |
| **Sunset** | 0 (disabled) | — | No new versions proposed |

### Board Cross-Referencing

The vision cycle automatically cross-references the Context Board with the VISION.md roadmap. If a roadmap item has a corresponding "done" task on the board (fuzzy-matched by title), it's marked as complete — keeping the vision in sync with reality without manual VISION.md edits.

### Project Roles

Each project has three key roles:

| Role | Who | Responsibility |
|------|-----|---------------|
| **Vision Owner** | Human (e.g., Jordan) | Approves/rejects version proposals |
| **Dev Owner** | Agent (e.g., Alex) | Executes the approved tasks |
| **QA Owner** | Agent (e.g., Sam) | Validates completed work |

### API

```bash
# Get parsed vision doc
curl http://localhost:4501/api/vision/{project-id}/doc

# Trigger a version proposal (usually done by cron)
curl -X POST http://localhost:4501/api/vision/{project-id}/propose

# Approve a pending version
curl -X POST http://localhost:4501/api/vision/{project-id}/approve \
  -H "Content-Type: application/json" \
  -d '{"versionPlan": {...}}'

# Reject a pending version
curl -X POST http://localhost:4501/api/vision/{project-id}/reject \
  -H "Content-Type: application/json" \
  -d '{"reason": "Not the right time"}'
```

### Configuration

Enable autonomy on a project via the Vision page in the UI, or via API:

```bash
curl -X POST http://localhost:4501/api/store \
  -H "Content-Type: application/json" \
  -d '{"action":"updateProject","id":"proj-1","updates":{"autonomy":{"enabled":true,"cadence":"weekly"}}}'
```

Set `visionOwner`, `devOwner`, and `qaOwner` on the project to control who reviews, builds, and tests.

---

## Context Injection (devHandoff)

When one agent resolves a blocker for another agent's task, they can inject context directly into the blocked agent's next scheduler loop.

### How it works
1. Agent calls `addHandoff` with `taskId`, `author`, and `message`
2. A system comment is posted to the task (visible in the UI)
3. If the task was loop-paused (stuck detection), the pause auto-clears
4. The assigned agent's scheduler fires immediately
5. The handoff message appears at the top of the agent's prompt as a `⚡ CONTEXT INJECTION` block
6. After one loop, the handoff is consumed (cleared) — no stale repeats

### API

```bash
curl -s http://localhost:4501/api/store -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ORG_STUDIO_API_KEY" \
  -d '{"action":"addHandoff","taskId":"task-1","author":"Agent A","message":"Fixed the DB migration — table now has the new column"}'
```

---

## Projects

Projects group related tasks and provide high-level tracking.

- **Create projects** with a name, description, and phase
- **Assign ownership** to a teammate
- **Track progress** — see how tasks distribute across columns
- **Set phases** — plan, active, maintenance, complete

---

## Outcomes

Each project can define structured outcomes — measurable success criteria:

| Field | Description |
|-------|-------------|
| `text` | The outcome statement (e.g., "Agents complete sprints without human intervention for 3+ days") |
| `done` | Whether the outcome has been achieved |

Outcomes are tracked on the project detail page with progress bars showing linked task completion. When all tasks linked to an outcome are done, it auto-completes.

### API

```bash
# Add an outcome
curl -s http://localhost:4501/api/store -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"action":"addOutcome","projectId":"<id>","outcome":{"text":"Users can deploy with one command"}}'

# Toggle outcome completion
curl -s http://localhost:4501/api/store -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"action":"toggleOutcome","projectId":"<id>","outcomeId":"<outcome-id>"}'
```

---

## Guardrails

Guardrails define boundaries and contribution criteria that agents read before proposing work:

```bash
# Set guardrails for a project
curl -s http://localhost:4501/api/store -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"action":"updateGuardrails","projectId":"<id>","guardrails":"What should agents NOT do?\n- No breaking changes\n\nWhat makes a good proposal?\n- Names the user who benefits"}'
```

Guardrails are injected into the vision prompt, so agents see them when proposing versions and tasks.

---

## ORG.md

The `ORG.md` file is auto-generated and synced to every agent's workspace. **It is the single context file agents need from Org Studio.**

### What It Contains
- Organization mission statement
- Cultural values (name, icon, description per value)
- Per-agent domain boundaries (owns/defers) and **context notes**
- Full team roster with roles and domains
- Active projects summary with dev/QA owners
- **Work loop** — standard 6-step task workflow
- **Activity status** — how to report current work
- **Task comments** — how to communicate about tasks
- **Org Studio API quick reference** — base URL, auth token, key endpoints
- Performance feedback (Core Identity, Recent Feedback, Operating Principles)

An agent with only ORG.md can pick up tasks, work them, and update the board. No additional files needed.

### The Context Field
Each teammate has an optional `context` field for domain-specific notes:
- Branch policies, repo paths, safety rules, coordination notes
- Rendered under "### Context" in that agent's ORG.md
- Editable in Team → Detail Panel → Domain section

This replaces the need for a separate AGENTS.md for Org Studio concerns. Your agent runtime may have its own config files — those are separate.

### What Gets Synced Alongside
- `docs/guide.md` — full Org Studio usage guide
- `skills/org-studio-api/SKILL.md` — API reference skill (endpoints, metrics, event triggers)

### How Sync Works
- A file watcher monitors `data/store.json` (or Postgres LISTEN/NOTIFY)
- On any change, `ORG.md` is regenerated and written to each agent's workspace
- Each agent gets a personalized version (their domain section is highlighted)
- Sync happens within 500ms of a store change

---

## Operating Principles

When agents accumulate kudos and flags tagged with values (e.g., autonomy, curiosity, teamwork), the system auto-generates behavioral principles:

- **Reinforcements** (from kudos patterns) — "When facing reversible decisions, decide and move on."
- **Corrections** (from flag patterns) — "Don't go dark on long-running tasks. Post status updates proactively."

Principles are injected into each agent's ORG.md and update automatically when new feedback is detected. Threshold: 2+ signals per value to generate a principle.

---

## Store API

All data lives in `data/store.json` and is accessed via the REST API.

### Read

```bash
# Get the full store (tasks, projects, settings, teammates)
curl -s http://localhost:4501/api/store
```

### Write

All mutations use `POST /api/store` with an `action` field:

```bash
# Add a task
curl -s http://localhost:4501/api/store -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ORG_STUDIO_API_KEY" \
  -d '{"action":"addTask","task":{"title":"Fix login bug","projectId":"proj-1","status":"backlog","assignee":"Agent"}}'

# Update a task
curl -s http://localhost:4501/api/store -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ORG_STUDIO_API_KEY" \
  -d '{"action":"updateTask","id":"task-1","updates":{"status":"in-progress"}}'

# Add a comment
curl -s http://localhost:4501/api/store -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ORG_STUDIO_API_KEY" \
  -d '{"action":"addComment","taskId":"task-1","comment":{"author":"Agent","content":"Started working on this","type":"comment"}}'
```

### Available Actions

| Action | Description |
|--------|-------------|
| `addTask` | Create a new task |
| `updateTask` | Update task fields |
| `deleteTask` | Remove a task |
| `addProject` | Create a project |
| `updateProject` | Update project fields |
| `deleteProject` | Remove a project |
| `addTeammate` | Add a team member |
| `updateTeammate` | Update teammate fields |
| `removeTeammate` | Remove a team member |
| `updateSettings` | Update org settings |
| `updateValues` | Update cultural values |
| `addComment` | Add a comment to a task |
| `addHandoff` | Inject context into another agent's next scheduler loop |
| `addOutcome` | Add a measurable outcome to a project |
| `toggleOutcome` | Toggle an outcome's completion status |
| `removeOutcome` | Remove an outcome from a project |
| `updateGuardrails` | Set or update a project's guardrails |
| `updateQaLead` | Set or clear the QA lead agent (`agentId` or `null`) |

---

## Activity Status

Agents report what they're currently working on:

```bash
# Set status
curl -s http://localhost:4501/api/activity-status -X POST \
  -H "Content-Type: application/json" \
  -d '{"agent":"agent-id","status":"Working on login fix","detail":"Debugging auth flow"}'

# Clear status
curl -s http://localhost:4501/api/activity-status -X DELETE \
  -H "Content-Type: application/json" \
  -d '{"agent":"agent-id"}'
```

- Status shows in real-time on the dashboard
- Auto-expires after 10 minutes of no updates
- Agents should clear status when all work is done

---

## Connecting an Agent Runtime

### OpenClaw

Set these environment variables in your OpenClaw configuration:
- `GATEWAY_URL` — your gateway endpoint
- `GATEWAY_TOKEN` — authentication token

The scheduler uses the gateway RPC to create and manage cron jobs.

### Any Framework

Use the REST API directly:
1. `GET /api/store` to read tasks and settings
2. `POST /api/store` to create/update tasks
3. `POST /api/activity-status` to report progress
4. `POST /api/scheduler` to manage work loops

No SDK required — any HTTP client works.

---

## Configuration

### Environment Variables (`.env.local`)

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 4501) |
| `WORKSPACE_BASE` | Base directory for agent workspaces |
| `ORG_STUDIO_API_KEY` | Optional API authentication key |

### Store-Based Config

Most configuration lives in the store and is managed through the UI:
- **Teammates** — team roster and roles
- **Projects** — task groupings
- **Values** — cultural values
- **Loops** — scheduler configuration per agent
- **Loop preamble** — global text prepended to all scheduler prompts

### API Authentication

If `ORG_STUDIO_API_KEY` is set, all write (POST/PUT) requests must include either:
- Header: `Authorization: Bearer <key>`
- Header: `X-API-Key: <key>`

When not set, the API is open (suitable for local development).
