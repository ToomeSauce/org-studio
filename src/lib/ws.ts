'use client';

import { useState, useEffect, useRef, useSyncExternalStore } from 'react';

type MessageType = 'sessions' | 'cron' | 'store' | 'activity-status' | 'gateway-status' | 'gateway-agents';

interface WSMessage {
  type: MessageType;
  data: any;
  ts: number;
}

// --- Singleton WebSocket manager ---
type Listener = (msg: WSMessage) => void;

class WSManager {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private _connected = false;
  private stateListeners = new Set<() => void>();
  private cache = new Map<MessageType, any>();

  get connected() { return this._connected; }

  private setConnected(v: boolean) {
    if (this._connected !== v) {
      this._connected = v;
      this.stateListeners.forEach(fn => fn());
    }
  }

  subscribeState(fn: () => void) {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  getConnected = () => this._connected;

  connect() {
    if (typeof window === 'undefined') return;
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) return;

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/ws`;

    try {
      this.ws = new WebSocket(url);
    } catch { return; }

    this.ws.onopen = () => {
      this.setConnected(true);
      this.reconnectDelay = 1000;
    };

    this.ws.onmessage = (event) => {
      try {
        const msg: WSMessage = JSON.parse(event.data);
        this.cache.set(msg.type, msg.data);
        this.listeners.forEach(fn => fn(msg));
      } catch {}
    };

    this.ws.onclose = () => {
      this.setConnected(false);
      this.ws = null;
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 15000);
      this.connect();
    }, this.reconnectDelay);
  }

  getCached(type: MessageType): any | undefined {
    return this.cache.get(type);
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) this.connect();
    return () => this.listeners.delete(fn);
  }

  disconnect() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.ws?.close();
    this.ws = null;
    this.setConnected(false);
  }
}

let manager: WSManager | null = null;

function getManager(): WSManager {
  if (!manager) {
    manager = new WSManager();
    if (typeof window !== 'undefined') {
      manager.connect();
    }
  }
  return manager;
}

// --- Hooks ---

/** Subscribe to a specific WS message type, returns latest data */
export function useWSData<T = any>(type: MessageType): T | null {
  const mgr = useRef(getManager());
  const [data, setData] = useState<T | null>(() => mgr.current.getCached(type) ?? null);

  useEffect(() => {
    // Sync from cache in case it updated between render and effect
    const cached = mgr.current.getCached(type);
    if (cached !== undefined) setData(cached);

    const unsub = mgr.current.subscribe((msg) => {
      if (msg.type === type) {
        setData(msg.data as T);
      }
    });
    return () => { unsub(); };
  }, [type]);

  return data;
}

/** WS connection state */
export function useWSConnected(): boolean {
  const mgr = useRef(getManager());

  return useSyncExternalStore(
    (cb) => mgr.current.subscribeState(cb),
    () => mgr.current.getConnected(),
    () => false,
  );
}

/** Combined hook for all live data */
export function useLiveData() {
  const sessions = useWSData<any>('sessions');
  const cron = useWSData<any>('cron');
  const store = useWSData<{ projects: any[]; tasks: any[] }>('store');
  const activityStatus = useWSData<any>('activity-status');
  const gatewayStatus = useWSData<any>('gateway-status');
  const connected = useWSConnected();

  return { sessions, cron, store, activityStatus, gatewayStatus, connected };
}
