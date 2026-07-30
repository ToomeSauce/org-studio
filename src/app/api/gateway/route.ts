/**
 * Runtime Adapter — OpenClaw Gateway (default)
 *
 * This file implements the connection between Org Studio and the agent runtime.
 * By default it connects to an OpenClaw Gateway via WebSocket.
 *
 * OpenClaw and Hermes are the supported runtimes. The internal adapter
 * boundary keeps their protocols isolated from API handlers; it is not a
 * compatibility promise for arbitrary agent frameworks.
 *
 * Compatible adapters return these shapes:
 *    - sessions.list → { sessions: [{ key, updatedAt, model, ... }] }
 *    - agents.list   → { agents: [{ id, identity: { name, emoji } }] }
 *    - cron.list     → { jobs: [{ id, enabled, schedule, ... }] }
 *    - status        → { heartbeat, sessions, ... }
 *
 * See docs/architecture.md for the supported runtime architecture.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequestWithContext, requireWriteScope } from '@/lib/auth';
import { rpc } from '@/lib/gateway-rpc';

export async function POST(request: NextRequest) {
  // #1386 Phase 2: require auth + write-scope.
  const authCtx = await authenticateRequestWithContext(request);
  if (authCtx.error) return authCtx.error;
  const scopeFail = requireWriteScope(authCtx.context);
  if (scopeFail) return scopeFail;

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
