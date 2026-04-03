/**
 * Shared Gateway RPC client — WebSocket connection to OpenClaw Gateway
 *
 * Used by both /api/gateway and /api/scheduler routes.
 * Maintains a singleton WebSocket connection across requests in the same Node process.
 */
import WebSocket from 'ws';

const GATEWAY_URL = process.env.GATEWAY_URL || 'ws://127.0.0.1:18789';
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || '';

// Connection state — persisted across requests in the same Node process
let ws: WebSocket | null = null;
let ready = false;
let requestId = 0;
const pending = new Map<number, {
  resolve: (v: any) => void;
  reject: (e: any) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

export function connect(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws?.readyState === WebSocket.OPEN && ready) return resolve();

    if (ws) { try { ws.close(); } catch {} }
    ws = null;
    ready = false;

    const sock = new WebSocket(GATEWAY_URL, {
      headers: { origin: 'http://127.0.0.1:18789' },
    });

    const timeout = setTimeout(() => {
      sock.close();
      reject(new Error('Gateway connect timeout'));
    }, 10000);

    sock.on('message', (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      // Step 1: respond to challenge
      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        sock.send(JSON.stringify({
          type: 'req',
          id: 'handshake',
          method: 'connect',
          params: {
            minProtocol: 3, maxProtocol: 3,
            client: { id: 'openclaw-control-ui', version: '0.1.0', platform: 'linux', mode: 'webchat' },
            role: 'operator',
            scopes: ['operator.read', 'operator.write', 'operator.admin'],
            caps: [], commands: [], permissions: {},
            auth: { token: GATEWAY_TOKEN },
            locale: 'en-US',
            userAgent: 'org-studio/0.1.0',
          },
        }));
        return;
      }

      // Step 2: handshake response
      if (msg.type === 'res' && msg.id === 'handshake') {
        clearTimeout(timeout);
        if (msg.ok) {
          ws = sock;
          ready = true;
          resolve();
        } else {
          sock.close();
          reject(new Error(JSON.stringify(msg.error)));
        }
        return;
      }

      // Step 3: RPC responses
      if (msg.type === 'res' && msg.id != null) {
        const id = typeof msg.id === 'string' ? parseInt(msg.id, 10) : msg.id;
        const p = pending.get(id);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(id);
          if (msg.ok === false || msg.error) p.reject(msg.error || 'error');
          else p.resolve(msg.payload ?? msg.result ?? msg);
        }
        return;
      }

      // Ignore events (tick, etc.)
    });

    sock.on('close', () => { ws = null; ready = false; });
    sock.on('error', () => { clearTimeout(timeout); ws = null; ready = false; });
  });
}

export async function rpc(method: string, params: Record<string, any> = {}): Promise<any> {
  await connect();
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Not connected');

  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`RPC timeout: ${method}`));
    }, 15000);

    pending.set(id, { resolve, reject, timer });
    ws!.send(JSON.stringify({ type: 'req', id: String(id), method, params }));
  });
}
