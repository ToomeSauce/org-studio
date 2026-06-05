// webhook-auth: requires HMAC/shared-secret headers, not Bearer auth (#1621)
/**
 * /api/webhooks/health-alerts — Health alert webhook (v0.16)
 *
 * Auth:
 * - Configure TELEGRAM_HEALTH_ALERTS_WEBHOOK_SECRET (or HEALTH_ALERTS_WEBHOOK_SECRET).
 * - Send either:
 *   1) x-health-signature: sha256=<hex hmac of raw body>
 *   2) x-health-secret: <shared secret>
 *
 * Accepts health alert payloads and optionally forwards to:
 * 1. External webhook (TELEGRAM_HEALTH_ALERTS_WEBHOOK_URL)
 * 2. Telegram health bot (TELEGRAM_HEALTH_BOT_TOKEN + TELEGRAM_HEALTH_CHAT_ID)
 *
 * Independent of ENABLE_TELEGRAM_COMMS — health alerts are always allowed.
 *
 * POST body: { agentId, metric, value, threshold, status }
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

const HEALTH_BOT_TOKEN = process.env.TELEGRAM_HEALTH_BOT_TOKEN || '';
const HEALTH_CHAT_ID = process.env.TELEGRAM_HEALTH_CHAT_ID || '';
const HEALTH_WEBHOOK_URL = process.env.TELEGRAM_HEALTH_ALERTS_WEBHOOK_URL || '';
const HEALTH_WEBHOOK_AUTH_SECRET =
  process.env.TELEGRAM_HEALTH_ALERTS_WEBHOOK_SECRET ||
  process.env.HEALTH_ALERTS_WEBHOOK_SECRET ||
  '';
const PUBLIC_URL = process.env.ORG_STUDIO_PUBLIC_URL || 'http://localhost:4501';

const SIGNATURE_HEADERS = ['x-health-signature', 'x-health-alerts-signature'];
const SHARED_SECRET_HEADERS = ['x-health-secret', 'x-health-alerts-secret'];

// Rate limiter: max 1 alert per 10 minutes per metric+agent key
const RATE_LIMIT_MS = 10 * 60 * 1000;
const lastFired = new Map<string, number>();

type ActivityFeedEntry = {
  type: 'health-alert';
  emoji: string;
  agent: string;
  message: string;
};

type ActivityFeedApi = {
  add?: (entry: ActivityFeedEntry) => void;
};

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function readFirstHeader(req: NextRequest, headerNames: string[]): string {
  for (const headerName of headerNames) {
    const value = req.headers.get(headerName);
    if (value?.trim()) return value.trim();
  }
  return '';
}

function safeCompare(value: string, expected: string): boolean {
  const valueBytes = Buffer.from(value);
  const expectedBytes = Buffer.from(expected);
  if (valueBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(valueBytes, expectedBytes);
}

function isAuthorizedWebhookRequest(req: NextRequest, rawBody: string): boolean {
  const sharedSecret = readFirstHeader(req, SHARED_SECRET_HEADERS);
  if (sharedSecret && safeCompare(sharedSecret, HEALTH_WEBHOOK_AUTH_SECRET)) {
    return true;
  }

  const signatureRaw = readFirstHeader(req, SIGNATURE_HEADERS);
  if (!signatureRaw) return false;

  const providedSignature = signatureRaw.replace(/^sha256=/i, '').trim().toLowerCase();
  const expectedSignature = createHmac('sha256', HEALTH_WEBHOOK_AUTH_SECRET)
    .update(rawBody)
    .digest('hex');

  return safeCompare(providedSignature, expectedSignature);
}

export async function POST(req: NextRequest) {
  try {
    if (!HEALTH_WEBHOOK_AUTH_SECRET) {
      console.error(
        '[HealthWebhook] Missing TELEGRAM_HEALTH_ALERTS_WEBHOOK_SECRET/HEALTH_ALERTS_WEBHOOK_SECRET'
      );
      return NextResponse.json(
        { error: 'Webhook authentication is not configured' },
        { status: 503 }
      );
    }

    const rawBody = await req.text();
    if (!isAuthorizedWebhookRequest(req, rawBody)) {
      return NextResponse.json({ error: 'Unauthorized webhook request' }, { status: 401 });
    }

    const body = JSON.parse(rawBody);
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
      } catch (err: unknown) {
        console.error('[HealthWebhook] Forward error:', errorMessage(err));
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
      } catch (err: unknown) {
        console.error('[HealthWebhook] Telegram error:', errorMessage(err));
      }
    }

    // 3. Add to activity feed
    const feedApi = (globalThis as { __orgStudioActivityFeed?: ActivityFeedApi })
      .__orgStudioActivityFeed;
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
  } catch (err: unknown) {
    console.error('[HealthWebhook] Error:', errorMessage(err));
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
}

export async function GET() {
  return NextResponse.json({
    endpoint: '/api/webhooks/health-alerts',
    method: 'POST',
    body: '{ agentId, metric, value, threshold, status }',
    authRequired: true,
    authMode: 'x-health-signature (HMAC-SHA256) or x-health-secret (shared secret)',
    authConfigured: !!HEALTH_WEBHOOK_AUTH_SECRET,
    telegramHealthEnabled: !!(HEALTH_BOT_TOKEN && HEALTH_CHAT_ID),
    webhookUrlConfigured: !!HEALTH_WEBHOOK_URL,
  });
}
