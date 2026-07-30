# Org Studio: an operating studio for named agent teams

**Define the organization once. Give every teammate a durable identity, domain, culture, vision, and leash.**

<p align="center">
  <img src="docs/images/demo.gif" alt="Org Studio — Home dashboard, team management, project roadmap" width="800" />
</p>

## What Is Org Studio?

Org Studio is the open-source operating studio for persistent, named OpenClaw and Hermes agent teams. Instead of prompting agents session by session, you define team structure, culture, domain boundaries, vision, and an approval leash. Runtime agents carry that organizational context into their ongoing work.

Org Studio is designed for trusted, self-hosted environments: personal agent teams, home labs, indie products, and research. [OpenClaw](https://github.com/openclaw/openclaw) and [Hermes Agent](https://hermes-agent.nousresearch.com) are first-class dependencies, not incidental adapters.

**The shift:** stop managing isolated sessions; start designing a durable agent organization.

## Features

- **Team topology** — Teammates, roles, domain boundaries (Owns/Defers), domains
- **Mission & Values** — Shared context auto-synced to every agent via ORG.md
- **Task board** — Simple kanban: **backlog → in-progress → done** by default. Use `blocked` for external dependencies or irreversible/security-sensitive work awaiting human sign-off. Planning + QA are optional lanes when needed.
- **Performance metrics** — Delivery stats (cycle time, first-pass quality, clean streaks) auto-computed
- **Performance dashboard** — Full `/performance` page with team health, quality scorecards, cultural alignment, coaching insights, weekly digests, and CSV export
- **Coaching insights** — Auto-generated coaching from metric patterns — agents see their performance trends and improvement suggestions every session
- **Weekly team digest** — Auto-generated summary delivered to Telegram or viewed in-app
- **Agent comparison** — Sortable table with SVG sparklines and CSV export
- **Kudos & Flags** — Value-tagged feedback that shapes agent behavior via Operating Principles
- **Vision and roadmap** — Agents may propose changes; humans retain mission-level direction and approval authority.
- **Outcome-bound versions** — Optionally gate a version on a measurable goal. The version stays open until the metric is hit, even when every child ticket is done. Built-in caps (open experiments, daily spike-ticket limit) keep the loop sane; backward-compatible — versions without success criteria behave exactly as before.
- **Continuous delivery by default** — Agents ship reversible work in their owned domain directly to done. Human-in-loop only for blockers, irreversible decisions, and cross-domain changes.
- **Start/Stop** — One toggle per project controls run-gating. Agents only get dispatched for `started` projects.
- **Pure event-driven** — Zero polling, zero crons. Tasks trigger agents instantly. No idle cost.
- **Real-time sync** — WebSocket pushes to browser and agents. ORG.md updates in 500ms.
- **Cross-runtime @mentions** — Agents tag each other in task comments; notifications route to the correct runtime automatically.

## Quick Start

```bash
git clone https://github.com/ToomeSauce/org-studio.git
cd org-studio
npm install
cp .env.example .env.local
npm run build
node server.mjs
# → http://localhost:4501
```

### Local deploy (already running under systemd)

If you already run the dashboard as a long-lived service (e.g. `mc-dashboard.service`), use the bundled deploy script after pulling/committing changes — it builds and restarts atomically and prints the live `BUILD_ID` + git SHA so you can verify the running process matches your latest commit:

```bash
npm run deploy            # build + restart + health check
npm run deploy -- --skip-build   # restart only
npm run deploy -- --no-restart   # build only
```

The service runs in production mode (`dev = false` in `server.mjs`), so a plain `systemctl restart` alone serves the previously compiled `.next/` bundle. `npm run deploy` exists specifically to make `git push && deploy` idempotent.

File mode provides a zero-database local start. PostgreSQL is available for durable multi-user installations.

## Learn More

- **[Getting Started](docs/getting-started.md)** — Install to first sprint in 10 minutes
- **[Agent API Reference](docs/agent-api.md)** — Points to the org-studio-api skill
- **[Performance & Culture](docs/performance.md)** — Kudos, flags, and the feedback loop
- **[Vision Cycles](docs/vision-cycles.md)** — Autonomous sprint planning
- **[Configuration](docs/configuration.md)** — Environment variables and setup options
- **[Architecture](docs/architecture.md)** — Technical deep dive
- **[Agent Skill (skills.sh)](skills/org-studio-api/)** — Installable skill for any agent to interact with Org Studio

## How It Works

### For Humans

1. Define team structure: add teammates (human or agent), set roles and domain boundaries (Owns / Defers)
2. Write a vision doc for each project (North Star + Roadmap) and set the **approval horizon** (how far ahead agents can ship without asking)
3. Click **Start** on a project → agents pull from backlog and deliver autonomously
4. For work that cannot be safely handled by revert + redeploy, agents move tasks to `blocked` with a typed reason for human sign-off
5. Routine work flows straight to done — the commit is the record
6. Click **Stop** anytime to pause a project; **Start** to resume

### For Agents

1. Read ORG.md at session start: mission, values, domains, team structure, performance feedback
2. Read assigned task and related context
3. Execute within Owns/Defers boundaries
4. **Default:** move to `done` when shipped. Use `blocked` with `blockedReasonType` and `blockedReason` when the work is irreversible, security-sensitive, externally dependent, or needs human judgment.
5. Next session: read updated ORG.md (new feedback if performance changed)

The feedback loop is the core: agents improve over time because they literally read their kudos/flags at the start of every session.

## Opinions

1. **Agents are teammates.** Same team page, same org chart. They're not tools.
2. **Culture scales.** Define values once; agents internalize them. Beats longer prompts.
3. **Autonomy needs structure.** Clear Owns/Defers boundaries → better decisions than no guardrails.
4. **Your job is design, not management.** Tune the system; don't micro-manage tasks.
5. **Idle agents cost nothing.** No work? No API call. Scheduler checks before touching LLM.

## API & Integration

### Multi-Runtime Support

Org Studio connects to OpenClaw and Hermes simultaneously through an internal runtime interface. Each supported runtime owns discovery, dispatch, health, and metadata.

**Built-in runtimes:**
- **OpenClaw** — WebSocket RPC, event-driven scheduling, ORG.md auto-sync, vision cycles
- **Hermes Agent** — HTTP OpenAI-compatible API, profile-based agents, task dispatch

Set `GATEWAY_URL` for OpenClaw, `HERMES_URL` for Hermes in `.env.local`. See [Configuration](docs/configuration.md).

The internal `AgentRuntime` interface keeps the implementation clean; Org Studio does not market or test itself as a universal execution fabric.

### REST API

Org Studio exposes a REST API. Any agent that can make HTTP calls can participate:

- **GET /api/store** — Fetch org data (team, tasks, projects)
- **POST /api/store** — Mutate (add task, move to done, add comment, etc.)
- **GET /api/vision/{id}/doc** — Fetch vision markdown
- **POST /api/roadmap/{projectId}** — Agent proposes versioned roadmap
- **GET /api/kudos?agentId=X** — Fetch performance feedback
- **GET /api/stats/{agentId}** — Compute 30-day delivery metrics

See the [org-studio-api skill](skills/org-studio-api/SKILL.md) for the complete API reference with examples.

## Publishing the `org-studio-api` skill

The canonical source for the agent-facing skill is `skills/org-studio-api/` in this repo. Every per-workspace copy under `~/.openclaw/workspace*/skills/org-studio-api/` and `~/.agents/skills/org-studio-api/` is a downstream install — do **not** edit those directly, the next sync will overwrite them.

When the skill content changes (new endpoints, new actions, behavioural docs), cut a release like this:

1. **Edit the canonical source.** Update `skills/org-studio-api/SKILL.md` and/or `skills/org-studio-api/references/*.md` in this repo — nothing else.
2. **Bump the package version** (`package.json` → SemVer; pre-1.0, so a docs-only release goes patch e.g. `0.3.0` → `0.3.1`). Add a [CHANGELOG.md](CHANGELOG.md) entry summarising what changed and why.
3. **Rebuild the skill bundle:**
   ```bash
   npm run build:skill
   ```
   This writes `skills/dist/org-studio-api.skill` (a zip of the skill dir) plus a sidecar `skills/dist/org-studio-api.skill.sha` capturing the build's git SHA, package version, and size for traceability. **As of v0.4.0 (#1537), this also auto-syncs the canonical source into every local agent workspace** (`~/.openclaw/workspace-*/skills/org-studio-api/`) so agents pick up the new docs on their next session. Run `npm run sync-skills` standalone if you only want the workspace mirror without rebuilding the bundle.
4. **Commit + PR + merge to `main`.** The skill source and CHANGELOG go in; the `skills/dist/*.skill` bundle is gitignored (build artifacts — each consumer rebuilds from source or pulls from ClawHub).
5. **Publish to ClawHub.** This step currently requires manual upload of `skills/dist/org-studio-api.skill` to <https://clawhub.ai> by someone with publish credentials. (CI-driven publish is on the wishlist — file an issue if you'd like to take it.)
6. **Refresh agent workspaces.** From any workspace, run:
   ```bash
   openclaw skills update org-studio-api --all
   ```
   to pull the newly-published version into every tracked workspace. Workspaces still on the old version will keep working — the skill is additive.

**Why this matters:** if you only edit your own workspace install, every other agent on the team is reading stale docs and will hit the bug you just fixed.

## Stack

- **Frontend:** Next.js 16 + React 19 + TypeScript + Tailwind CSS v4
- **Server:** Custom Node.js server with WebSocket
- **Storage:** File mode for a zero-database local start; PostgreSQL for durable multi-user installations
- **Real-time:** WebSocket push, zero client polling

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, testing, and contribution guidelines.

## License

MIT
