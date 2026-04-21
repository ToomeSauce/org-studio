# Telegram Migration Guide

## Overview

Starting with **Org Studio v0.15**, Telegram comms relay (task status updates, @mentions, comments) is **disabled by default**. We're transitioning to in-app notifications.

## Current State (v0.15)

| Feature | Status | Details |
|---------|--------|---------|
| Task status → Telegram | **OFF by default** | Set `ENABLE_TELEGRAM_COMMS=true` to re-enable |
| @mention → Telegram | **OFF by default** | Same flag |
| Comment relay → Telegram | **OFF by default** | Same flag |
| Weekly digest → Telegram | **OFF by default** | Same flag |
| Health alerts → Telegram | **Independent** | Uses `TELEGRAM_HEALTH_BOT_TOKEN` + `TELEGRAM_HEALTH_CHAT_ID` |
| Health webhook forwarding | **New** | Uses `TELEGRAM_HEALTH_ALERTS_WEBHOOK_URL` |

## Migration Path

1. **Enable in-app push notifications** in Settings → Notifications
2. Verify you receive task updates, mentions, and comments in the Org Studio dashboard
3. Once confirmed, no further action needed — Telegram comms are already off by default

### If you need Telegram comms temporarily

Set `ENABLE_TELEGRAM_COMMS=true` in your `.env` and restart the server. This is a backward-compatible escape hatch while you transition.

## Environment Variables

### Comms Relay (task updates, mentions, comments)

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_TELEGRAM_COMMS` | `false` | Master switch for Telegram comms relay. Set to `true` to re-enable task updates, mentions, and comments via Telegram. |
| `TELEGRAM_BOT_TOKEN` | — | Bot token for comms relay (existing) |
| `TELEGRAM_CHAT_ID` | — | Chat ID for comms relay (existing) |

### Health Alerts (independent, always available)

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEGRAM_HEALTH_BOT_TOKEN` | — | Dedicated bot token for health alerts |
| `TELEGRAM_HEALTH_CHAT_ID` | — | Chat ID for health alerts |
| `TELEGRAM_HEALTH_ALERTS_WEBHOOK_URL` | — | External webhook URL to forward health alerts (e.g., Slack, PagerDuty) |

## Health Alerts Webhook

### Endpoint

```
POST /api/webhooks/health-alerts
```

### Request Body

```json
{
  "agentId": "mikey",
  "metric": "error_rate",
  "value": 15.2,
  "threshold": 10.0,
  "status": "warning"
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agentId` | string | ✅ | Agent identifier |
| `metric` | string | ✅ | Metric name (e.g., `error_rate`, `latency_p99`, `coach_score`) |
| `value` | number | — | Current metric value |
| `threshold` | number | — | Threshold that was exceeded |
| `status` | string | — | Alert severity: `critical`, `warning`, or `info` |

### Response

```json
{
  "ok": true,
  "telegramSent": true,
  "webhookForwarded": false
}
```

### Behavior

1. If `TELEGRAM_HEALTH_ALERTS_WEBHOOK_URL` is set → forwards to that URL
2. If `TELEGRAM_HEALTH_BOT_TOKEN` + `TELEGRAM_HEALTH_CHAT_ID` are set → sends to Telegram
3. Always adds to the in-app activity feed
4. Rate-limited: 1 alert per 10 minutes per metric+agent combination

## v0.16 Plan (Full Sunset)

In v0.16:
- `ENABLE_TELEGRAM_COMMS` flag will be removed
- All task/mention/comment Telegram relay code will be deleted
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` will no longer be used for comms
- Health alerts (`TELEGRAM_HEALTH_BOT_TOKEN`) will remain available
- In-app notifications will be the primary channel for all comms

## Deprecation Timeline

| Version | Change |
|---------|--------|
| v0.14 | Telegram comms active (legacy behavior) |
| **v0.15** | **Comms off by default, health alerts independent, deprecation notice posted** |
| v0.16 | Full sunset — comms relay code removed |

## FAQ

**Q: Will I lose health alerts?**
A: No. Health alerts use a separate bot token (`TELEGRAM_HEALTH_BOT_TOKEN`) and are not affected by `ENABLE_TELEGRAM_COMMS`.

**Q: Can I still use Telegram for task updates temporarily?**
A: Yes. Set `ENABLE_TELEGRAM_COMMS=true` in your `.env` file. This escape hatch will be removed in v0.16.

**Q: What about the weekly digest?**
A: The weekly digest is also gated by `ENABLE_TELEGRAM_COMMS`. When disabled, it will only be available via the API endpoint (`GET /api/metrics/weekly-digest`).
