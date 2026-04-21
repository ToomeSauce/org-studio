/**
 * health-alerts.mjs — Optional Telegram health alerting (v0.11)
 *
 * Sends alerts to a DEDICATED health bot (TELEGRAM_HEALTH_BOT_TOKEN + TELEGRAM_HEALTH_CHAT_ID).
 * Completely separate from the team/task notification bot.
 *
 * Exports:
 *   sendHealthAlert({ type, emoji, title, context }) — rate-limited Telegram send
 *   isHealthAlertsEnabled() — boolean helper
 *   initHealthAlerts() — log startup status
 */

const TAG = '[HealthAlerts]';

// Dedicated health bot env vars — NEVER fall back to TELEGRAM_BOT_TOKEN
const HEALTH_BOT_TOKEN = process.env.TELEGRAM_HEALTH_BOT_TOKEN || '';
const HEALTH_CHAT_ID = process.env.TELEGRAM_HEALTH_CHAT_ID || '';
const HEALTH_WEBHOOK_URL = process.env.TELEGRAM_HEALTH_ALERTS_WEBHOOK_URL || '';
const PUBLIC_URL = process.env.ORG_STUDIO_PUBLIC_URL || 'http://localhost:4501';

// Rate limiter: max 1 alert per hour per alert type
const RATE_LIMIT_MS = 60 * 60 * 1000; // 1 hour
const lastFired = new Map(); // type -> timestamp ms

/**
 * Check if health alerts are configured (either Telegram or webhook).
 */
export function isHealthAlertsEnabled() {
  return !!(HEALTH_BOT_TOKEN && HEALTH_CHAT_ID) || !!HEALTH_WEBHOOK_URL;
}

/**
 * Log startup status. Call once from server.mjs.
 */
export function initHealthAlerts() {
  if (HEALTH_BOT_TOKEN && HEALTH_CHAT_ID) {
    console.log(`${TAG} Telegram alerts enabled (chat: ${HEALTH_CHAT_ID})`);
  } else {
    console.log(`${TAG} Telegram alerts disabled (TELEGRAM_HEALTH_BOT_TOKEN unset)`);
  }
  if (HEALTH_WEBHOOK_URL) {
    console.log(`${TAG} Webhook forwarding enabled (${HEALTH_WEBHOOK_URL})`);
  }
}

/**
 * Send a rate-limited health alert via Telegram and/or webhook.
 *
 * @param {Object} opts
 * @param {string} opts.type - Alert type key (e.g. 'watchdog_restart')
 * @param {string} opts.emoji - Emoji prefix
 * @param {string} opts.title - Alert title
 * @param {string} opts.context - Context line
 * @returns {Promise<boolean>} true if sent, false if skipped (disabled/rate-limited)
 */
export async function sendHealthAlert({ type, emoji, title, context }) {
  try {
    if (!isHealthAlertsEnabled()) {
      return false;
    }

    // Rate limit check
    const now = Date.now();
    const lastMs = lastFired.get(type) || 0;
    if (now - lastMs < RATE_LIMIT_MS) {
      console.log(`${TAG} Rate-limited: ${type}`);
      return false;
    }

    lastFired.set(type, Date.now());
    let sent = false;

    const text = `${emoji} *${title}*\n${context}\n→ ${PUBLIC_URL}/health`;

    // Forward to external webhook if configured
    if (HEALTH_WEBHOOK_URL) {
      try {
        await fetch(HEALTH_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, emoji, title, context, timestamp: Date.now() }),
        });
        console.log(`${TAG} Webhook forwarded: ${type}`);
        sent = true;
      } catch (webhookErr) {
        console.error(`${TAG} Webhook forward failed: ${webhookErr.message}`);
      }
    }

    // Send to Telegram health bot if configured
    if (HEALTH_BOT_TOKEN && HEALTH_CHAT_ID) {
      const resp = await fetch(`https://api.telegram.org/bot${HEALTH_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: HEALTH_CHAT_ID,
          text,
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => 'unknown');
        console.error(`${TAG} Telegram send failed (${resp.status}): ${errText}`);
      } else {
        console.log(`${TAG} Alert sent: ${type}`);
      }
      sent = true;
    }

    return sent;
  } catch (e) {
    console.error(`${TAG} Send error (non-fatal): ${e.message}`);
    return false;
  }
}

/**
 * Reset the rate limiter for a specific type (used for testing).
 * @param {string} type
 */
export function _resetRateLimit(type) {
  if (type) {
    lastFired.delete(type);
  } else {
    lastFired.clear();
  }
}
