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
 * Hook to subscribe to Gateway events
 */
export function useGatewayEvent(event: string, handler: (data: any) => void) {
  const { gateway } = useGateway();

  useEffect(() => {
    if (!gateway) return;
    const unsub = gateway.on(event, handler);
    return () => { unsub(); };
  }, [gateway, event, handler]);
}
