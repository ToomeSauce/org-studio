/**
 * Runtime Adapter — OpenClaw Gateway (default)
 *
 * This file implements the connection between Org Studio and the agent runtime.
 * By default it connects to an OpenClaw Gateway via WebSocket.
 *
 * To integrate a different runtime (CrewAI, LangGraph, AutoGen, etc.):
 * 1. Replace the connect/rpc functions with your runtime's protocol
 * 2. Ensure RPC methods return compatible shapes:
 *    - sessions.list → { sessions: [{ key, updatedAt, model, ... }] }
 *    - agents.list   → { agents: [{ id, identity: { name, emoji } }] }
 *    - cron.list     → { jobs: [{ id, enabled, schedule, ... }] }
 *    - status        → { heartbeat, sessions, ... }
 * 3. Or implement a REST adapter and skip WebSocket entirely
 *
 * See README.md for the generic REST API spec.
 */
import { NextRequest, NextResponse } from 'next/server';
import { rpc } from '@/lib/gateway-rpc';

export async function POST(request: NextRequest) {
  try {
    const { method, params } = await request.json();
    if (!method) return NextResponse.json({ error: 'Missing method' }, { status: 400 });
    const result = await rpc(method, params || {});
    return NextResponse.json({ result });
  } catch (e: any) {
    const msg = typeof e === 'string' ? e : e?.message || JSON.stringify(e);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
