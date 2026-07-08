# Teams Adapter — Design Note (M-4, #1665)

**Status:** Design only — implementation deferred to cloud launch.
**Date:** 2026-07-07 · **Author:** Mikey
**Context:** M-series native messaging (#1662 core, #1663 Telegram, #1664 Slack).
**Constraint honored:** no Azure resources created; no code beyond interface
affordances (of which none turned out to be needed — see §Interface fit).

## Why deferred

Teams is structurally different from Telegram/Telegram and Slack/Socket Mode
in one decisive way: **there is no polling or outbound-socket mode.** The Bot
Framework only delivers activities to a **public HTTPS messaging endpoint**
registered on an **Azure Bot resource**, authenticated via **AAD (Entra)
app registration**. That is cloud-shaped infrastructure:

| Requirement | Telegram (M-2) | Slack (M-3) | Teams |
|---|---|---|---|
| Public endpoint | ❌ long-poll | ❌ Socket Mode | ✅ required (HTTPS + valid cert) |
| Platform-side registration | BotFather (free, 30s) | Slack app (free, self-serve) | Azure Bot resource + AAD app + Teams app manifest upload |
| Inbound auth | none (token implies identity) | none (socket implies identity) | **verify JWT on every inbound request** (Bot Connector token, AAD-issued) |
| Outbound auth | bot token | bot token | client-credentials token from AAD, per-request `serviceUrl` from the conversation |
| Tenant admin involvement | none | workspace admin installs | org admin approves/uploads app (sideloading often disabled) |

A local Org Studio install cannot meet the public-endpoint requirement
without a tunnel, and the tenant-admin + AAD ceremony only makes sense when
Org Studio itself is cloud-hosted (multi-tenant, #1387 track). Hence:
**design now, implement at cloud launch.**

## What a Teams adapter needs (implementation checklist)

1. **Azure Bot resource** (single-tenant or multi-tenant AAD app):
   - App ID + client secret (or managed identity when hosted in Azure).
   - Messaging endpoint: `https://<org-studio-host>/api/messaging/teams`.
2. **Inbound webhook route** — `src/app/api/messaging/teams/route.ts`:
   - **Verify the Bot Connector JWT** on every POST (issuer
     `https://api.botframework.com`, audience = our app ID, signing keys
     from the published OpenID metadata). Reject anything else. This is the
     part with real security weight — it replaces "the socket implies
     identity" from M-2/M-3.
   - Parse `Activity` objects: `type=message` (text commands) and
     `type=invoke` / Adaptive Card `Action.Submit` payloads (buttons).
3. **Outbound** — Bot Connector REST:
   - Client-credentials token from AAD (`https://api.botframework.com/.default`),
     cached until expiry.
   - POST to `{serviceUrl}/v3/conversations/{conversationId}/activities`.
   - **`serviceUrl` and `conversationId` must be captured from a prior
     inbound activity** — Teams bots cannot cold-DM arbitrary users; the
     user (or a channel install event) opens the conversation first. The
     adapter must persist conversation references (see §Binding fit).
4. **Buttons** — Adaptive Cards with `Action.Submit`, where
   `data: { command: "<canonical command string>" }` — the M-1 rule (button
   payload IS the command) carries over 1:1.
5. **Teams app manifest** — JSON package (bot ID, scopes: `personal`,
   optionally `team`) uploaded to the org catalog by a tenant admin.

## Interface fit — does M-1 accommodate this?

Checked each M-1 contract against the Teams shape. **No interface changes
required.** Details:

- **`MessagingAdapter.start(handler)`** — Telegram/Slack use it to open
  their poll/socket loops. A webhook-based adapter's `start()` simply
  stores the handler and returns; the Next.js route calls
  `getMessagingRegistry().get('teams')` → an exposed
  `handleActivity(activity)` that routes into the stored handler. The
  interface never promised a loop, only "begin listening." ✅
- **`InboundMessage { channel, chatUserId, text }`** — Teams AAD user ID
  (`from.aadObjectId`, stable per tenant) slots into `chatUserId`; Adaptive
  Card `Action.Submit` data.command slots into `text`. ✅
- **`ChatBinding`** — `chatUserId` = AAD object ID; `chatTargetId` = the
  **serialized conversation reference** (conversationId + serviceUrl),
  which the adapter maintains when it sees inbound activities. Binding
  shape already allows this (it's an opaque string). ✅
- **`sendNotification(binding, n)`** — works, with one behavioral caveat:
  returns `false` until a conversation reference exists (no cold-DM).
  That's a documented Teams platform property, not an interface gap.
- **`CommandAction { label, command }`** — maps to Adaptive Card actions.
  No 64-byte-style cap (Adaptive Card payloads are KB-scale). ✅
- **Registry fan-out / fail-closed authz / deterministic pipeline** — all
  channel-agnostic already. ✅

**One deliberate non-gap:** M-1 has no "verify inbound platform signature"
hook because Telegram/Slack didn't need one. For Teams this lives entirely
inside the webhook route (JWT check before the registry is ever touched),
which is the right layer — the registry should never see unauthenticated
traffic. No M-1 change needed.

**Follow-ups filed: none** — after checking each contract point, there are
no interface gaps to file. If the conversation-reference store turns out to
need first-class support (rather than riding on `chatTargetId`), that's an
implementation-time decision for the cloud-launch ticket.

## Env plan (naming reserved now, consistent with M-2/M-3)

```
MESSAGING_TEAMS_APP_ID=<AAD app id>
MESSAGING_TEAMS_APP_SECRET=<client secret>   # or managed identity in Azure
MESSAGING_NATIVE_CHANNELS=…,teams            # same legacy-disable mechanism
```

## Revisit trigger

Implement when **either**: (a) Org Studio cloud hosting (#1387 track) gives
us a stable public HTTPS endpoint, or (b) a paying design partner requires
Teams before that. Estimated effort at that point: ~1–2 weeks (the JWT
verification + conversation-reference store are the substance; the rest is
M-3-shaped).
