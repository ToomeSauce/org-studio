/**
 * Runtime abstraction layer - supports multiple agent runtimes
 * (OpenClaw, Hermes, and future ones)
 */

export interface RuntimeAgent {
  id: string;
  name: string;
  emoji?: string;
  runtime: string; // "openclaw" | "hermes" | etc
  status?: 'online' | 'offline' | 'unknown';
  metadata?: Record<string, any>;
}

/**
 * Per-agent metadata as reported by the runtime that owns the agent.
 * Each field optional — runtimes that don't know a value return undefined
 * (which is honest: callers can decide whether to fall back to teammate
 * declarations or just stamp nothing). New fields can be added without
 * breaking implementations.
 *
 * #1353 — replaces ad-hoc per-agent lookups (sessions.list parsing in
 * route.ts, resolveHermesPrimaryModel direct calls, etc.) with a single
 * uniform contract that every runtime owns its own answer to.
 */
export interface AgentMetadata {
  /** Fully-qualified model id (e.g. "github-copilot/claude-opus-4.7",
   *  "gpt-5.5"). Provider/model formatting is the runtime's choice;
   *  callers should treat this as opaque. */
  model?: string;
  /** Raw provider id when the runtime separates them (e.g. "github-copilot",
   *  "custom:azure-foundry-burner"). Optional. */
  provider?: string;
  /** Free-form extension bag for runtime-specific fields (e.g. Hermes
   *  profile path, OpenClaw session id). Audit/UI can render whatever
   *  it understands. */
  [key: string]: any;
}

export interface AgentRuntime {
  id: string;
  name: string;

  /**
   * Discover all agents available in this runtime
   */
  discover(): Promise<RuntimeAgent[]>;

  /**
   * Send a message to an agent
   */
  send(
    agentId: string,
    message: string,
    opts?: { sessionKey?: string; idempotencyKey?: string; onComplete?: (agentId: string) => void }
  ): Promise<any>;

  /**
   * Health check - can this runtime reach its service?
   */
  health(): Promise<{ connected: boolean; detail?: string }>;

  /**
   * Read canonical metadata for `agentId` from this runtime's source
   * of truth (Gateway session, Hermes profile yaml, etc.).
   *
   * Contract:
   *   - Best-effort, NEVER throws. Returns undefined on any failure
   *     (runtime down, agent unknown, parse error, etc.).
   *   - Caller treats undefined as "no opinion" and may fall back to
   *     other sources.
   *   - Should complete quickly (~1s budget). Use AbortController for
   *     network calls (cf. #1344 timeout pattern).
   *
   * #1353 — central plumbing for resolveAgentModel() in route.ts (so
   * no per-runtime `if (agentId.startsWith('hermes-'))` branching
   * leaks into the API layer) and the startup consistency audit.
   */
  getAgentMetadata(agentId: string): Promise<AgentMetadata | undefined>;

  /**
   * Cleanup - close connections, etc.
   */
  dispose(): void;
}

export interface RuntimeRegistry {
  /**
   * Discover all agents from all configured runtimes
   */
  discoverAll(): Promise<RuntimeAgent[]>;

  /**
   * Get health status for all runtimes
   */
  healthAll(): Promise<Record<string, { connected: boolean; detail?: string }>>;

  /**
   * Look up which runtime owns an agent
   */
  getRuntimeForAgent(agentId: string): AgentRuntime | undefined;

  /**
   * Send a message to an agent (routes to correct runtime)
   */
  send(
    agentId: string,
    message: string,
    opts?: { sessionKey?: string; idempotencyKey?: string }
  ): Promise<any>;

  /**
   * Get the display name for a runtime by ID
   */
  getRuntimeName(runtimeId: string): string | undefined;

  /**
   * #1353 — Read-only access to the registered runtimes map.
   * Callers (e.g. the metadata audit, slice 3) need to call
   * runtime.getAgentMetadata() on the same instance the registry
   * used to discover the agent. Returning the live Map is fine
   * for read access; mutating it is undefined behavior.
   */
  getRuntimes(): Map<string, AgentRuntime>;

  /**
   * Cleanup - dispose all runtimes
   */
  dispose(): void;
}
