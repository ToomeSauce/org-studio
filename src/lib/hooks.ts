'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { getGateway, type ConnectionState, type GatewayClient } from './gateway';

/**
 * Hook to access the Gateway connection
 */
export function useGateway() {
  const [state, setState] = useState<ConnectionState>('disconnected');
  const gwRef = useRef<GatewayClient | null>(null);

  useEffect(() => {
    const gw = getGateway();
    gwRef.current = gw;
    setState(gw.state);

    const unsub = gw.onStateChange(setState);
    gw.connect();

    return () => {
      unsub();
    };
  }, []);

  return { gateway: gwRef.current, state };
}

/**
 * Hook to poll a Gateway RPC method at an interval
 */
export function useGatewayQuery<T>(
  method: string,
  params: Record<string, any> = {},
  intervalMs = 10000
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { gateway, state } = useGateway();

  const fetch = useCallback(async () => {
    if (!gateway || state !== 'connected') return;
    try {
      const result = await gateway.rpc(method, params);
      setData(result);
      setError(null);
    } catch (e: any) {
      setError(e.message || 'RPC error');
    } finally {
      setLoading(false);
    }
  }, [gateway, state, method, JSON.stringify(params)]);

  useEffect(() => {
    fetch();
    if (intervalMs > 0) {
      const timer = setInterval(fetch, intervalMs);
      return () => clearInterval(timer);
    }
  }, [fetch, intervalMs]);

  return { data, error, loading, refetch: fetch };
}

/**
 * Hook to poll the file-backed store (projects/tasks) at an interval
 */
export function useStoreQuery(intervalMs = 5000) {
  const [data, setData] = useState<{ projects: any[]; tasks: any[] } | null>(null);
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(async () => {
    try {
      const resp = await globalThis.fetch('/api/store');
      if (resp.ok) {
        const result = await resp.json();
        setData(result);
      }
    } catch {} finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
    const timer = setInterval(fetch, intervalMs);
    return () => clearInterval(timer);
  }, [fetch, intervalMs]);

  return { data, loading, refetch: fetch };
}

/**
 * Hook to poll agent activity statuses
 */
export function useActivityStatus(intervalMs = 4000) {
  const [statuses, setStatuses] = useState<Record<string, any>>({});

  useEffect(() => {
    const fetch = async () => {
      try {
        const resp = await globalThis.fetch('/api/activity-status');
        if (resp.ok) {
          const result = await resp.json();
          setStatuses(result.statuses || {});
        }
      } catch {}
    };
    fetch();
    const timer = setInterval(fetch, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return statuses;
}

// Note: live event streaming (SSE/WS) will be added later via /api/gateway/events
// For now, all data is fetched via polling through the server-side proxy
