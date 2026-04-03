# Vision Cycles

Vision cycles automate the sprint planning and execution loop. Instead of manually creating tasks, you define a project vision and the system proposes versioned roadmaps that agents execute autonomously.

## How It Works

### 1. Define a Vision

Create a project and write a `VISION.md` file with:

- **North Star** — the ultimate destination (1-2 sentences)
- **Outcomes** — measurable success criteria
- **Guardrails** — boundaries and contribution standards
- **Roadmap** — versioned milestones (v0.1, v0.2, v1.0, etc.)

Example:

```markdown
# Mobile App

## North Star
Empower agents with real-time visibility into task status, project progress, and team health.

## Outcomes
- [ ] Outcome 1 — measurable success criterion
- [ ] Outcome 2 — another measurable goal

## Guardrails
What should agents NOT do?
- Metrics from external APIs (task data only)
- Manual data entry

What makes a good proposal?
- Includes performance visualization
- Agent-readable feedback

## Roadmap
[Define shippable versions with tasks]
```

### 2. Agent Proposes Next Version

Click the 🚀 **Launch** button on a project card.

- **What happens:** System sends launch message to dev agent
- **Agent reads** the vision via `/api/vision/{projectId}/doc`
- **Agent proposes:** Next version with task breakdown via `/api/roadmap/{projectId}`
- **System shows:** Proposed version details on the Vision page

### 3. You Approve (or Reject)

Approval happens directly in the Vision page through the **Approval Horizon** — a draggable card in the roadmap view.

- **Versions above the horizon** are approved for delivery. Agents can execute these immediately.
- **Versions below the horizon** are pending. Agents won't start work until you drag the card down.
- **Drag down** to approve more versions. **Drag up** to revoke approval.

This gives you a visual, real-time approval flow — no context-switching to a separate channel.

**Approval Modes:**

| Mode | Behavior |
|------|----------|
| **Approve each version** | Default. Every version waits for you to move the horizon. |
| **Approve per major** | Minor versions (v0.x) auto-approve; major versions (v1.0+) wait for your approval. |

Toggle the approval mode via the shield icon (🛡️) in the project header.

### 4. Execution

Once a version is above the approval horizon:

- **Tasks auto-create** in agent backlog
- **Sprint topic created** in Telegram (if configured) with version info and @mentions
- **Agent fires immediately** (within 60s cooldown)
- **Real-time status posts** to sprint topic as tasks move (in-progress → review → done)

### 5. Auto-Advance

When all tasks in a version are `done`:

- **Next version auto-triggers** (if auto-advance enabled)
- **Agent proposes** the following version
- **Cycle repeats** until roadmap complete or paused

## Configuration

### Approval Boundaries

Set per-project via the Vision panel:

| Setting | Behavior |
|---------|----------|
| **Approve each version** | Every version (major + minor) waits for your approval |
| **Approve per major** | v0.x versions auto-launch; v1.0+ wait for approval |
| **Auto-advance on completion** | Next version auto-triggers when current completes |

### Watchdog Safety Nets

- **Idle threshold:** If a version hasn't advanced in 24h with tasks remaining, send alert
- **Completion check:** Before marking version done, verify all tasks are `done`
- **Rollback option:** Pause auto-advance, manually adjust tasks, resume

## The Endpoints

### Fetch Vision Doc

```
GET /api/vision/{projectId}/doc
```

Returns the VISION.md content as markdown. Agents use this to understand scope and propose versions.

**Response:**
```json
{
  "content": "# Mobile App\n\n## North Star\n...",
  "lastUpdated": "2024-03-30T12:00:00Z"
}
```

### Propose Version

```
POST /api/roadmap/{projectId}
```

Agent writes proposed version with tasks.

**Payload:**
```json
{
  "version": "v0.2",
  "title": "Multi-project support",
  "description": "Enable switching between projects in the dashboard",
  "tasks": [
    {
      "title": "Add project selector to sidebar",
      "projectId": "{projectId}",
      "status": "backlog",
      "assignee": "alex"
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "versionId": "...",
  "taskCount": 3
}
```

### Launch Version

```
POST /api/vision/{projectId}/launch
```

Internal — called automatically when you click 🚀 Launch. Triggers agent to propose next version.

### Approve Version

```
POST /api/vision/{projectId}/approve
```

Approves a proposed version. Tasks auto-create in backlog.

**Payload:**
```json
{
  "versionId": "...",
  "approvalMode": "standard" // or "fast-track"
}
```

### Reject Version

```
POST /api/vision/{projectId}/reject
```

Reject a proposed version. Agent receives feedback and can re-propose with adjustments.

**Payload:**
```json
{
  "versionId": "...",
  "reason": "Scope too big — split v0.2 and v0.3"
}
```

### Mark Version Complete

```
POST /api/vision/{projectId}/complete
```

Mark a version as shipped. System auto-triggers next version if auto-advance enabled.

## State Machine

```
PROPOSED (awaiting approval)
    ↓ [approve via horizon card or API]
APPROVED (tasks created, ready to execute)
    ↓ [all tasks done]
COMPLETED (version shipped, next auto-triggers)
    ↓
[next version] → PROPOSED
```

On rejection: `PROPOSED → REJECTED → (agent can re-propose)`

## Sprint Topics (Optional)

When configured, Org Studio creates a Telegram topic (forum thread) for each approved version:

- 🚀 **Version kickoff** — scope, task count, assigned leads
- ⚙️/👀/✅/🚫/🧪 **Task status changes** — every transition
- 🔧 **Blocker alerts** — devHandoff context injections
- 🏁 **Version complete** — summary when all tasks ship

This is optional. Set `VISION_TOPIC_GROUP_ID` and `VISION_TOPIC_BOT_TOKEN` in `.env.local` to enable. When not set, everything works normally without Telegram integration.

## Best Practices

1. **Write clear North Stars** — keep visions 1-2 sentences; link to strategy
2. **Define measurable outcomes** — outcomes are tracked with progress bars and auto-complete when linked tasks are done
3. **Set clear guardrails** — guardrails are injected into the vision prompt as constraints that agents read when proposing versions and tasks
4. **Break into shippable versions** — aim for v0.x to ship in 1-2 weeks
5. **Use the approval horizon** — drag it down aggressively to keep agents busy, drag it up to pause
6. **Monitor sprint topics** — see task progress in real-time, intervene if stuck
7. **Review completed versions** — update VISION.md with learnings, adjust next roadmap
