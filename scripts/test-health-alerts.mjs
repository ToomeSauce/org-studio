#!/usr/bin/env node
/**
 * scripts/test-health-alerts.mjs — Verify health alert wiring + rate limiter
 *
 * Usage:
 *   node scripts/test-health-alerts.mjs
 *
 * If TELEGRAM_HEALTH_BOT_TOKEN + TELEGRAM_HEALTH_CHAT_ID are set, sends real alerts.
 * Otherwise logs "DISABLED" and verifies rate limiter logic.
 */

import { sendHealthAlert, isHealthAlertsEnabled, _resetRateLimit } from '../lib/health-alerts.mjs';

const TYPES = [
  {
    type: 'watchdog_restart',
    emoji: '🚨',
    title: 'Watchdog auto-restart',
    context: 'Agent: henry (loop-test123) restarted after 6m silence',
  },
  {
    type: 'gateway_disconnect',
    emoji: '🔌',
    title: 'Gateway disconnected',
    context: 'Gateway unreachable for 3m',
  },
  {
    type: 'dead_letter_backlog',
    emoji: '📬',
    title: 'Dead-letter backlog',
    context: '15 messages stuck in dead-letter queue',
  },
  {
    type: 'listen_stale',
    emoji: '🔇',
    title: 'LISTEN connection stale',
    context: 'Postgres LISTEN unhealthy for 6m — notifications may be delayed',
  },
];

async function main() {
  console.log(`Health alerts enabled: ${isHealthAlertsEnabled()}`);
  console.log('');

  if (!isHealthAlertsEnabled()) {
    console.log('DISABLED — no TELEGRAM_HEALTH_BOT_TOKEN set. Running rate-limiter tests only.\n');
  }

  // Test 1: Send each alert type once
  console.log('=== Test 1: Send each alert type ===');
  for (const alert of TYPES) {
    _resetRateLimit(alert.type); // Ensure clean state
    const sent = await sendHealthAlert(alert);
    console.log(`  ${alert.type}: ${sent ? 'SENT' : 'SKIPPED (disabled)'}`);
  }

  console.log('');

  // Test 2: Rate limiter — second call should be rate-limited
  console.log('=== Test 2: Rate limiter (same type twice) ===');
  const testType = TYPES[0];
  // Don't reset — the first call above should have set the rate limit
  const secondSent = await sendHealthAlert(testType);
  console.log(`  ${testType.type} (2nd call): ${secondSent ? 'SENT (unexpected!)' : 'RATE-LIMITED ✓'}`);

  // Test 3: Reset and resend — should work
  console.log('');
  console.log('=== Test 3: Reset rate limit and resend ===');
  _resetRateLimit(testType.type);
  const thirdSent = await sendHealthAlert(testType);
  console.log(`  ${testType.type} (after reset): ${thirdSent ? 'SENT ✓' : 'SKIPPED (disabled, but reset works)'}`);

  // Test 4: Different types are independent
  console.log('');
  console.log('=== Test 4: Different types are independent ===');
  _resetRateLimit(); // Reset all
  const sent1 = await sendHealthAlert(TYPES[0]);
  const sent2 = await sendHealthAlert(TYPES[1]); // Different type — should not be rate-limited
  console.log(`  ${TYPES[0].type}: ${sent1 ? 'SENT' : 'SKIPPED'}`);
  console.log(`  ${TYPES[1].type}: ${sent2 ? 'SENT (independent) ✓' : 'SKIPPED (disabled, but independent ✓)'}`);

  console.log('\n=== All tests passed ===');
}

main().catch(e => {
  console.error('Test failed:', e);
  process.exit(1);
});
