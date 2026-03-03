/**
 * OpenClaw Gateway WebSocket client
 * Connects to the local Gateway on port 18789
 */

type GatewayEventHandler = (data: any) => void;
type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timeout: ReturnType<typeof setTimeout>;
}

class GatewayClient {
  private ws: WebSocket | null = null;
  private url: string;
  private token: string | null;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private listeners = new Map<string, Set<GatewayEventHandler>>();
  private stateListeners = new Set<(state: ConnectionState) => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _state: ConnectionState = 'disconnected';

  constructor(url = 'ws://127.0.0.1:18789', token: string | null = null) {
    this.url = url;
    this.token = token;
  }

  get state(): ConnectionState {
    return this._state;
  }

  private setState(state: ConnectionState) {
    this._state = state;
    this.stateListeners.forEach(fn => fn(state));
  }

  onStateChange(fn: (state: ConnectionState) => void) {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.setState('connecting');

    const params = new URLSearchParams();
    if (this.token) params.set('token', this.token);

    const wsUrl = params.toString()
      ? `${this.url}?${params.toString()}`
      : this.url;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.setState('connected');
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        // RPC response
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject, timeout } = this.pending.get(msg.id)!;
          clearTimeout(timeout);
          this.pending.delete(msg.id);
          if (msg.error) reject(msg.error);
          else resolve(msg.result ?? msg.data ?? msg);
        }
        // Event broadcast
        if (msg.event || msg.type) {
          const eventName = msg.event || msg.type;
          this.listeners.get(eventName)?.forEach(fn => fn(msg));
          this.listeners.get('*')?.forEach(fn => fn(msg));
        }
      } catch {
        // ignore parse errors
      }
    };

    this.ws.onclose = () => {
      this.setState('disconnected');
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.setState('error');
    };
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.setState('disconnected');
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }

  /**
   * Send an RPC request to the Gateway
   */
  async rpc(method: string, params: Record<string, any> = {}, timeoutMs = 15000): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Gateway not connected');
    }

    const id = ++this.requestId;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeout });

      this.ws!.send(JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params,
      }));
    });
  }

  /**
   * Subscribe to gateway events
   */
  on(event: string, handler: GatewayEventHandler) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
    return () => this.listeners.get(event)?.delete(handler);
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

export function getGateway(url?: string, token?: string): GatewayClient {
  if (!instance) {
    const savedToken = typeof window !== 'undefined'
      ? localStorage.getItem('mc_gateway_token')
      : null;
    instance = new GatewayClient(url, token || savedToken);
  }
  return instance;
}

export function setGatewayToken(token: string) {
  if (typeof window !== 'undefined') {
    localStorage.setItem('mc_gateway_token', token);
  }
  // Reconnect with new token
  if (instance) {
    instance.disconnect();
    instance = null;
  }
}

export type { ConnectionState, GatewayClient };
