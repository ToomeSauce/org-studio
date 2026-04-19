/**
 * /api/webhooks/health-alerts — Health alert webhook (v0.15)
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

const HEALTH_BOT_TOKEN = process.env.TELEGRAM_HEALTH_BOT_TOKEN || '';
const HEALTH_CHAT_ID = process.env.TELEGRAM_HEALTH_CHAT_ID || '';
const HEALTH_WEBHOOK_URL = process.env.TELEGRAM_HEALTH_ALERTS_WEBHOOK_URL || '';
const PUBLIC_URL = process.env.ORG_STUDIO_PUBLIC_URL || 'http://localhost:4501';

// Rate limiter: max 1 alert per 10 minutes per metric+agent key
const RATE_LIMIT_MS = 10 * 60 * 1000;
const lastFired = new Map<string, number>();

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
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
  return NextResponse.json({
    endpoint: '/api/webhooks/health-alerts',
    method: 'POST',
    body: '{ agentId, metric, value, threshold, status }',
    telegramHealthEnabled: !!(HEALTH_BOT_TOKEN && HEALTH_CHAT_ID),
    webhookUrlConfigured: !!HEALTH_WEBHOOK_URL,
  });
}
