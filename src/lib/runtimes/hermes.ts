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
import type { AgentRuntime, RuntimeAgent, AgentMetadata } from './types';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

interface HermesProfile {
  name: string;
  url: string;       // http://host:port
  soulName?: string;  // Name from SOUL.md
  configPath: string;
  primaryModel?: string;     // model.default from config.yaml (e.g. "gpt-5.5")
  primaryProvider?: string;  // model.provider from config.yaml (e.g. "custom:azure-foundry-burner")
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

    // #1350 — Extract primary model from top-level `model:` block.
    // Matches:
    //   model:
    //     provider: <provider>
    //     default: <model-name>
    // Anchored at start-of-line to avoid matching nested `model:` keys (e.g. in fallback_providers).
    let primaryModel: string | undefined;
    let primaryProvider: string | undefined;
    try {
      const modelBlock = content.match(/(^|\n)model:\s*\n([\s\S]*?)(?=\n[A-Za-z][\w-]*:)/);
      if (modelBlock) {
        const block = modelBlock[2];
        const defMatch = block.match(/^\s+default:\s*["']?([^"'\s#]+)/m);
        if (defMatch) primaryModel = defMatch[1];
        const provMatch = block.match(/^\s+provider:\s*["']?([^"'\s#]+)/m);
        if (provMatch) primaryProvider = provMatch[1];
      }
    } catch {}

    return {
      name: profileName,
      url: `http://${host}:${port}`,
      soulName,
      configPath: configDir,
      primaryModel,
      primaryProvider,
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
  private apiKey: string;
  private profileCache: HermesProfile[] | null = null;

  constructor() {
    const envUrl = process.env.HERMES_URL || '';
    this.apiKey = (process.env.HERMES_API_KEY || '').trim();
    this.explicitUrls = envUrl
      ? envUrl.split(',').map(u => u.trim()).filter(Boolean)
      : [];
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...extra,
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
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
          const resp = await fetch(`${profile.url}/v1/models`, {
            headers: this.headers(),
          });
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
            // #1350 — surface primary model so /api/runtimes and resolveAgentModel can read it
            model: profile.primaryModel
              ? {
                  primary: profile.primaryModel,
                  provider: profile.primaryProvider,
                }
              : undefined,
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

    // Use /v1/runs for async dispatch — returns run_id immediately (HTTP 202),
    // processes the agent turn in the background. Monitor via SSE events.
    const runsUrl = `${url}/v1/runs`;

    // Quick pre-flight: verify the agent is reachable
    try {
      const healthRes = await fetch(`${url}/health`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5000),
      });
      if (!healthRes.ok) {
        throw new Error(`Hermes agent not healthy: ${healthRes.status}`);
      }
    } catch (e: any) {
      throw new Error(`Hermes agent unreachable at ${url}: ${e.message}`);
    }

    // Dispatch via /v1/runs — returns immediately with run_id
    console.log(`[Hermes] Dispatching task to ${agentId} via ${runsUrl}`);
    const runRes = await fetch(runsUrl, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        input: message,
        session_id: opts?.sessionKey || `org-studio-${agentId}`,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!runRes.ok) {
      const errText = await runRes.text().catch(() => '');
      // Run creation never succeeded, so there is no completed agent turn.
      // Do not fire onComplete here: the durable outbox still owns retries and
      // will clear in-flight only when its final delivery attempt fails.
      throw new Error(`Hermes /v1/runs error ${runRes.status}: ${errText}`);
    }

    const runData = await runRes.json();
    const runId = runData.run_id;
    console.log(`[Hermes] Agent ${agentId} run started: ${runId}`);

    // Monitor the run via SSE events in the background
    const eventsUrl = `${url}/v1/runs/${runId}/events`;
    // Monitor SSE with an inactivity timeout — if no events for 5 min, consider run dead
    const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
    const controller = new AbortController();
    const overallTimeout = setTimeout(() => controller.abort(), 30 * 60 * 1000);
    let inactivityTimer: any = null;
    const resetInactivity = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        console.warn(`[Hermes] Agent ${agentId} SSE inactivity timeout (${runId}) — no events for 5 min`);
        controller.abort();
      }, INACTIVITY_TIMEOUT_MS);
    };
    resetInactivity();

    globalThis.setTimeout(() => {
      fetch(eventsUrl, {
        headers: this.headers(),
        signal: controller.signal,
      })
        .then(async (res) => {
          if (!res.ok || !res.body) {
            console.error(`[Hermes] Agent ${agentId} events stream failed: ${res.status}`);
            if (opts?.onComplete) opts.onComplete(agentId);
            clearTimeout(overallTimeout);
            if (inactivityTimer) clearTimeout(inactivityTimer);
            return;
          }
          // Read SSE stream for completion events
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              resetInactivity(); // got data, reset inactivity timer
              buffer += decoder.decode(value, { stream: true });
              // Parse SSE lines
              const lines = buffer.split('\n');
              buffer = lines.pop() || ''; // keep incomplete line
              for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                  const event = JSON.parse(line.slice(6));
                  if (event.event === 'run.completed') {
                    console.log(`[Hermes] Agent ${agentId} run completed (${runId})`);
                    if (opts?.onComplete) opts.onComplete(agentId);
                    return;
                  }
                  if (event.event === 'run.failed') {
                    console.error(`[Hermes] Agent ${agentId} run failed (${runId}):`, event.error);
                    if (opts?.onComplete) opts.onComplete(agentId);
                    return;
                  }
                  if (event.event === 'tool.started') {
                    console.log(`[Hermes] Agent ${agentId} tool: ${event.tool}`);
                    const feedApi = (globalThis as any).__orgStudioActivityFeed;
                    if (feedApi?.add) {
                      feedApi.add({
                        type: 'agent-tool',
                        emoji: '🔧',
                        agent: agentId,
                        message: `${event.tool}${event.preview ? ': ' + String(event.preview).slice(0, 60) : ''}`,
                      });
                    }
                  }
                } catch { /* skip unparseable lines */ }
              }
            }
          } catch (e: any) {
            if (e.name !== 'AbortError') {
              console.error(`[Hermes] Agent ${agentId} events error:`, e.message);
            }
          }
          // Stream ended without terminal event — agent may have crashed or timed out
          console.warn(`[Hermes] Agent ${agentId} SSE stream ended without run.completed/run.failed (${runId})`);
          if (opts?.onComplete) opts.onComplete(agentId);
          clearTimeout(overallTimeout);
          if (inactivityTimer) clearTimeout(inactivityTimer);
        })
        .catch((err) => {
          console.error(`[Hermes] Agent ${agentId} events fetch failed:`, err.message);
          if (opts?.onComplete) opts.onComplete(agentId);
          clearTimeout(overallTimeout);
          if (inactivityTimer) clearTimeout(inactivityTimer);
        });
    }, 0);

    return { dispatched: true, agentId, runId, url: runsUrl };
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
      const response = await fetch(`${url}/health`, {
        headers: this.headers(),
        signal: controller.signal as any,
      });
      clearTimeout(timeout);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * #1353 — Hermes's canonical per-agent metadata lives in the profile's
   * `~/.hermes/profiles/<name>/config.yaml` (or `~/.hermes/config.yaml` for
   * the default profile), specifically the top-level `model:` block's
   * `default` + `provider`. The standalone `resolveHermesPrimaryModel`
   * helper at the bottom of this file already parses this and is reused
   * by route.ts; this method wraps it under the AgentRuntime interface
   * so the registry can dispatch uniformly.
   *
   * No network calls — reads filesystem only — so this is fast and
   * stable across runtime-down scenarios. Hermes-the-process can be
   * offline and we'll still report what the profile config DECLARES the
   * model to be (which is exactly what the startup audit needs: "what
   * did the runtime SAY the model is, regardless of whether it's
   * online right now").
   *
   * Returns undefined for non-Hermes agentIds or profiles with no
   * `api_server` block / no `model.default`.
   */
  async getAgentMetadata(agentId: string): Promise<AgentMetadata | undefined> {
    const resolved = resolveHermesPrimaryModel(agentId);
    if (!resolved?.model) return undefined;
    // Match the formatting used by resolveAgentModel() in route.ts so
    // callers can compare stamps apples-to-apples: provider/model for
    // "real" providers; bare model for custom: providers.
    const provider = resolved.provider || '';
    let modelStamp: string;
    if (provider && !provider.startsWith('custom:') && !provider.includes(':')) {
      modelStamp = `${provider}/${resolved.model}`;
    } else {
      modelStamp = resolved.model;
    }
    return {
      model: modelStamp,
      provider: resolved.provider,
    };
  }

  dispose(): void {
    this.profileCache = null;
  }
}

/**
 * #1350 — Lightweight, filesystem-only helper for resolveAgentModel() in route.ts.
 * Returns the primary model for a Hermes agent (by agentId like "hermes-trevor" or
 * "hermes-default") read straight from its profile config.yaml. No network calls,
 * no health probes — just config introspection.
 *
 * Returns undefined if:
 * - agentId doesn't match a known profile
 * - profile has no api_server enabled (i.e. not exposed)
 * - profile has no `model.default` defined
 */
export function resolveHermesPrimaryModel(agentId: string): { model?: string; provider?: string } | undefined {
  if (!agentId || !agentId.startsWith('hermes-')) return undefined;
  const profileName = agentId === 'hermes-default' ? 'default' : agentId.slice('hermes-'.length);
  try {
    const profiles = discoverLocalProfiles();
    const match = profiles.find(p => p.name === profileName);
    if (!match || !match.primaryModel) return undefined;
    return { model: match.primaryModel, provider: match.primaryProvider };
  } catch {
    return undefined;
  }
}

