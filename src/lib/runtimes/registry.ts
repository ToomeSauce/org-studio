/**
 * Runtime Registry — holds all configured runtimes and dispatches calls.
 * 
 * Runtimes are auto-registered based on environment variables:
 * - GATEWAY_URL → OpenClaw runtime
 * - HERMES_URL or ~/.hermes with api_server → Hermes runtime
 * 
 * Only configured runtimes are instantiated.
 */
import type { AgentRuntime, RuntimeAgent, RuntimeRegistry } from './types';
import { OpenClawRuntime } from './openclaw';
import { HermesRuntime } from './hermes';

let globalRegistry: RuntimeRegistryImpl | null = null;

class RuntimeRegistryImpl implements RuntimeRegistry {
  private runtimes: Map<string, AgentRuntime> = new Map();
  private agentToRuntimeId: Map<string, string> = new Map(); // agent id -> runtime id

  constructor() {
    // Only register runtimes that are configured or locally detectable
    
    // OpenClaw: register if GATEWAY_URL is set
    if (process.env.GATEWAY_URL) {
      this.runtimes.set('openclaw', new OpenClawRuntime());
    }

    // Hermes: register if HERMES_URL is set OR local Hermes installation detected
    const hermesUrl = process.env.HERMES_URL || '';
    const hermesHome = require('path').join(process.env.HOME || '', '.hermes');
    const hasLocalHermes = (() => {
      try { return require('fs').existsSync(require('path').join(hermesHome, 'config.yaml')); }
      catch { return false; }
    })();
    
    if (hermesUrl || hasLocalHermes) {
      this.runtimes.set('hermes', new HermesRuntime());
    }
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
    opts?: { sessionKey?: string; idempotencyKey?: string; onComplete?: (agentId: string) => void }
  ): Promise<any> {
    let runtime = this.getRuntimeForAgent(agentId);
    if (!runtime) {
      // Agent not in map — try discovering (first call or new agent)
      await this.discoverAll();
      runtime = this.getRuntimeForAgent(agentId);
    }
    if (!runtime) {
      throw new Error(`No runtime found for agent ${agentId}`);
    }
    return runtime.send(agentId, message, opts);
  }

  getRuntimeName(runtimeId: string): string | undefined {
    return this.runtimes.get(runtimeId)?.name;
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
  opts?: { sessionKey?: string; idempotencyKey?: string; onComplete?: (agentId: string) => void }
): Promise<any> {
  const registry = await getRuntimeRegistry();
  return registry.send(agentId, message, opts);
}
