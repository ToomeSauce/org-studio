/**
 * Hermes Runtime — connects to a local Hermes instance
 * 
 * Hermes runs one agent per gateway (one profile). If Hermes is running,
 * discover() returns a single agent representing that Hermes instance.
 * 
 * Config via env:
 * - HERMES_URL: http://127.0.0.1:8642 (optional OpenAI-compatible API server)
 * - If not set, this runtime is inactive.
 */
import type { AgentRuntime, RuntimeAgent } from './types';
import { readFileSync } from 'fs';
import { join } from 'path';
import { existsSync } from 'fs';

const HERMES_URL = process.env.HERMES_URL || '';
const HERMES_HOST = HERMES_URL ? new URL(HERMES_URL).hostname : '127.0.0.1';

export class HermesRuntime implements AgentRuntime {
  id = 'hermes';
  name = 'Hermes Agent';
  private agentName = 'Hermes Agent';

  constructor() {
    // Try to load agent name from Hermes config
    try {
      const hermesCfgPath = join(process.env.HOME || '~', '.hermes', 'config.yaml');
      if (existsSync(hermesCfgPath)) {
        const content = readFileSync(hermesCfgPath, 'utf-8');
        // Parse YAML name field (basic: look for "name: ...")
        const match = content.match(/^name:\s*(.+)$/m);
        if (match) {
          this.agentName = match[1].trim();
        }
      }
    } catch {
      // Fallback to default name
    }
  }

  async discover(): Promise<RuntimeAgent[]> {
    // If Hermes is not configured, return empty
    if (!HERMES_URL) return [];

    try {
      const health = await this._healthCheck();
      if (!health.connected) return [];

      // Try to get model name from /v1/models
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
        // Use default name
      }

      return [
        {
          id: `hermes-${HERMES_HOST}`,
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

  async send(
    agentId: string,
    message: string,
    opts?: { sessionKey?: string; idempotencyKey?: string }
  ): Promise<any> {
    if (!HERMES_URL) throw new Error('Hermes runtime not configured (HERMES_URL not set)');

    try {
      const response = await fetch(`${HERMES_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'hermes',
          messages: [{ role: 'user', content: message }],
          stream: false,
        }),
      });

      if (!response.ok) {
        throw new Error(`Hermes API error: ${response.status}`);
      }

      return await response.json();
    } catch (e) {
      console.error('HermesRuntime.send error:', e);
      throw e;
    }
  }

  async health(): Promise<{ connected: boolean; detail?: string }> {
    if (!HERMES_URL) {
      return {
        connected: false,
        detail: 'Not configured (HERMES_URL not set)',
      };
    }

    return this._healthCheck();
  }

  private async _healthCheck(): Promise<{ connected: boolean; detail?: string }> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);

      const response = await fetch(`${HERMES_URL}/health`, {
        signal: controller.signal as any,
      });

      clearTimeout(timeout);

      if (response.ok) {
        return { connected: true, detail: 'Hermes API server ready' };
      } else {
        return { connected: false, detail: `Hermes health check failed: ${response.status}` };
      }
    } catch (e: any) {
      const detail = e?.name === 'AbortError' ? 'Health check timeout' : (e?.message || 'Health check failed');
      return { connected: false, detail };
    }
  }

  dispose(): void {
    // No persistent connections to clean up
  }
}
