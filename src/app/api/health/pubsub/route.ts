/**
 * GET /api/health/pubsub — PubSub health status (#864 vector #7).
 *
 * Returns: { connected, lastHeartbeatAt, reconnectCount, lastError, lastConnectedAt, stale }
 * `stale` is true if the last heartbeat is older than 60s (missed 2 heartbeat cycles).
 */
import { NextResponse } from 'next/server';

const STALE_THRESHOLD_MS = 60_000; // 2x heartbeat interval

export async function GET() {
  // Read from the global state set by server.mjs
  const health = (globalThis as any).__pubsubHealth || {
    connected: false,
    lastHeartbeatAt: null,
    reconnectCount: 0,
    lastError: 'Health state not initialized (server.mjs not running)',
    lastConnectedAt: null,
  };

  const lastHb = health.lastHeartbeatAt ? Date.parse(health.lastHeartbeatAt) : null;
  const stale = lastHb ? (Date.now() - lastHb > STALE_THRESHOLD_MS) : !health.connected;

  return NextResponse.json({
    connected: health.connected,
    lastHeartbeatAt: health.lastHeartbeatAt,
    lastConnectedAt: health.lastConnectedAt,
    reconnectCount: health.reconnectCount,
    lastError: health.lastError,
    stale,
    ...(lastHb ? { heartbeatAgeMs: Date.now() - lastHb } : {}),
  });
}
