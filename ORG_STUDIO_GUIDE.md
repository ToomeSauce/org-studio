# Org Studio — Technical Guide

> Single source of truth for the team. Symlinked to all agent workspaces.
> **Owner:** Mikey (Labs Dev) · **Last updated:** 2026-03-12

---

## What It Is

Org Studio is a real-time dashboard for managing hybrid human + AI agent teams. It provides org visualization, task tracking, cultural values, and autonomous agent scheduling — all backed by a file-based data store and optional OpenClaw Gateway integration.

> Agents can only be autonomous if they have full context. Org Studio replaces the manager with a shared surface.

**URL:** `http://localhost:4501` (localhost only)
**Code:** `/home/openclaw_user/org-studio/`
**Service:** `mc-dashboard.service` (user-level systemd)
**License:** MIT

---

## Architecture

```
Browser  ←→  WebSocket (/ws)  ←→  server.mjs  ←→  Next.js (HTTP)
                                       ↓
                              fs.watch (store.json)  →  instant push
                              Gateway poll (8s)      →  push on change
```

- **server.mjs** — Single process: Next.js HTTP + WebSocket on port 4501
- **data/store.json** — File-backed store (tasks, projects, teammates, values, loops, settings)
- **REST API** — `GET/POST /api/store` for all data mutations
- **WebSocket** — Push-based updates to all connected browsers (zero client-side polling)
- **Gateway adapter** — `src/lib/gateway-rpc.ts` (shared WS client), `src/app/api/gateway/route.ts` (API route)
- **Auth** — Ed25519 keypair challenge-response for Gateway handshake; device identity at `~/.mc-device-identity.json`
- **Theme** — Dark/light toggle (localStorage), Geist font (sans + mono), CSS custom properties

### Stack
- Next.js 16, React 19, TypeScript, Tailwind CSS v4
- Dependencies: `clsx`, `lucide-react`, `ws`, `@hello-pangea/dnd`

---

## Pages & Sidebar

| Sidebar Label | Route | Description |
|---|---|---|
| Dashboard | `/` | Status cards (gateway, sessions, cron, model) + session/cron lists |
| Team | `/team` | Force Graph / Solar System viz, mission, values (PACT), teammate cards |
| Context | `/context` | Kanban task board (was `/tasks`, redirects) |
| Vision | `/vision` | Project cards (was `/projects`, redirects) |
| Calendar | `/calendar` | Weekly calendar view |
| Agents | `/agents` | Operational control panel for Gateway agents |
| Scheduler | `/scheduler` | **Scheduler Loop** — autonomous agent work loops |
| Automations | `/cron` | Gateway cron job management |
| Activity | `/activity` | Live activity feed |
| Memory | `/memory` | Memory file browser (per-agent) |
| Docs | `/docs` | Documentation explorer |
| Settings | `/settings` | Configuration, env vars |

---

## Data Store API

All mutations go through `POST /api/store` with an `action` field:

### Tasks
| Action | Payload | Notes |
|---|---|---|
| `addTask` | `{task: {title, status, assignee, projectId, priority?, description?}}` | Auto-tracks `statusHistory`, `initiatedBy` |
| `updateTask` | `{id, updates: {status?, assignee?, title?, ...}}` | Status changes auto-appended to `statusHistory` |
| `deleteTask` | `{id}` | |

Status values: `backlog`, `todo`, `in-progress`, `review`, `done`
Project IDs: `proj-catpilot`, `proj-shortform`, `proj-voice`, `proj-mc`, `proj-ops`, `proj-garage` (+ custom)

### Projects
| Action | Payload |
|---|---|
| `addProject` | `{project: {name, description, phase, owner, priority, createdBy}}` |
| `updateProject` | `{id, updates: {...}}` |
| `deleteProject` | `{id}` |

### Teammates
| Action | Payload |
|---|---|
| `addTeammate` | `{teammate: {name, role, emoji, color, agentId?, isHuman?}}` |
| `updateTeammate` | `{id, updates: {...}}` |
| `removeTeammate` | `{id}` |

### Settings & Values
| Action | Payload |
|---|---|
| `updateSettings` | `{settings: {missionStatement?, nodePhysics?, ...}}` |
| `updateValues` | `{values: {name, items: [{letter, icon, title, description}]}}` |

### Scheduler Loops
| Action | Payload |
|---|---|
| `addLoop` | `{loop: {agentId, enabled, intervalMinutes, startOffsetMinutes, steps}}` |
| `updateLoop` | `{id, updates: {...}}` |
| `deleteLoop` | `{id}` |

---

## Activity Status Reporting

All agents should report what they're working on:

```bash
# Report status (shows in Live Activity feed)
curl -s http://localhost:4501/api/activity-status -X POST \
  -H "Content-Type: application/json" \
  -d '{"agent":"YOUR_AGENT_ID","status":"What you are doing","detail":"Optional detail"}'

# Clear when done
curl -s http://localhost:4501/api/activity-status -X DELETE \
  -H "Content-Type: application/json" \
  -d '{"agent":"YOUR_AGENT_ID"}'
```

Auto-expires after 10 minutes if not cleared.

---

## ORG.md — Personalized Org Context

Each agent gets a personalized `ORG.md` file auto-synced to their workspace whenever the store changes. It contains mission, values, domain scope, and team roster.

**API:**
```bash
# Personalized markdown for an agent
curl -s "http://localhost:4501/api/org-context?agent=mikey&format=md"

# Structured JSON
curl -s "http://localhost:4501/api/org-context?agent=mikey&format=json"

# Generic (no agent filter)
curl -s "http://localhost:4501/api/org-context"
```

Server.mjs auto-writes `ORG.md` to each agent's workspace directory on store changes.

---

## Scheduler Loop

The Scheduler Loop enables autonomous agent work. Each agent can have a configurable loop that fires on a schedule, reads org context, picks a task, works it, and reports status.

### How It Works

```
OpenClaw Cron Job (every N minutes)
  → spawns isolated agentTurn session
    → agent reads ORG.md (mission, values, domain)
    → agent fetches tasks from /api/store
    → picks highest-priority task (in-progress first, then todo)
    → works the task (full tool access)
    → updates task status
    → reports activity status
    → session ends
```

### Default Loop Steps
1. **Read ORG.md** — refresh mission, values, domain boundaries
2. **Sync tasks** — check Context Board, create task if doing untracked work
3. **Work next** — progress highest-priority in-progress task, or pull from backlog
4. **Report** — update task status, move completed to Done, set activity

Steps are configurable per agent. Custom steps can be added with free-text instructions.

### Scheduler API (`/api/scheduler`)

| Action | Payload | Description |
|---|---|---|
| `enable` | `{loopId}` | Creates a real OpenClaw cron job, saves `cronJobId` to loop |
| `disable` | `{loopId}` | Removes the cron job, clears `cronJobId` |
| `runNow` | `{loopId}` | Triggers immediate execution (one-shot if no cronJobId) |
| `sync` | `{}` | Reconciles all loops with Gateway cron state (self-healing) |
| `runHistory` | `{loopId, limit?}` | Fetches run history from Gateway (status, duration, summary, tokens) |

### Loop Config (in `settings.loops[]`)
```json
{
  "id": "loop-abc123",
  "agentId": "mikey",
  "enabled": false,
  "intervalMinutes": 20,
  "startOffsetMinutes": 5,
  "steps": [
    {"id": "step-org", "type": "read-org", "description": "...", "enabled": true},
    {"id": "step-sync", "type": "sync-tasks", "description": "...", "enabled": true},
    {"id": "step-work", "type": "work-next", "description": "...", "enabled": true},
    {"id": "step-report", "type": "report", "description": "...", "enabled": true}
  ],
  "cronJobId": null,
  "lastRun": null
}
```

### UI Features (Scheduler Page)
- Loop cards per agent with enable/disable toggle, "Run Now" button
- Configurable interval and start offset, auto-stagger for multi-agent
- Expandable steps editor with custom step support
- Run history table with status badges, duration, summary, model, token count
- Aggregate success rate in card header ("8/10 ok")
- Sync button to reconcile with Gateway cron state

### Key Files
- `src/app/scheduler/page.tsx` — Scheduler page UI
- `src/app/api/scheduler/route.ts` — Scheduler API (enable/disable/runNow/sync/runHistory)
- `src/lib/scheduler.ts` — `buildLoopPrompt()` — turns loop steps into agent prompt
- `src/components/RunHistoryPanel.tsx` — Run history table component

---

## Key Source Files

| File | Purpose |
|---|---|
| `server.mjs` | Custom server: Next.js + WebSocket on port 4501, ORG.md sync |
| `src/lib/gateway-rpc.ts` | Shared Gateway WebSocket RPC client |
| `src/lib/gateway.ts` | Browser-side Gateway client (via `/api/gateway` proxy) |
| `src/lib/teammates.ts` | Shared color system: `resolveColor()`, `buildAgentMap()`, `buildNameColorMap()` |
| `src/lib/store.ts` | Types + defaults for Task, Project, AgentLoop, LoopStep |
| `src/lib/ws.ts` | WebSocket hook for real-time data |
| `src/app/api/store/route.ts` | Store CRUD API |
| `src/app/api/gateway/route.ts` | Gateway RPC proxy |
| `src/app/api/scheduler/route.ts` | Scheduler loop management |
| `src/app/api/org-context/route.ts` | ORG.md API |
| `src/app/api/activity-status/route.ts` | Activity status reporting |

---

## Environment Variables (`.env.local`)

```bash
GATEWAY_URL=ws://127.0.0.1:18789     # OpenClaw Gateway WebSocket
GATEWAY_TOKEN=<your-token>            # Gateway auth token
MEMORY_DIR=/home/openclaw_user/.openclaw  # Base path for memory file browser
DOC_SOURCES=/path/to/docs             # Documentation sources
```

---

## Service Management

```bash
# Status
systemctl --user status mc-dashboard.service

# Restart (after builds)
systemctl --user restart mc-dashboard.service

# Logs
journalctl --user -u mc-dashboard.service -f

# Build
cd /home/openclaw_user/org-studio && npm run build

# Build + restart
cd /home/openclaw_user/org-studio && npm run build && systemctl --user restart mc-dashboard
```

**Remote access:** `ssh -N -L 4501:127.0.0.1:4501 henry@192.168.9.155`

---

## Performance Tracking

Every task automatically tracks:
- **statusHistory** — `[{status, timestamp}]` appended on every status change
- **initiatedBy** — who created the task (enables self-initiative metrics)

Metrics enabled: cycle time, rework rate, self-initiative rate, zero-touch rate.

---

## Rebrand History
Mission Control → Context Center → **Org Studio** (current, as of 2026-03-09)
Sidebar icon: Atom (⚛️)

---

## In Development

### Phase 4: Scheduler Polish
- [ ] Notification on loop failure (alert Basil or the agent's chat)
- [ ] Multi-agent scheduling testing (enable loops for Ana, Henry, Sam)
- [ ] Rate limiting / cooldown between runs
- [ ] Run outcome tracking persisted in store (success/idle/error/timeout counts)
- [ ] Task tagging to exclude meta-tasks from being picked up by the loop

### Authentication
- [ ] Add auth to the Org Studio UI (currently open on localhost)
- [ ] API token or session-based auth for store mutations

### Publishing
- [ ] Publish to GitHub (public repo)
- [ ] Add "Read ORG.md" instruction to each agent's AGENTS.md
- [ ] Update README with Scheduler Loop documentation

### Future
- [ ] Standalone mode documentation (works without OpenClaw)
- [ ] Adapter guides for CrewAI, LangGraph, AutoGen
- [ ] Hosted version (Phase 2 of open core strategy)
- [ ] Content marketing (Phase 3)
