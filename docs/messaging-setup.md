# Native Messaging — Setup Guide

Org Studio can deliver notifications (task transitions, budget alerts,
approval requests) and accept **deterministic commands** (approve / pause /
resume / budget / status) through its own messaging adapters — no agent
runtime in the loop, no LLM interpretation of commands.

Both adapters work from a local install: Telegram uses long-polling, Slack
uses Socket Mode. **Neither needs a public endpoint.**

## Concepts

- **Adapter** — a channel binding (Telegram, Slack). Registered at server
  boot from env vars; no vars = adapter off = zero overhead.
- **Binding** — maps a channel-native user id to a teammate. Stored in
  `settings.messagingBindings`. **Fail-closed:** a chat user with no binding
  can run nothing and sees only a generic denial.
- **Commands** — exact grammar, parsed deterministically:

  ```
  approve <projectId> <version>   # extend approval horizon (fires promote flow)
  pause <projectId>               # loopPaused=true on the active version
  resume <projectId>              # loopPaused=false
  budget <projectId> <usd>        # set budget.ceilingUsdMonth
  status <projectId>              # read-only summary
  help
  ```

  Buttons carry these same strings as their payload — a button press and a
  typed command are literally the same code path.

## Telegram (long-polling)

1. Create a **fresh bot** with [@BotFather](https://t.me/BotFather) →
   `/newbot` → copy the token.

   > ⚠️ Do NOT reuse a token that any other process long-polls (e.g. an
   > OpenClaw channel bot). Telegram allows one `getUpdates` consumer per
   > token; a second consumer causes 409 conflicts for both.

2. Set env in `.env.local`:

   ```bash
   MESSAGING_TELEGRAM_BOT_TOKEN=123456:ABC-your-token
   ```

3. Add a binding (Settings → advanced, or via API):

   ```json
   {
     "channel": "telegram",
     "chatUserId": "<your telegram user id>",
     "teammate": "Basil"
   }
   ```

   Your numeric user id: DM [@userinfobot](https://t.me/userinfobot).

4. Restart (`npm run deploy -- --skip-build`). Boot log shows
   `[boot] native messaging started (telegram)`.

5. DM the bot `help`. Inline buttons on budget alerts round-trip
   automatically.

## Slack (Socket Mode)

1. Create an app at [api.slack.com/apps](https://api.slack.com/apps) →
   **From scratch**.

2. **Enable Socket Mode** (Settings → Socket Mode). Generate an
   **app-level token** with scope `connections:write` → `xapp-…`.

3. **OAuth & Permissions** → Bot Token Scopes:
   - `chat:write` (send messages)
   - `im:history` (read DMs to the bot)
   - `app_mentions:read` (respond to @mentions in channels)

   Install to workspace → copy the **bot token** `xoxb-…`.

4. **Event Subscriptions** (works via Socket Mode, no URL needed) →
   Subscribe to bot events: `message.im`, `app_mention`.

5. **Interactivity & Shortcuts** → toggle ON (Socket Mode delivers
   `block_actions`; no Request URL required).

6. Set env in `.env.local`:

   ```bash
   MESSAGING_SLACK_APP_TOKEN=xapp-...
   MESSAGING_SLACK_BOT_TOKEN=xoxb-...
   ```

7. Add a binding — Slack user ids look like `U0123ABC` (Profile → ⋯ →
   Copy member ID):

   ```json
   {
     "channel": "slack",
     "chatUserId": "U0123ABC",
     "teammate": "Basil",
     "chatTargetId": "D0456DEF"
   }
   ```

   `chatTargetId` (optional) is where outbound notifications land — a DM
   channel (`D…`) or a channel the bot is in (`C…`). Defaults to DMing the
   user id.

8. Restart. Boot log shows `[boot] native messaging started (slack)`.

9. DM the bot `help`, or `@orgstudio status <projectId>` in a channel.
   Buttons on notifications execute their command on click and post the
   result back into the conversation.

## Replacing the legacy Telegram relay (optional)

By default the native adapters are **additive** — existing delivery paths
(direct Telegram sends, OpenClaw `chat.send` relay) keep working. To make a
native adapter authoritative for a channel and silence the legacy path:

```bash
MESSAGING_NATIVE_CHANNELS=telegram        # or: telegram,slack
```

Fully reversible — unset it and the legacy path resumes.

## Binding options

| Field | Required | Meaning |
|---|---|---|
| `channel` | ✅ | `telegram` or `slack` |
| `chatUserId` | ✅ | Channel-native user id (Telegram numeric id / Slack `U…`) |
| `teammate` | ✅ | Teammate name in `settings.teammates` — used as the actor on writes |
| `chatTargetId` | — | Outbound destination override (group/channel id) |
| `allowedCommands` | — | Narrow the verb set, e.g. `["status", "help"]` for read-only access |

## Security notes

- Unknown chat users get a generic `Not authorized.` — command grammar and
  usage details never leak to unbound users.
- Every command executes through the same validated store/roadmap API
  writes the dashboard uses (budget validation, workspace checks, promote
  gates all apply).
- There is **no model call anywhere** in the command path — inbound text
  either matches the grammar exactly or is rejected with usage help.
