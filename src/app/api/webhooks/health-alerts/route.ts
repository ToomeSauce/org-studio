// webhook-auth: requires HMAC/shared-secret headers when a secret is configured,
// else open (OSS/dev parity). NOT Bearer. Verifier shared with server.mjs. (#1621, F-P2)
/**
 * /api/webhooks/health-alerts — Health alert webhook (v0.16)
 *
 * Auth (#1621 / audit F-P2):
 * - Configure TELEGRAM_HEALTH_ALERTS_WEBHOOK_SECRET (alias: HEALTH_ALERTS_WEBHOOK_SECRET).
 * - When set, a sender must send either:
 *   1) X-Signature: sha256=<hex hmac-sha256 of raw body>   (x-health-signature also accepted)
 *   2) X-Webhook-Secret: <shared secret>                   (x-health-secret also accepted)
 *   Unsigned/incorrectly-signed → 401. When unset, the endpoint stays open (dev/OSS parity).
 * - Verification lives in lib/webhook-auth.mjs and is SHARED with the live
 *   server.mjs handler (which intercepts this path before Next routing), so both
 *   enforce identically. This route is the defense-in-depth fallback.
 *
 * Accepts health alert payloads and optionally forwards to:
 * 1. External webhook (TELEGRAM_HEALTH_ALERTS_WEBHOOK_URL)
 * 2. Telegram health bot (TELEGRAM_HEALTH_BOT_TOKEN + TELEGRAM_HEALTH_CHAT_ID)
 *
 * Independent of ENABLE_TELEGRAM_COMMS — health alerts are always allowed.
 *
 * POST body: { agentId, metric, value, threshold, status }
 */
import { NextRequest, NextResponse } from 'next/server';
// Canonical webhook verifier shared with server.mjs (one source, no twin drift).
import { verifyWebhookSignature, resolveWebhookSecret } from '../../../../../lib/webhook-auth.mjs';

const HEALTH_BOT_TOKEN = process.env.TELEGRAM_HEALTH_BOT_TOKEN || '';
const HEALTH_CHAT_ID = process.env.TELEGRAM_HEALTH_CHAT_ID || '';
const HEALTH_WEBHOOK_URL = process.env.TELEGRAM_HEALTH_ALERTS_WEBHOOK_URL || '';
const PUBLIC_URL = process.env.ORG_STUDIO_PUBLIC_URL || 'http://localhost:4501';

// Rate limiter: max 1 alert per 10 minutes per metric+agent key
const RATE_LIMIT_MS = 10 * 60 * 1000;
const lastFired = new Map<string, number>();

export async function POST(req: NextRequest) {
  try {
    // Read the RAW body first — HMAC must be computed over exact bytes.
    const rawBody = await req.text();
    // #1621 (F-P2): verify shared-secret/HMAC signature before processing.
    // Open only when no secret is configured (OSS/dev parity); when configured,
    // unsigned/incorrectly-signed POSTs are rejected 401.
    const sig = verifyWebhookSignature(
      rawBody,
      (name: string) => req.headers.get(name),
      resolveWebhookSecret(),
    );
    if (!sig.ok) {
      return NextResponse.json(
        { error: 'Unauthorized: invalid or missing webhook signature' },
        { status: 401 },
      );
    }

    const body = rawBody ? JSON.parse(rawBody) : {};
    const { agentId, metric, value, threshold, status } = body;

    if (!agentId || !metric) {
      return NextResponse.json(
        { error: 'Missing required fields: agentId, metric' },
        { status: 400 }
      );
    }

    const rateKey = `${agentId}_${metric}`;
    const now = Date.now();
    const lastMs = lastFired.get(rateKey) || 0;
    if (now - lastMs < RATE_LIMIT_MS) {
      return NextResponse.json({
        ok: true,
        rateLimited: true,
        message: 'Alert rate-limited (10min cooldown per metric+agent)',
      });
    }
    lastFired.set(rateKey, now);

    const emoji = status === 'critical' ? '🚨' : status === 'warning' ? '⚠️' : '📊';
    const title = `Health Alert: ${metric}`;
    const context = `Agent: ${agentId} | ${metric}: ${value} (threshold: ${threshold}) | Status: ${status || 'unknown'}`;
    const text = `${emoji} *${title}*\n${context}\n→ ${PUBLIC_URL}/health`;

    let telegramSent = false;
    let webhookForwarded = false;

    // 1. Forward to external webhook if configured
    if (HEALTH_WEBHOOK_URL) {
      try {
        const resp = await fetch(HEALTH_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId, metric, value, threshold, status, timestamp: now }),
        });
        webhookForwarded = resp.ok;
        if (!resp.ok) {
          console.error(`[HealthWebhook] Forward failed (${resp.status})`);
        }
      } catch (err: any) {
        console.error('[HealthWebhook] Forward error:', err.message);
      }
    }

    // 2. Send to Telegram health bot if configured
    if (HEALTH_BOT_TOKEN && HEALTH_CHAT_ID) {
      try {
        const resp = await fetch(
          `https://api.telegram.org/bot${HEALTH_BOT_TOKEN}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: HEALTH_CHAT_ID,
              text,
              parse_mode: 'Markdown',
              disable_web_page_preview: true,
            }),
          }
        );
        telegramSent = resp.ok;
        if (!resp.ok) {
          const errBody = await resp.text();
          console.error('[HealthWebhook] Telegram send failed:', errBody);
        }
      } catch (err: any) {
        console.error('[HealthWebhook] Telegram error:', err.message);
      }
    }

    // 3. Add to activity feed
    const feedApi = (globalThis as any).__orgStudioActivityFeed;
    if (feedApi?.add) {
      feedApi.add({
        type: 'health-alert',
        emoji,
        agent: agentId,
        message: `${emoji} ${title}: ${context}`,
      });
    }

    return NextResponse.json({
      ok: true,
      telegramSent,
      webhookForwarded,
    });
  } catch (err: any) {
    console.error('[HealthWebhook] Error:', err.message);
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
}

export async function GET() {
  const secretConfigured = !!resolveWebhookSecret();
  return NextResponse.json({
    endpoint: '/api/webhooks/health-alerts',
    method: 'POST',
    body: '{ agentId, metric, value, threshold, status }',
    auth: secretConfigured
      ? 'required: X-Signature: sha256=<hmac-sha256(body, secret)>  OR  X-Webhook-Secret: <secret>'
      : 'open (no webhook secret configured)',
    authConfigured: secretConfigured,
    telegramHealthEnabled: !!(HEALTH_BOT_TOKEN && HEALTH_CHAT_ID),
    webhookUrlConfigured: !!HEALTH_WEBHOOK_URL,
  });
}
