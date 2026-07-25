function isTruthy(value) {
  return ['1', 'true', 'yes'].includes(String(value || '').trim().toLowerCase());
}

/**
 * True only when this process has an agent runtime it can hand work to.
 * Cloud Org Studio is intentionally UI + storage only, so DATABASE_URL alone
 * never makes a process a notification-delivery owner.
 */
export function hasConfiguredAgentRuntime(env = process.env) {
  return Boolean(env.GATEWAY_URL?.trim() || env.HERMES_URL?.trim());
}

/**
 * The LISTEN notification bridge must have one owner: a runtime-connected,
 * worker-enabled process. Store-only cloud replicas still LISTEN for cache
 * refreshes, but must not acquire durable comment-delivery leases.
 */
export function shouldRunNotificationListenBridge(env = process.env) {
  return hasConfiguredAgentRuntime(env) && !isTruthy(env.OUTBOX_WORKER_DISABLED);
}
