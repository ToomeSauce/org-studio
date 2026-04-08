/**
 * Hermes Runtime — connects to local Hermes instances (multi-profile)
 * 
 * Hermes supports multiple profiles, each running its own gateway + API server.
 * This runtime discovers all profiles with an active api_server and returns
 * one agent per profile.
 * 
 * Config via env:
 * - HERMES_URL: http://127.0.0.1:8642 (default profile, optional)
 *   Accepts comma-separated URLs for explicit multi-profile:
 *   HERMES_URL=http://127.0.0.1:8642,http://127.0.0.1:8643
 * 
 * Auto-discovery:
 * - Scans ~/.hermes/profiles/ for profiles with api_server configs
 * - Also checks ~/.hermes/config.yaml (default profile)
 * - Each profile with api_server.enabled becomes a discoverable agent
 */
import type { AgentRuntime, RuntimeAgent } from './types';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

interface HermesProfile {
  name: string;
  url: string;       // http://host:port
  soulName?: string;  // Name from SOUL.md
  configPath: string;
}

/**
 * Scan local Hermes installation for profiles with api_server enabled.
 * Returns a list of profile endpoints to probe.
 */
function discoverLocalProfiles(): HermesProfile[] {
  const profiles: HermesProfile[] = [];
  const hermesHome = join(process.env.HOME || '', '.hermes');

  // Helper: extract api_server port from config.yaml content
  function parseApiServer(content: string, profileName: string, configDir: string): HermesProfile | null {
    // Look for api_server platform config
    // Simple YAML parsing — look for the port under api_server.extra
    const apiMatch = content.match(/api_server[\s\S]*?enabled:\s*true/);
    if (!apiMatch) return null;

    // Extract port (default 8642)
    const portMatch = content.match(/api_server[\s\S]*?port:\s*(\d+)/);
    const port = portMatch ? parseInt(portMatch[1], 10) : 8642;

    // Extract host (default 127.0.0.1)
    const hostMatch = content.match(/api_server[\s\S]*?host:\s*["']?([^"'\s]+)/);
    const host = hostMatch ? hostMatch[1] : '127.0.0.1';

    // Try to get name from SOUL.md
    let soulName: string | undefined;
    try {
      const soulPath = join(configDir, 'SOUL.md');
      if (existsSync(soulPath)) {
        const soul = readFileSync(soulPath, 'utf-8');
        // Look for "Your name is X" or "Name: X" patterns
        const nameMatch = soul.match(/(?:your name is|name:\s*|you are\s+)(\w+)/i);
        if (nameMatch) soulName = nameMatch[1];
      }
    } catch {}

    return {
      name: profileName,
      url: `http://${host}:${port}`,
      soulName,
      configPath: configDir,
    };
  }

  // Check default profile (~/.hermes/config.yaml)
  try {
    const defaultConfig = join(hermesHome, 'config.yaml');
    if (existsSync(defaultConfig)) {
      const content = readFileSync(defaultConfig, 'utf-8');
      const profile = parseApiServer(content, 'default', hermesHome);
      if (profile) profiles.push(profile);
    }
  } catch {}

  // Check named profiles (~/.hermes/profiles/*/config.yaml)
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

export class HermesRuntime implements AgentRuntime {
  id = 'hermes';
  name = 'Hermes Agent';
  private explicitUrls: string[];
  private profileCache: HermesProfile[] | null = null;

  constructor() {
    const envUrl = process.env.HERMES_URL || '';
    this.explicitUrls = envUrl
      ? envUrl.split(',').map(u => u.trim()).filter(Boolean)
      : [];
  }

  /**
   * Get all Hermes endpoints to probe (explicit URLs + auto-discovered profiles)
   */
  private getProfiles(): HermesProfile[] {
    if (this.profileCache) return this.profileCache;

    const profiles: HermesProfile[] = [];
    const seenUrls = new Set<string>();

    // Auto-discover from local filesystem first
    const localProfiles = discoverLocalProfiles();
    for (const p of localProfiles) {
      if (!seenUrls.has(p.url)) {
        seenUrls.add(p.url);
        profiles.push(p);
      }
    }

    // Add explicit URLs that weren't already found
    for (const url of this.explicitUrls) {
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        profiles.push({
          name: 'unknown',
          url,
          configPath: '',
        });
      }
    }

    this.profileCache = profiles;
    return profiles;
  }

  async discover(): Promise<RuntimeAgent[]> {
    const profiles = this.getProfiles();
    if (profiles.length === 0) return [];

    const agents: RuntimeAgent[] = [];

    for (const profile of profiles) {
      try {
        const healthy = await this._probeHealth(profile.url);
        if (!healthy) continue;

        // Get model/agent name from the API
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

        // Use profile name as the agent ID (unique per profile)
        const agentId = profile.name === 'default'
          ? 'hermes-default'
          : `hermes-${profile.name}`;

        agents.push({
          id: agentId,
          name: agentName,
          emoji: '🧠',
          runtime: 'hermes',
          status: 'online',
          metadata: {
            url: profile.url,
            profile: profile.name,
            configPath: profile.configPath,
          },
        });
      } catch {}
    }

    return agents;
  }

  async send(
    agentId: string,
    message: string,
    opts?: { sessionKey?: string; idempotencyKey?: string; onComplete?: (agentId: string) => void }
  ): Promise<any> {
    // Find the right profile URL for this agent
    const profiles = this.getProfiles();
    const profile = profiles.find(p => {
      const id = p.name === 'default' ? 'hermes-default' : `hermes-${p.name}`;
      return id === agentId;
    });

    const url = profile?.url || this.explicitUrls[0];
    if (!url) throw new Error('Hermes runtime not configured');

    // Hermes processes the full agent turn synchronously on /v1/chat/completions.
    // We can't abort the connection early or Hermes drops the request.
    // Instead, dispatch in a fully detached background promise that won't block the caller.
    const fetchUrl = `${url}/v1/chat/completions`;
    const body = JSON.stringify({
      model: 'hermes',
      messages: [{ role: 'user', content: message }],
      stream: false,
    });

    // Quick pre-flight: verify the agent is reachable before dispatching
    try {
      const healthRes = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
      if (!healthRes.ok) {
        throw new Error(`Hermes agent not healthy: ${healthRes.status}`);
      }
    } catch (e: any) {
      throw new Error(`Hermes agent unreachable at ${url}: ${e.message}`);
    }

    // Dispatch in background — the fetch runs to completion but we return immediately.
    // Use global setTimeout to ensure the promise isn't GC'd by Next.js.
    console.log(`[Hermes] Dispatching task to ${agentId} at ${fetchUrl}`);
    globalThis.setTimeout(() => {
      fetch(fetchUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }).then(async response => {
        if (!response.ok) {
          console.error(`[Hermes] Agent ${agentId} dispatch returned ${response.status}`);
        } else {
          console.log(`[Hermes] Agent ${agentId} completed task (HTTP ${response.status})`);
        }
        // Notify completion callback if provided
        if (opts?.onComplete) opts.onComplete(agentId);
      }).catch(err => {
        console.error(`[Hermes] Agent ${agentId} dispatch failed:`, err.message);
        if (opts?.onComplete) opts.onComplete(agentId);
      });
    }, 0);

    return { dispatched: true, agentId, url: fetchUrl };
  }

  async health(): Promise<{ connected: boolean; detail?: string }> {
    const profiles = this.getProfiles();
    if (profiles.length === 0) {
      return {
        connected: false,
        detail: 'No Hermes profiles found (no HERMES_URL set and no local api_server configs)',
      };
    }

    let connected = 0;
    for (const profile of profiles) {
      if (await this._probeHealth(profile.url)) connected++;
    }

    if (connected === 0) {
      return { connected: false, detail: `${profiles.length} profile(s) configured but none responding` };
    }

    return {
      connected: true,
      detail: `${connected}/${profiles.length} profile(s) online`,
    };
  }

  private async _probeHealth(url: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const response = await fetch(`${url}/health`, { signal: controller.signal as any });
      clearTimeout(timeout);
      return response.ok;
    } catch {
      return false;
    }
  }

  dispose(): void {
    this.profileCache = null;
  }
}
