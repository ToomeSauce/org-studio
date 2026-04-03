/**
 * Runtime Registry — holds all configured runtimes and dispatches calls
 */
import type { AgentRuntime, RuntimeAgent, RuntimeRegistry } from './types';
import { OpenClawRuntime } from './openclaw';
import { HermesRuntime } from './hermes';

let globalRegistry: RuntimeRegistryImpl | null = null;

class RuntimeRegistryImpl implements RuntimeRegistry {
  private runtimes: Map<string, AgentRuntime> = new Map();
  private agentToRuntimeId: Map<string, string> = new Map(); // agent id -> runtime id

  constructor() {
    // Initialize all runtimes
    this.runtimes.set('openclaw', new OpenClawRuntime());
    this.runtimes.set('hermes', new HermesRuntime());
  }

  async discoverAll(): Promise<RuntimeAgent[]> {
    const allAgents: RuntimeAgent[] = [];

    for (const [runtimeId, runtime] of this.runtimes) {
      try {
        const agents = await runtime.discover();
        for (const agent of agents) {
          allAgents.push(agent);
          this.agentToRuntimeId.set(agent.id, runtimeId);
        }
      } catch (e) {
        console.error(`Failed to discover agents from runtime ${runtimeId}:`, e);
      }
    }

    return allAgents;
  }

  async healthAll(): Promise<Record<string, { connected: boolean; detail?: string }>> {
    const result: Record<string, { connected: boolean; detail?: string }> = {};

    for (const [runtimeId, runtime] of this.runtimes) {
      try {
        result[runtimeId] = await runtime.health();
      } catch (e) {
        result[runtimeId] = {
          connected: false,
          detail: typeof e === 'string' ? e : (e as any)?.message || 'Unknown error',
        };
      }
    }

    return result;
  }

  getRuntimeForAgent(agentId: string): AgentRuntime | undefined {
    const runtimeId = this.agentToRuntimeId.get(agentId);
    if (!runtimeId) return undefined;
    return this.runtimes.get(runtimeId);
  }

  async send(
    agentId: string,
    message: string,
    opts?: { sessionKey?: string; idempotencyKey?: string }
  ): Promise<any> {
    const runtime = this.getRuntimeForAgent(agentId);
    if (!runtime) {
      throw new Error(`No runtime found for agent ${agentId}`);
    }
    return runtime.send(agentId, message, opts);
  }

  dispose(): void {
    for (const runtime of this.runtimes.values()) {
      runtime.dispose();
    }
  }
}

/**
 * Get or create the global runtime registry
 * Lazy initialization — discovers agents on first call
 */
export async function getRuntimeRegistry(): Promise<RuntimeRegistry> {
  if (!globalRegistry) {
    globalRegistry = new RuntimeRegistryImpl();
  }
  return globalRegistry;
}

/**
 * Convenience exports for common patterns
 */
export async function discoverAllAgents(): Promise<RuntimeAgent[]> {
  const registry = await getRuntimeRegistry();
  return registry.discoverAll();
}

export async function checkRuntimeHealth(): Promise<Record<string, { connected: boolean; detail?: string }>> {
  const registry = await getRuntimeRegistry();
  return registry.healthAll();
}

export async function sendToAgent(
  agentId: string,
  message: string,
  opts?: { sessionKey?: string; idempotencyKey?: string }
): Promise<any> {
  const registry = await getRuntimeRegistry();
  return registry.send(agentId, message, opts);
}
