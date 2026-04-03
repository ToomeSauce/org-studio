/**
 * Runtime Registry — plain ESM module for server.mjs
 * 
 * This is the server-side version that polls gateway for agent discovery.
 * It mirrors the TypeScript version in src/lib/runtimes/ but as plain JS
 * so server.mjs can import and use it directly.
 */
import { readFileSync, existsSync, readdirSync } from 'fs';
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
 * Hermes Runtime — multi-profile support
 * Auto-discovers profiles from ~/.hermes/ filesystem + explicit HERMES_URL
 */
function discoverLocalProfiles() {
  const profiles = [];
  const hermesHome = join(process.env.HOME || '', '.hermes');

  function parseApiServer(content, profileName, configDir) {
    const apiMatch = content.match(/api_server[\s\S]*?enabled:\s*true/);
    if (!apiMatch) return null;
    const portMatch = content.match(/api_server[\s\S]*?port:\s*(\d+)/);
    const port = portMatch ? parseInt(portMatch[1], 10) : 8642;
    const hostMatch = content.match(/api_server[\s\S]*?host:\s*["']?([^"'\s]+)/);
    const host = hostMatch ? hostMatch[1] : '127.0.0.1';
    let soulName;
    try {
      const soulPath = join(configDir, 'SOUL.md');
      if (existsSync(soulPath)) {
        const soul = readFileSync(soulPath, 'utf-8');
        const nameMatch = soul.match(/(?:your name is|name:\s*|you are\s+)(\w+)/i);
        if (nameMatch) soulName = nameMatch[1];
      }
    } catch {}
    return { name: profileName, url: `http://${host}:${port}`, soulName, configPath: configDir };
  }

  try {
    const defaultConfig = join(hermesHome, 'config.yaml');
    if (existsSync(defaultConfig)) {
      const content = readFileSync(defaultConfig, 'utf-8');
      const profile = parseApiServer(content, 'default', hermesHome);
      if (profile) profiles.push(profile);
    }
  } catch {}

  try {
    const profilesDir = join(hermesHome, 'profiles');
    if (existsSync(profilesDir)) {
      for (const name of readdirSync(profilesDir)) {
        const profileDir = join(profilesDir, name);
        const configPath = join(profileDir, 'config.yaml');
        if (existsSync(configPath)) {
          try {
            const content = readFileSync(configPath, 'utf-8');
            const profile = parseApiServer(content, name, profileDir);
            if (profile) profiles.push(profile);
          } catch {}
        }
      }
    }
  } catch {}

  return profiles;
}

class HermesRuntime {
  id = 'hermes';
  name = 'Hermes Agent';
  profileCache = null;

  constructor() {
    this.explicitUrls = HERMES_URL
      ? HERMES_URL.split(',').map(u => u.trim()).filter(Boolean)
      : [];
  }

  _getProfiles() {
    if (this.profileCache) return this.profileCache;
    const profiles = [];
    const seenUrls = new Set();

    const localProfiles = discoverLocalProfiles();
    for (const p of localProfiles) {
      if (!seenUrls.has(p.url)) { seenUrls.add(p.url); profiles.push(p); }
    }
    for (const url of this.explicitUrls) {
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        profiles.push({ name: 'unknown', url, configPath: '' });
      }
    }
    this.profileCache = profiles;
    return profiles;
  }

  async discover() {
    const profiles = this._getProfiles();
    if (profiles.length === 0) return [];
    const agents = [];

    for (const profile of profiles) {
      try {
        if (!(await this._probeHealth(profile.url))) continue;
        let agentName = profile.soulName || profile.name;
        try {
          const resp = await fetch(`${profile.url}/v1/models`);
          if (resp.ok) {
            const data = await resp.json();
            if (data.data?.[0]?.id && data.data[0].id !== 'hermes-agent') {
              agentName = data.data[0].id;
            }
          }
        } catch {}

        const agentId = profile.name === 'default'
          ? 'hermes-default'
          : `hermes-${profile.name}`;

        agents.push({
          id: agentId,
          name: agentName,
          emoji: '🧠',
          runtime: 'hermes',
          status: 'online',
          metadata: { url: profile.url, profile: profile.name },
        });
      } catch {}
    }
    return agents;
  }

  async health() {
    const profiles = this._getProfiles();
    if (profiles.length === 0) {
      return { connected: false, detail: 'No Hermes profiles found' };
    }
    let connected = 0;
    for (const p of profiles) {
      if (await this._probeHealth(p.url)) connected++;
    }
    if (connected === 0) {
      return { connected: false, detail: `${profiles.length} profile(s) configured but none responding` };
    }
    return { connected: true, detail: `${connected}/${profiles.length} profile(s) online` };
  }

  async _probeHealth(url) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const response = await fetch(`${url}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      return response.ok;
    } catch { return false; }
  }

  dispose() { this.profileCache = null; }
}

/**
 * Runtime Registry
 */
class RuntimeRegistry {
  runtimes = new Map();
  agentToRuntimeId = new Map();

  constructor() {
    // Only register runtimes that are configured or locally detectable
    if (process.env.GATEWAY_URL) {
      this.runtimes.set('openclaw', new OpenClawRuntime());
    }

    const hermesHome = join(process.env.HOME || '', '.hermes');
    const hasLocalHermes = existsSync(join(hermesHome, 'config.yaml'));
    if (HERMES_URL || hasLocalHermes) {
      this.runtimes.set('hermes', new HermesRuntime());
    }
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
