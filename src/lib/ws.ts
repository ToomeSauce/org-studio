'use client';

import { useState, useEffect, useRef, useSyncExternalStore } from 'react';

type MessageType = 'sessions' | 'cron' | 'store' | 'activity-status' | 'gateway-status' | 'gateway-agents';

interface WSMessage {
  type: MessageType;
  data: any;
  ts: number;
}

// HTTP fallback configuration
const HTTP_FALLBACK_TIMEOUT = 2000; // 2 seconds before trying HTTP fallback
const HTTP_POLL_INTERVAL = 5000; // 5 seconds between polls
const GATEWAY_ONLY_TYPES: MessageType[] = ['sessions', 'cron', 'gateway-status', 'gateway-agents'];

// Map message types to HTTP endpoints
function getHttpEndpoint(type: MessageType): string | null {
  switch (type) {
    case 'store':
      return '/api/store';
    case 'activity-status':
      return '/api/activity-status';
    default:
      // Gateway-only types have no HTTP fallback
      return null;
  }
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
  private httpPollers = new Map<MessageType, ReturnType<typeof setInterval> | null>();
  private httpFallbackTimers = new Map<MessageType, ReturnType<typeof setTimeout>>();
  private _httpAvailable = false;
  private httpCheckTimer: ReturnType<typeof setInterval> | null = null;

  get connected() { return this._connected; }
  get httpAvailable() { return this._httpAvailable; }

  private setConnected(v: boolean) {
    if (this._connected !== v) {
      this._connected = v;
      this.stateListeners.forEach(fn => fn());
    }
  }

  private setHttpAvailable(v: boolean) {
    if (this._httpAvailable !== v) {
      this._httpAvailable = v;
      this.stateListeners.forEach(fn => fn());
    }
  }

  subscribeState(fn: () => void) {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  getConnected = () => this._connected;
  getHttpAvailable = () => this._httpAvailable;

  // Periodic check if HTTP API is available
  private startHttpCheck() {
    if (this.httpCheckTimer) return;
    this.httpCheckTimer = setInterval(() => {
      this.checkHttpAvailability();
    }, 30000); // Check every 30 seconds
    // Initial check immediately
    this.checkHttpAvailability();
  }

  private stopHttpCheck() {
    if (this.httpCheckTimer) {
      clearInterval(this.httpCheckTimer);
      this.httpCheckTimer = null;
    }
  }

  private async checkHttpAvailability() {
    try {
      const resp = await fetch('/api/store', { method: 'HEAD', cache: 'no-store' });
      this.setHttpAvailable(resp.ok);
    } catch {
      this.setHttpAvailable(false);
    }
  }

  connect() {
    if (typeof window === 'undefined') return;
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) return;

    // Start HTTP availability check immediately as a safety net
    // (will be stopped if WS connects successfully)
    if (!this.httpCheckTimer) this.startHttpCheck();

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/ws`;

    try {
      this.ws = new WebSocket(url);
    } catch { return; }

    this.ws.onopen = () => {
      this.setConnected(true);
      this.reconnectDelay = 1000;
      this.stopHttpCheck(); // Stop polling HTTP when WS is connected
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
      this.startHttpCheck(); // Start HTTP polling when WS disconnects
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

  // Start HTTP polling fallback for a specific message type
  private startHttpFallback(type: MessageType) {
    const endpoint = getHttpEndpoint(type);
    if (!endpoint) return; // No HTTP fallback for this type

    // Clear any existing timer
    if (this.httpFallbackTimers.has(type)) {
      clearTimeout(this.httpFallbackTimers.get(type)!);
      this.httpFallbackTimers.delete(type);
    }

    // Don't start multiple pollers for the same type
    if (this.httpPollers.has(type)) return;

    // Set up initial poll immediately
    this.pollHttpEndpoint(type, endpoint);

    // Then set up interval polling
    const interval = setInterval(() => {
      this.pollHttpEndpoint(type, endpoint);
    }, HTTP_POLL_INTERVAL);

    this.httpPollers.set(type, interval);
  }

  private async pollHttpEndpoint(type: MessageType, endpoint: string) {
    try {
      const resp = await fetch(endpoint, { cache: 'no-store' });
      if (resp.ok) {
        const data = await resp.json();
        this.cache.set(type, data);
        // Emit to listeners even though not from WS
        this.listeners.forEach(fn => fn({ type, data, ts: Date.now() }));
      }
    } catch {
      // Silently fail, will retry next interval
    }
  }

  private stopHttpFallback(type: MessageType) {
    const interval = this.httpPollers.get(type);
    if (interval) {
      clearInterval(interval);
      this.httpPollers.delete(type);
    }
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) this.connect();
    return () => this.listeners.delete(fn);
  }

  // Subscribe with HTTP fallback after timeout
  subscribeWithFallback(type: MessageType, fn: Listener) {
    const unsub = this.subscribe(fn);

    // Set up timeout to start HTTP fallback if WS doesn't connect
    const timer = setTimeout(() => {
      if (!this._connected && getHttpEndpoint(type)) {
        this.startHttpFallback(type);
      }
    }, HTTP_FALLBACK_TIMEOUT);

    this.httpFallbackTimers.set(type, timer);

    return () => {
      unsub();
      // Clear the fallback timer if unsubscribed
      clearTimeout(this.httpFallbackTimers.get(type));
      this.httpFallbackTimers.delete(type);
      this.stopHttpFallback(type);
    };
  }

  disconnect() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.ws?.close();
    this.ws = null;
    this.setConnected(false);
    this.stopHttpCheck();
    // Stop all HTTP pollers
    this.httpPollers.forEach(interval => {
      if (interval) clearInterval(interval);
    });
    this.httpPollers.clear();
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

/** Subscribe to a specific WS message type, returns latest data. Falls back to HTTP polling if WS unavailable. */
export function useWSData<T = any>(type: MessageType): T | null {
  const mgr = useRef(getManager());
  const [data, setData] = useState<T | null>(() => mgr.current.getCached(type) ?? null);

  useEffect(() => {
    // Sync from cache in case it updated between render and effect
    const cached = mgr.current.getCached(type);
    if (cached !== undefined) setData(cached);

    // Use the fallback-aware subscription
    const unsub = mgr.current.subscribeWithFallback(type, (msg) => {
      if (msg.type === type) {
        setData(msg.data as T);
      }
    });
    return () => { unsub(); };
  }, [type]);

  return data;
}

/** WS connection state + HTTP availability */
export function useWSConnected(): boolean {
  const mgr = useRef(getManager());

  return useSyncExternalStore(
    (cb) => mgr.current.subscribeState(cb),
    () => mgr.current.getConnected(),
    () => false,
  );
}

/** HTTP API availability (for cloud deployments) */
export function useHttpAvailable(): boolean {
  const mgr = useRef(getManager());

  return useSyncExternalStore(
    (cb) => mgr.current.subscribeState(cb),
    () => mgr.current.getHttpAvailable(),
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
  const httpAvailable = useHttpAvailable();

  return { sessions, cron, store, activityStatus, gatewayStatus, connected, httpAvailable };
}

