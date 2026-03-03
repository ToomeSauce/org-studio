import { NextRequest, NextResponse } from 'next/server';
import WebSocket from 'ws';

/**
 * Server-side Gateway proxy
 * Handles the full Gateway handshake protocol (connect.challenge → connect → RPC)
 * Gateway stays on localhost — browser never touches it directly.
 */

const GATEWAY_URL = process.env.GATEWAY_URL || 'ws://127.0.0.1:18789';
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || '';

let wsConnection: WebSocket | null = null;
let handshakeComplete = false;
let requestId = 0;

const pending = new Map<number, {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timeout: ReturnType<typeof setTimeout>;
}>();

function ensureConnection(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    if (wsConnection?.readyState === WebSocket.OPEN && handshakeComplete) {
      return resolve(wsConnection);
    }

    // Close stale connection
    if (wsConnection) {
      try { wsConnection.close(); } catch {}
      wsConnection = null;
      handshakeComplete = false;
    }

    const ws = new WebSocket(GATEWAY_URL, {
      headers: { origin: 'http://127.0.0.1:18789' },
    });
    let connectTimeout: ReturnType<typeof setTimeout>;

    connectTimeout = setTimeout(() => {
      ws.close();
      reject(new Error('Gateway connection timeout'));
    }, 10000);

    ws.on('open', () => {
      // Wait for connect.challenge from gateway
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        // Handle connect.challenge → send connect handshake
        if (msg.type === 'event' && msg.event === 'connect.challenge') {
          const connectReq = {
            type: 'req',
            id: 'mc-connect',
            method: 'connect',
            params: {
              minProtocol: 3,
              maxProtocol: 3,
              client: {
                id: 'openclaw-control-ui',
                version: '0.1.0',
                platform: 'linux',
                mode: 'webchat',
              },
              role: 'operator',
              scopes: ['operator.read', 'operator.write'],
              caps: [],
              commands: [],
              permissions: {},
              auth: { token: GATEWAY_TOKEN },
              locale: 'en-US',
              userAgent: 'mission-control/0.1.0',
            },
          };
          ws.send(JSON.stringify(connectReq));
          return;
        }

        // Handle connect response (hello-ok)
        if (msg.type === 'res' && msg.id === 'mc-connect') {
          if (msg.ok) {
            clearTimeout(connectTimeout);
            wsConnection = ws;
            handshakeComplete = true;
            resolve(ws);
          } else {
            clearTimeout(connectTimeout);
            ws.close();
            reject(new Error(`Gateway handshake failed: ${JSON.stringify(msg.error)}`));
          }
          return;
        }

        // Handle RPC responses
        if (msg.type === 'res' && msg.id !== undefined) {
          const resolvedId = typeof msg.id === 'string' ? parseInt(msg.id) : msg.id;
          if (pending.has(resolvedId)) {
            const { resolve, reject, timeout } = pending.get(resolvedId)!;
            clearTimeout(timeout);
            pending.delete(numId);
            if (msg.ok === false || msg.error) {
              reject(msg.error || { message: 'RPC error' });
            } else {
              resolve(msg.payload ?? msg.result ?? msg.data ?? msg);
            }
          }
          return;
        }

        // Ignore other events (tick, broadcast, etc.)
      } catch {}
    });

    ws.on('close', () => {
      wsConnection = null;
      handshakeComplete = false;
      for (const [id, { reject, timeout }] of pending) {
        clearTimeout(timeout);
        reject(new Error('Gateway connection closed'));
      }
      pending.clear();
    });

    ws.on('error', (err) => {
      clearTimeout(connectTimeout);
      wsConnection = null;
      handshakeComplete = false;
      reject(err);
    });
  });
}

async function rpc(method: string, params: Record<string, any> = {}, timeoutMs = 15000): Promise<any> {
  const ws = await ensureConnection();
  const id = ++requestId;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`RPC timeout: ${method}`));
    }, timeoutMs);

    pending.set(id, { resolve, reject, timeout });

    ws.send(JSON.stringify({
      type: 'req',
      id: String(id),
      method,
      params,
    }));
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { method, params } = body;

    if (!method || typeof method !== 'string') {
      return NextResponse.json({ error: 'Missing method' }, { status: 400 });
    }

    const result = await rpc(method, params || {});
    return NextResponse.json({ result });
  } catch (error: any) {
    const message = error?.message || String(error);
    const isConnectionError = message.includes('connection') || message.includes('timeout') || message.includes('handshake');
    return NextResponse.json(
      { error: message },
      { status: isConnectionError ? 502 : 500 }
    );
  }
}
