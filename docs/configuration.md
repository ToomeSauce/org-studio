# Configuration

Org Studio is configured via environment variables. All are optional except `ORG_STUDIO_API_KEY` if using remote access.

## Core Settings

### `PORT`

**Default:** `4501`

HTTP port for the web interface and API server.

```bash
PORT=3000
```

### `DATABASE_URL`

**Default:** None (uses file storage)

PostgreSQL connection string. If set, Org Studio uses Postgres as source of truth. If not set, data is stored in `data/store.json`.

```bash
# PostgreSQL mode
DATABASE_URL=postgresql://user:password@localhost:5432/org_studio

# Local mode (file storage, no Postgres)
# DATABASE_URL=<omitted>
```

**When to use:**
- **Postgres:** Remote deployments, multi-instance sync, persistent storage
- **Local file:** Development, single-instance, lightweight deployments

### `WORKSPACE_BASE`

**Default:** `~/.openclaw` (if exists)

Path to agent workspaces for ORG.md synchronization.

```bash
WORKSPACE_BASE=/home/openclaw_user/.openclaw
```

When set, Org Studio auto-generates `ORG.md` in each agent's workspace and syncs it whenever org settings change. Without this, agent context injection is disabled.

## Authentication

### `ORG_STUDIO_API_KEY`

**Default:** None (no auth required for local access)

API key for remote access. If set, all API calls must include the header:

```bash
Authorization: Bearer {ORG_STUDIO_API_KEY}
```

**Example:**
```bash
ORG_STUDIO_API_KEY=sk_org_1234567890abcdef
```

Use when deploying Org Studio on a VPS or any remote server. Protect this value — don't commit to git.

## Remote Integration

### `GATEWAY_URL`

**Default:** None

OpenClaw Gateway URL for inter-agent communication.

```bash
GATEWAY_URL=https://gateway.example.com
GATEWAY_TOKEN=<auth-token>
```

When set, Org Studio can:
- Wake agents directly from the UI
- Send Telegram notifications to team
- Trigger agent execution for vision cycles

### `GATEWAY_TOKEN`

**Default:** None

Authentication token for Gateway access.

### `HERMES_URL`

**Default:** None (Hermes runtime disabled)

URL of the Hermes Agent API server. When set, Org Studio discovers Hermes agents and can dispatch tasks to them.

```bash
HERMES_URL=http://127.0.0.1:8642
```

Requires the `api_server` platform enabled in Hermes (`~/.hermes/config.yaml`). See [Architecture](architecture.md) for details.

### `VISION_TOPIC_GROUP_ID`

**Default:** None

Telegram group ID for vision cycle updates (sprint topics, version proposals, approvals).

```bash
VISION_TOPIC_GROUP_ID=-1002381931352
```

Get this from the Telegram admin panel or `/getUpdates` API.

### `VISION_TOPIC_BOT_TOKEN`

**Default:** None

Telegram bot token for posting vision updates.

```bash
VISION_TOPIC_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
```

## File Structure

### Data Directory

```
data/
├── store.json        # Local file storage (if DATABASE_URL not set)
└── activity-status.json  # Live agent activity status
```

Automatically created on first run.

## Environment Files

Create `.env.local` in the project root:

```bash
# .env.local
PORT=4501
WORKSPACE_BASE=/home/openclaw_user/.openclaw
GATEWAY_URL=https://gateway.example.com
GATEWAY_TOKEN=secret_token_here
VISION_TOPIC_GROUP_ID=-1002381931352
VISION_TOPIC_BOT_TOKEN=bot_token_here
DATABASE_URL=postgresql://user:pass@localhost:5432/org_studio
```

Never commit `.env.local` to git. Use `.env.example` for templates.

## Local vs. Postgres Mode

### Local Mode (File Storage)

**When to use:**
- Development and testing
- Single-instance deployments
- No persistence requirements beyond restarts

**Setup:**
1. Don't set `DATABASE_URL`
2. Set `WORKSPACE_BASE` if agents are local

**Trade-offs:**
- ✅ Zero setup overhead
- ✅ No external dependencies
- ❌ Data lost if `data/` is deleted
- ❌ No remote sync across instances

### Postgres Mode

**When to use:**
- Production deployments
- Multi-instance sync
- Persistent backups
- Org Studio behind a load balancer

**Setup:**
1. Create PostgreSQL database
2. Set `DATABASE_URL` connection string
3. Schema auto-migrates on first run

**Trade-offs:**
- ✅ Persistent, queryable data
- ✅ Multi-instance support via LISTEN/NOTIFY
- ✅ Backup-friendly
- ❌ Requires Postgres infrastructure
- ❌ Slightly slower for local development

## Troubleshooting

### "WORKSPACE_BASE not found"

Org Studio can't find agent workspaces. Set explicitly:

```bash
WORKSPACE_BASE=/path/to/.openclaw
```

Without this, ORG.md syncing is disabled (agents won't get performance feedback).

### "Database connection failed"

Check `DATABASE_URL` syntax:

```bash
# Correct format:
DATABASE_URL=postgresql://user:password@host:5432/dbname

# Common mistakes:
postgresql://localhost  # missing port and db name
postgres://user@host    # missing password
```

### "API key required"

If you set `ORG_STUDIO_API_KEY`, all API calls need the auth header:

```bash
curl -H "Authorization: Bearer $ORG_STUDIO_API_KEY" http://localhost:4501/api/store
```

### "No agent topics appearing"

Verify Telegram bot config:

- `VISION_TOPIC_GROUP_ID` is valid (negative number, with `-100` prefix)
- `VISION_TOPIC_BOT_TOKEN` is active
- Bot has admin permissions in the group

## Performance Tuning

### Postgres Connection Pool

Set via `DATABASE_URL`:

```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/org_studio?max=20
```

Increase if experiencing connection limit errors.

### File Watcher Debounce

Org Studio debounces file watchers by 150ms to prevent thrashing. For high-frequency updates, consider Postgres mode.

## Security

- **Never commit `.env.local`** — it contains secrets
- **Rotate `ORG_STUDIO_API_KEY`** quarterly on production
- **Use strong Postgres passwords** and restrict network access
- **Limit Gateway access** to trusted networks
- **Don't share Telegram bot tokens** — they grant full group access
