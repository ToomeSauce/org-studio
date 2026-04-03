/**
 * Runtime Registry — plain ESM module for server.mjs
 * 
 * This is the server-side version that polls gateway for agent discovery.
 * It mirrors the TypeScript version in src/lib/runtimes/ but as plain JS
 * so server.mjs can import and use it directly.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const GATEWAY_URL = process.env.GATEWAY_URL || 'ws://127.0.0.1:18789';
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || '';
const HERMES_URL = process.env.HERMES_URL || '';

/**
 * OpenClaw Runtime
 */
class OpenClawRuntime {
  id = 'openclaw';
  name = 'OpenClaw';

  async discover() {
    try {
      // Call /api/gateway to fetch agents.list
      const port = process.env.PORT || 4501;
      const resp = await fetch(`http://127.0.0.1:${port}/api/gateway`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'agents.list' }),
      });
      const data = await resp.json();
      if (!data.result?.agents) return [];

      return data.result.agents.map(agent => ({
        id: agent.id,
        name: agent.name || agent.id,
        emoji: agent.identity?.emoji,
        runtime: 'openclaw',
        status: agent.status || 'unknown',
        metadata: agent,
      }));
    } catch (e) {
      console.error('OpenClawRuntime.discover error:', e?.message);
      return [];
    }
  }

  async health() {
    try {
      const port = process.env.PORT || 4501;
      const resp = await fetch(`http://127.0.0.1:${port}/api/gateway`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'status' }),
      });
      const data = await resp.json();
      if (data.result) {
        const status = data.result;
        return {
          connected: true,
          detail: `Gateway ready. Server: ${status.server || '?'}, Agents: ${status.agents || '?'}`,
        };
      }
      return { connected: false, detail: 'No status data' };
    } catch (e) {
      return {
        connected: false,
        detail: e?.message || 'Connection failed',
      };
    }
  }

  dispose() {
    // No cleanup needed
  }
}

/**
 * Hermes Runtime
 */
class HermesRuntime {
  id = 'hermes';
  name = 'Hermes Agent';
  agentName = 'Hermes Agent';

  constructor() {
    // Try to load agent name from Hermes config
    if (HERMES_URL) {
      try {
        const hermesCfgPath = join(process.env.HOME || '~', '.hermes', 'config.yaml');
        if (existsSync(hermesCfgPath)) {
          const content = readFileSync(hermesCfgPath, 'utf-8');
          const match = content.match(/^name:\s*(.+)$/m);
          if (match) {
            this.agentName = match[1].trim();
          }
        }
      } catch {
        // Use default
      }
    }
  }

  async discover() {
    if (!HERMES_URL) return [];

    try {
      const health = await this._healthCheck();
      if (!health.connected) return [];

      let modelName = this.agentName;
      try {
        const modelsResp = await fetch(`${HERMES_URL}/v1/models`);
        if (modelsResp.ok) {
          const modelsData = await modelsResp.json();
          if (modelsData.data?.[0]?.id) {
            modelName = modelsData.data[0].id;
          }
        }
      } catch {
        // Use default
      }

      const host = new URL(HERMES_URL).hostname;
      return [
        {
          id: `hermes-${host}`,
          name: modelName,
          emoji: '🧠',
          runtime: 'hermes',
          status: 'online',
          metadata: { url: HERMES_URL },
        },
      ];
    } catch (e) {
      return [];
    }
  }

  async health() {
    if (!HERMES_URL) {
      return {
        connected: false,
        detail: 'Not configured (HERMES_URL not set)',
      };
    }
    return this._healthCheck();
  }

  async _healthCheck() {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);

      const response = await fetch(`${HERMES_URL}/health`, {
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) {
        return { connected: true, detail: 'Hermes API server ready' };
      } else {
        return { connected: false, detail: `Hermes health check failed: ${response.status}` };
      }
    } catch (e) {
      const detail = e?.name === 'AbortError' ? 'Health check timeout' : (e?.message || 'Health check failed');
      return { connected: false, detail };
    }
  }

  dispose() {
    // No cleanup
  }
}

/**
 * Runtime Registry
 */
class RuntimeRegistry {
  runtimes = new Map();
  agentToRuntimeId = new Map();

  constructor() {
    this.runtimes.set('openclaw', new OpenClawRuntime());
    this.runtimes.set('hermes', new HermesRuntime());
  }

  async discoverAll() {
    const allAgents = [];
    for (const [runtimeId, runtime] of this.runtimes) {
      try {
        const agents = await runtime.discover();
        for (const agent of agents) {
          allAgents.push(agent);
          this.agentToRuntimeId.set(agent.id, runtimeId);
        }
      } catch (e) {
        console.error(`Failed to discover from ${runtimeId}:`, e?.message);
      }
    }
    return allAgents;
  }

  async healthAll() {
    const result = {};
    for (const [runtimeId, runtime] of this.runtimes) {
      try {
        result[runtimeId] = await runtime.health();
      } catch (e) {
        result[runtimeId] = {
          connected: false,
          detail: e?.message || 'Unknown error',
        };
      }
    }
    return result;
  }

  getRuntimeForAgent(agentId) {
    const runtimeId = this.agentToRuntimeId.get(agentId);
    if (!runtimeId) return null;
    return this.runtimes.get(runtimeId);
  }

  dispose() {
    for (const runtime of this.runtimes.values()) {
      runtime.dispose();
    }
  }
}

let globalRegistry = null;

export function getRuntimeRegistry() {
  if (!globalRegistry) {
    globalRegistry = new RuntimeRegistry();
  }
  return globalRegistry;
}

export async function discoverAllAgents() {
  const registry = getRuntimeRegistry();
  return registry.discoverAll();
}

export async function checkRuntimeHealth() {
  const registry = getRuntimeRegistry();
  return registry.healthAll();
}
