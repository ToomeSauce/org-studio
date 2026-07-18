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
