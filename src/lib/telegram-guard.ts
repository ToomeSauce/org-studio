/**
 * telegram-guard.ts — ENABLE_TELEGRAM_COMMS gate (v0.15)
 *
 * Controls whether task status changes, @mentions, comments, weekly digests,
 * and other "comms relay" messages are sent to Telegram.
 *
 * Default: false (disabled). Set ENABLE_TELEGRAM_COMMS=true to re-enable.
 *
 * NOTE: Health alerts (TELEGRAM_HEALTH_BOT_TOKEN / TELEGRAM_HEALTH_CHAT_ID)
 * are intentionally NOT gated by this flag — they remain independently configurable.
 */

const TAG = '[TelegramGuard]';

/**
 * Returns true if Telegram comms relay is enabled.
 * Default is false (v0.15 deprecation).
 */
export function isTelegramCommsEnabled(): boolean {
  const val = (process.env.ENABLE_TELEGRAM_COMMS || 'false').toLowerCase().trim();
  return val === 'true' || val === '1' || val === 'yes';
}

let _loggedOnce = false;

/**
 * Log the comms status once on first check. Call from server startup or first API hit.
 */
export function logTelegramCommsStatus(): void {
  if (_loggedOnce) return;
  _loggedOnce = true;
  const enabled = isTelegramCommsEnabled();
  if (enabled) {
    console.log(`${TAG} Telegram comms relay ENABLED (ENABLE_TELEGRAM_COMMS=true)`);
  } else {
    console.log(`${TAG} Telegram comms relay DISABLED (default v0.15). Set ENABLE_TELEGRAM_COMMS=true to re-enable.`);
  }
}
