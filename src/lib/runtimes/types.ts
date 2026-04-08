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
   * Cleanup - dispose all runtimes
   */
  dispose(): void;
}
