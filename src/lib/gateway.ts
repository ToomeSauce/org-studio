/**
 * OpenClaw Gateway client — server-side proxy mode
 * 
 * Browser talks to /api/gateway (Next.js API route),
 * which proxies to the Gateway WS on localhost:18789.
 * Gateway stays bound to localhost — no LAN exposure.
 */

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

class GatewayClient {
  private stateListeners = new Set<(state: ConnectionState) => void>();
  private _state: ConnectionState = 'disconnected';
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  get state(): ConnectionState {
    return this._state;
  }

  private setState(state: ConnectionState) {
    if (this._state === state) return;
    this._state = state;
    this.stateListeners.forEach(fn => fn(state));
  }

  onStateChange(fn: (state: ConnectionState) => void) {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  connect() {
    // Test connection with a status call
    this.setState('connecting');
    this.rpc('status')
      .then(() => this.setState('connected'))
      .catch(() => this.setState('error'));

    // Poll for connection health every 30s
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => {
        this.rpc('status')
          .then(() => this.setState('connected'))
          .catch(() => this.setState('disconnected'));
      }, 30000);
    }
  }

  disconnect() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.setState('disconnected');
  }

  /**
   * Send an RPC request via the server-side proxy
   */
  async rpc(method: string, params: Record<string, any> = {}): Promise<any> {
    const resp = await fetch('/api/gateway', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params }),
    });

    const data = await resp.json();

    if (!resp.ok || data.error) {
      throw new Error(data.error || `HTTP ${resp.status}`);
    }

    return data.result;
  }

  // === Convenience methods ===

  async getStatus() {
    return this.rpc('status');
  }

  async getSessions(limit = 50) {
    return this.rpc('sessions.list', { limit });
  }

  async getCronJobs() {
    return this.rpc('cron.list');
  }

  async getCronHistory(jobId: string, limit = 10) {
    return this.rpc('cron.history', { jobId, limit });
  }

  async toggleCronJob(jobId: string, enabled: boolean) {
    return this.rpc('cron.patch', { jobId, enabled });
  }

  async runCronJob(jobId: string) {
    return this.rpc('cron.run', { jobId });
  }

  async getConfig() {
    return this.rpc('config.get');
  }

  async patchConfig(patch: Record<string, any>) {
    return this.rpc('config.patch', { patch });
  }

  async getHealth() {
    return this.rpc('health');
  }

  async getModels() {
    return this.rpc('models.list');
  }

  async sendChat(message: string, sessionKey?: string) {
    return this.rpc('chat.send', { message, sessionKey });
  }

  async getChatHistory(sessionKey?: string) {
    return this.rpc('chat.history', { sessionKey });
  }

  async getNodes() {
    return this.rpc('node.list');
  }

  async getSkills() {
    return this.rpc('skills.status');
  }
}

// Singleton instance
let instance: GatewayClient | null = null;

export function getGateway(): GatewayClient {
  if (!instance) {
    instance = new GatewayClient();
  }
  return instance;
}

export type { ConnectionState, GatewayClient };
