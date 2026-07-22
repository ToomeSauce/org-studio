type RuntimeEnvironment = Record<string, string | undefined>;

/**
 * Comment notifications must only be claimed by a process that can reach an
 * agent runtime. Cloud/store-only instances still emit Postgres NOTIFY; the
 * runtime-connected local bridge consumes that event and owns delivery.
 *
 * Without this gate a store-only process can win the durable dedup claim,
 * fail to reach any agent, and cause the real bridge to suppress the mention
 * as `duplicate-pg`.
 */
export function hasConfiguredAgentRuntime(
  env: RuntimeEnvironment = process.env,
): boolean {
  return Boolean(env.GATEWAY_URL?.trim() || env.HERMES_URL?.trim());
}

/**
 * Postgres-backed deployments route comment notifications through the single
 * LISTEN bridge in server.mjs. Routing inline from the request process as well
 * creates a race: a short-lived/cloud request can acquire the durable claim,
 * then disappear or fail before delivery while the real bridge suppresses the
 * event as duplicate-pg. File-mode installs have no LISTEN bridge, so they keep
 * the inline path when a runtime is configured.
 */
export function shouldRouteCommentNotificationsInline(
  env: RuntimeEnvironment = process.env,
  scopeKind = 'task',
): boolean {
  if (['1', 'true'].includes((env.OUTBOX_WORKER_DISABLED || '').trim().toLowerCase())) {
    return false;
  }
  // The Postgres LISTEN bridge currently reconstructs task comments only.
  // Non-task scopes (section, board, project, DM) must keep their inline path
  // or they have no delivery consumer at all.
  if (env.DATABASE_URL?.trim() && scopeKind === 'task') return false;
  return hasConfiguredAgentRuntime(env);
}
