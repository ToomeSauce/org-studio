# Architecture

Org Studio is a Next.js 16 application with a custom Node.js server that bridges the web UI, agent coordination, and external systems.

## Stack

- **Frontend:** React 19 + TypeScript + Tailwind CSS v4
- **Server:** Next.js 16 with custom `server.mjs` entry point
- **Real-time:** WebSocket (built-in via `ws` library)
- **Storage:** PostgreSQL (optional) or local JSON files
- **Deployment:** Standalone Node.js process (systemd, Docker, etc.)

## Architecture Diagram

```
┌─────────────────────────────────────────┐
│ Browser / Web UI (React 19 + Tailwind)  │
├─────────────────────────────────────────┤
│ Next.js 16 (Pages, API Routes)          │
├─────────────────────────────────────────┤
│ Custom server.mjs (WebSocket + Intent)  │
├─────────────────────────────────────────┤
│ Runtime Abstraction Layer               │
│   ┌──────────────┐  ┌──────────────┐  │
│   │  OpenClaw   │  │ Hermes Agent │  │
│   │  (ws://)    │  │  (http://)   │  │
│   └──────────────┘  └──────────────┘  │
├─────────────────────────────────────────┤
│                                         │
├─→ PostgreSQL (optional)                 │
├─→ Local JSON files (data/store.json)    │
└─────────────────────────────────────────┘
```

## Core Components

### Runtime Abstraction Layer

**Location:** `src/lib/runtimes/`

Org Studio connects to agent runtimes via a pluggable interface. Each runtime implements four methods:

```typescript
interface AgentRuntime {
  discover(): Promise<RuntimeAgent[]>;  // List available agents
  send(agentId, message, opts): Promise<any>;  // Dispatch task/message
  health(): Promise<{ connected: boolean }>;   // Is this runtime reachable?
  dispose(): void;                              // Cleanup connections
}
```

**Built-in runtimes:**
- **OpenClaw** (`openclaw.ts`) — WebSocket RPC to Gateway on port 18789. Implements discover via `agents.list`, send via `chat.send`.
- **Hermes** (`hermes.ts`) — HTTP to OpenAI-compatible API server on port 8642. Implements discover via `/health` + `/v1/models`, send via `/v1/chat/completions`.

**Registry** (`registry.ts`) — Singleton that holds all runtimes. `discoverAll()` aggregates agents from every runtime. `send()` routes to the correct runtime based on agent ID.

**Server-side mirror** (`lib/runtimes.mjs`) — Plain ESM version for `server.mjs` (which can’t import TypeScript directly).

**Discovery is on-demand** — triggered by the user clicking “Sync Agents” on the Team page or by the `/api/runtimes` endpoint. No background polling.

**@Mentions** — When an agent posts a comment containing `@AgentName`, the `addComment` handler parses mentions, resolves against the teammate roster, and sends notifications via `registry.send()`. This enables cross-runtime communication (e.g., a Hermes agent can @mention an OpenClaw agent on a task).

### Frontend (React 19)

**Locations:** `src/app/` (Next.js app router)

Key pages:
- `/` — Home dashboard with live activity
- `/team` — Team topology, org chart, teammate cards with metrics
- `/projects` — Project list, vision cards, vision launch
- `/tasks` — Kanban board (planning → backlog → in-progress → qa → review → done)
- `/context` — Agent task backlog and work in progress
- `/vision` — Vision roadmap view and approval interface

Real-time updates via WebSocket connection to `/ws` endpoint.

### Server (server.mjs)

**Location:** `server.mjs` (custom Next.js server)

Responsibilities:
- Serve Next.js pages and API routes
- WebSocket server for real-time sync
- File watchers for `data/` directory
- ORG.md generation and sync to agent workspaces
- Performance feedback injection (tiered: Core Identity, Recent Feedback, Operating Principles)
- Vision cycle intent processing
- Intent bridge for remote access

### Data Models

#### Store (store.json)

Main data structure:

```json
{
  "settings": {
    "missionStatement": "...",
    "values": { "name": "P.A.C.T.", "items": [...] },
    "teammates": [
      {
        "id": "uuid",
        "agentId": "alex",
        "name": "Alex",
        "domain": "Backend",
        "owns": "API, database",
        "defers": "architecture decisions",
        "isHuman": false,
        "title": "Backend Developer"
      }
    ]
  },
  "projects": [
    {
      "id": "uuid",
      "name": "Mobile App",
      "visionDocPath": "docs/visions/mobile-app.md",
      "autonomy": {
        "approvalMode": "per-version",
        "autoAdvance": true,
        "currentVersion": "v0.1",
        "pendingVersion": null
      }
    }
  ],
  "tasks": [
    {
      "id": "uuid",
      "title": "Add user authentication",
      "projectId": "uuid",
      "status": "in-progress",
      "assignee": "Alex",
      "testType": "self",
      "createdAt": "2024-03-30T12:00:00Z",
      "startedAt": "...",
      "completedAt": null,
      "reviewNotes": "..."
    }
  ],
  "kudos": [
    {
      "id": "uuid",
      "agentId": "alex",
      "type": "kudos",
      "note": "Shipped 3 versions without asking",
      "value_tags": ["autonomy", "curiosity"],
      "given_by": "Jordan",
      "createdAt": "2024-03-30T12:00:00Z"
    }
  ]
}
```

#### Activity Status

Real-time agent status (`activity-status.json`):

```json
{
  "alex": {
    "status": "working",
    "detail": "Implementing user authentication",
    "lastUpdate": "2024-03-30T14:30:00Z"
  }
}
```

### Postgres Tables (Schema)

If `DATABASE_URL` is set, Org Studio auto-creates these tables:

```sql
-- Core store data (JSON)
CREATE TABLE org_store (
  id INT PRIMARY KEY DEFAULT 1,
  data JSONB NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Performance feedback (kudos/flags)
CREATE TABLE agent_feedback (
  id UUID PRIMARY KEY,
  agent_id TEXT NOT NULL,
  type TEXT CHECK (type IN ('kudos', 'flag')),
  note TEXT NOT NULL,
  value_tags JSONB,
  given_by TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  INDEX idx_agent_type (agent_id, type),
  INDEX idx_created (created_at DESC)
);

-- Task history for metrics
CREATE TABLE task_events (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL,
  agent_id TEXT,
  event TEXT,
  data JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  INDEX idx_task (task_id),
  INDEX idx_agent (agent_id)
);

-- Vision/roadmap state
CREATE TABLE vision_state (
  id TEXT PRIMARY KEY,
  project_id UUID NOT NULL,
  version TEXT NOT NULL,
  proposed_at TIMESTAMP,
  approved_at TIMESTAMP,
  rejected_at TIMESTAMP,
  completed_at TIMESTAMP,
  data JSONB,
  INDEX idx_project (project_id)
);

-- LISTEN/NOTIFY for sync
-- (No table — uses PostgreSQL event system)
```

### WebSocket Protocol

**Endpoint:** `ws://localhost:4501/ws`

**Messages:**

Client → Server:
```json
{
  "type": "subscribe",
  "channel": "store" | "activity-status"
}
```

Server → Client (broadcast):
```json
{
  "type": "store" | "activity-status",
  "data": { ... },
  "ts": 1711818600000
}
```

Real-time updates trigger when:
- Store data changes (task moved, teammate added, etc.)
- Activity status updates (agent started/stopped work)
- ORG.md synced to agent workspaces

### ORG.md Generation

**Function:** `generateOrgMd(store, forAgentId)`

Auto-generates context for each agent:

```markdown
# Org Context
> Auto-generated by Org Studio. Do not edit — changes will be overwritten.

## Mission
...

## Values — P.A.C.T.
...

## Your Domain: Backend
**Role:** Backend Developer
**Owns:** API, database
**Defers:** architecture decisions

## Team
- **Jordan** 👤 (Human) — Founder
- **Riley** 🔧 (Agent) — Chief of Staff | Owns: coordination, ops
- **Sam** 🚀 (Agent) — Frontend | Owns: UI, design system
- **Alex** 🔬 (Agent) — Backend | Owns: API, database

## Your Performance
### Core Identity
- Recognized strength: autonomous decision-making (8 kudos all-time, #autonomy)
- Growth area: communication gaps (2 flags, improving, #teamwork)

### Recent Feedback (last 30 days)
- ⭐ "Clean sprint on v0.3" — Jordan
- 🚩 "Went silent for 4 hours" — Jordan

### Operating Principles
- When facing a reversible decision: decide, document, move on
- Communicate status proactively

## Reference
For Org Studio workflows, see docs/guide.md in your workspace.
For the full API reference, see docs/agent-api.md in your workspace.

## Org Studio API
Dashboard: http://localhost:4501
Auth: All writes require header `Authorization: Bearer <key>`

Quick reference:
GET  /api/store                    — fetch tasks, projects, team
POST /api/store                    — create/update tasks, add comments
GET  /api/vision/{projectId}/doc   — read project vision doc
POST /api/roadmap/{projectId}      — create/update roadmap versions
GET  /api/stats/{agentId}          — your delivery metrics

Task lifecycle: backlog → in-progress → QA → review → done
```

### Performance Injection

**Function:** `appendPerformanceToOrgFiles(agents)`

Tiered approach (under 400 tokens):

1. **Core Identity** — All-time kudos/flags aggregated into themes
2. **Recent Feedback** — Last 30 days, specific items (max 5)
3. **Operating Principles** — Patterns derived from flags, softened after 90 days of no new flags

Runs async after initial ORG.md sync, fetching from `/api/kudos` and computing metrics.

### Intent Router

**Function:** `processIntent(changeEvent)`

Bridges remote writes (Postgres NOTIFY) to local execution:

```
Postgres notifies → Intent Router → Agent wakes → Executes launch/proposal → Updates store
```

**Intent types:**
- `visionLaunch` — Agent proposes next version
- `versionApproval` — Tasks auto-create in backlog
- `taskHandoff` — Agent context injection

## API Endpoints

### Store

- `GET /api/store` — Fetch full store
- `POST /api/store` — Update store (action-based)

### Task Dispatch Architecture

The scheduler acts as a lightweight dispatcher, not an executor:

```
Task Event → Scheduler API → Pre-flight Check → chat.send → Agent Main Session
                                                              ↓
                                                         Sub-agents (builds, tests)
                                                              ↓
                                                         Task Complete → Next Dispatch
```

**Dispatcher** (`/api/scheduler` trigger action):
- Receives events when tasks land in backlog or complete
- Runs pre-flight: cooldown (60s per agent), actionable work check, loop detection
- Builds focused dispatch message with task context
- Sends via Gateway RPC `chat.send` to `agent:{id}:main`

**Agent Session** (persistent, `agent:{id}:main`):
- Receives task context in their main session
- Has full tool access, memory, AGENTS.md context
- Spawns sub-agents for heavy work (builds, multi-file changes)
- Updates task status via store API when done
- Completion triggers next task dispatch (chaining)

### Kudos & Feedback

- `GET /api/kudos?agentId=X&limit=N` — Fetch feedback for agent
- `POST /api/kudos` — Add feedback
- `GET /api/stats/[agentId]` — Compute 30-day metrics

### Vision Cycles

- `GET /api/vision/[id]/doc` — Fetch vision markdown
- `POST /api/vision/[id]/launch` — Trigger agent proposal
- `POST /api/vision/[id]/propose` — Agent submits proposed version
- `POST /api/vision/[id]/approve` — Approve version, create tasks
- `POST /api/roadmap/[projectId]` — Agent writes roadmap

### Activity

- `GET /api/activity-status` — Fetch live agent status
- `POST /api/activity-status` — Update agent status

See [docs/agent-api.md](agent-api.md) for complete reference.

## File Watchers & Debouncing

`server.mjs` watches `data/store.json` and `data/activity-status.json`:

- Detects file changes
- Debounces by 150ms (prevents thrashing)
- Broadcasts updates via WebSocket
- If Postgres: fetches fresh copy from DB (file is stale)

## Deployment

### Local Development

```bash
npm install
npm run dev
```

Runs on `localhost:4501`, auto-reloads on code changes.

### Production (systemd)

```bash
npm run build
systemctl --user start mc-dashboard.service  # or restart
```

Service file (`~/.config/systemd/user/mc-dashboard.service`):

```ini
[Unit]
Description=Org Studio Dashboard
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node /home/user/org-studio/server.mjs
Restart=always
RestartSec=5
WorkingDirectory=/home/user/org-studio
Environment="NODE_ENV=production"
Environment="PORT=4501"
Environment="DATABASE_URL=postgresql://..."

[Install]
WantedBy=default.target
```

### Docker

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY . .
RUN npm install && npm run build
EXPOSE 4501
CMD ["node", "server.mjs"]
```

## Performance

- **WebSocket:** Sub-100ms latency for store updates
- **ORG.md sync:** ~500ms (file write + performance fetch)
- **API response:** <100ms for most endpoints
- **Build time:** ~8s (Turbopack)

## Security Considerations

- **API Key:** Set `ORG_STUDIO_API_KEY` for remote access
- **Database:** Use strong passwords, restrict to private network
- **Postgres:** Enable SSL/TLS for remote connections
- **File permissions:** Ensure `data/` and workspace directories aren't world-readable
- **Telegram tokens:** Rotate bot tokens quarterly
