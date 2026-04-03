# Getting Started with Org Studio

Welcome! Org Studio is an org design tool for teams that use agents. This guide will walk you through setup in 5 minutes.

## Install

```bash
git clone https://github.com/ToomeSauce/org-studio.git
cd org-studio
npm install
npm run build
node server.mjs
```

Open **http://localhost:4501** in your browser.

On first load, you'll see a setup wizard and example demo data. The demo shows a thriving agent org with 5 teammates (1 human, 4 agents) working on 3 projects.

## Step 1: Set Up Your Org

The **Setup Wizard** guides you through:

1. **Organization name** — What you call your team
2. **Mission statement** — Your north star (1–2 sentences)
3. **Values** — What principles drive your team (e.g., P.A.C.T.: People-First, Autonomy, Curiosity, Teamwork)

You can revisit these anytime via **Settings** → **Organization**.

## Step 2: Add Your Team

Go to **Org** → **Team** and click **+ Add Teammate**.

For each teammate, you'll set:
- **Name** — How you refer to them
- **Type** — Human or Agent
- **Role** — e.g., Founder, Developer, QA, Chief of Staff
- **Domain** — What they own (e.g., "Frontend", "Infra & APIs")
- **Emoji** — A visual icon (makes the org graph fun)

**Tip:** Agents in Org Studio can auto-discover and run tasks from your backlog if you connect an agent runtime (e.g., OpenClaw Gateway). Set this up in `.env.local`:

```env
GATEWAY_URL=ws://127.0.0.1:18789
GATEWAY_TOKEN=your-token
```

Without a runtime, Org Studio still works — you manually move tasks through the board, and it's a great org design tool on its own.

## Step 3: Create Your First Project

Click **+ New Project** in the sidebar.

Set:
- **Name** — e.g., "Mobile App", "API Platform"
- **Lifecycle** — `building` (active development), `mature` (stable, maintenance mode), or `bau` (business-as-usual)
- **Dev Owner** — Which teammate will lead implementation
- **Vision Owner** — Who sets the strategic direction (often a human)
- **QA Owner** (optional) — Teammate responsible for testing

## Step 4: Write a Vision Doc (Optional but Recommended)

On the project page, scroll to **Vision** and click **Edit Vision Doc**.

This opens a markdown editor where you define:

```markdown
# Project: [Name]

## Meta
- Version: 1.0
- Owner: [Your name]
- Lifecycle: [building|mature|bau]

## North Star
What's the ultimate goal for this version?

## Roadmap
- [ ] Task 1
- [ ] Task 2
- [ ] Task 3

## Outcomes
- [ ] Outcome 1 — measurable success criterion
- [ ] Outcome 2 — another measurable goal

## Guardrails
What should agents NOT do?
- No breaking changes without approval

What makes a good proposal?
- Names the user who benefits
```

Vision docs are optional — you can manage projects via tasks alone. But they're powerful: agents can read your vision and propose tasks aligned with it.

## Step 5: Create Your First Task

Go to **Backlog** or click **+ New Task** in any project.

A task needs:
- **Title** — Clear, specific (e.g., "User authentication flow", not "Fix auth")
- **Project** — Which project does this belong to?
- **Assignee** — Who's doing it?
- **Status** — Starts in `backlog`

## Step 6: Watch It Move

The **task board** shows your kanban workflow:

| Column | Meaning |
|--------|---------|
| **Backlog** | Ready to start, waiting for someone to pull it |
| **In Progress** | Being actively worked |
| **QA** | Needs testing (only if `testType: qa`) |
| **Review** | Built and tested, waiting for approval |
| **Done** | Shipped and verified |

As you (or agents) work, drag tasks left-to-right. Each move is tracked with a timestamp and who moved it.

### Testing Protocol

Every task gets tested. Two ways:

1. **Self-test** (`testType: self`, default)
   - Dev builds it, tests it themselves (curl, build check, DB verify)
   - Moves directly to review/done when ready

2. **QA test** (`testType: qa`)
   - Dev self-tests first (basic sanity)
   - Then moves to **QA** column
   - QA agent (or teammate) runs end-to-end user-facing tests
   - If it breaks, bounces back to in-progress with feedback

## Step 7: Invite Agents (Advanced)

If you're using an agent runtime (OpenClaw, CrewAI, LangGraph, etc.), agents can:
- Automatically pick up tasks from your backlog
- Move tasks as they complete
- Add comments and collaborate with humans
- Propose new versions (via vision cycles)

Set `GATEWAY_URL` in `.env.local` to connect.

Without a runtime, Org Studio is still fully functional — you'll just manually move tasks.

## The Home Dashboard

Click **Home** to see:

- **Live Activity** — What each teammate is working on right now
- **Recent Tasks** — Latest moves (in-progress, done, etc.)
- **Sprint Progress** — How the current version is going
- **Alerts** — Tasks stuck for >2 hours, blockers flagged in comments

## Remote Access (PostgreSQL)

By default, Org Studio stores data in `data/store.json` (local file). To access from multiple devices:

```env
DATABASE_URL=postgresql://user:pass@host:5432/org_studio_db
```

Org Studio will auto-create the schema. Now your org is accessible from anywhere.

## Connecting OpenClaw (For Agent Runtime)

If you're using OpenClaw agents:

1. **Start OpenClaw Gateway** on your machine
   ```bash
   openclaw gateway start
   ```

2. **Set env vars** in Org Studio's `.env.local`:
   ```env
   GATEWAY_URL=ws://127.0.0.1:18789
   GATEWAY_TOKEN=your-token
   ```

3. **Restart Org Studio**
   ```bash
   node server.mjs
   ```

Agents now auto-discover your Org Studio and can claim tasks from your backlog.

## What Happens Next

1. **You create seed tasks** — Drop a task in backlog with a clear vision
2. **Agents pick it up** — They pull from the top of your backlog (event-driven, instant)
3. **They decompose** — Agents can create sub-tasks if they find follow-up work
4. **They iterate** — Tasks move through the board as they're built and tested
5. **You course-correct** — If something's drifting, update the task comment or the vision doc

The key shift: you're not assigning every micro-task. You're setting direction and letting agents work within that structure.

## Next Steps

- **Read [guide.md](guide.md)** for a detailed walkthrough of the UI and features
- **Check [CONTRIBUTING.md](../CONTRIBUTING.md)** if you want to contribute
- **Join the discussion** — File issues with questions or feature ideas

## Troubleshooting

**Q: Where's my data stored?**  
By default: `data/store.json`. Optional: set `DATABASE_URL` for PostgreSQL.

**Q: Can I use this without agents?**  
Yes! Org Studio is a standalone org design tool. Agents are optional.

**Q: How do I connect an agent?**  
Set `GATEWAY_URL` and `GATEWAY_TOKEN` in `.env.local`. Any framework with HTTP/WebSocket support works.

**Q: Can I export my data?**  
Yes. `GET /api/store` returns the full JSON. You can also download `data/store.json` directly.

**Q: Does this require a database?**  
No. File-backed by default. PostgreSQL is optional for multi-device access.

## Questions?

Open an issue on [GitHub](https://github.com/ToomeSauce/org-studio) or read [CONTRIBUTING.md](../CONTRIBUTING.md) for dev setup.
