/**
 * POST /api/ping — Send a message to any agent, routed through the runtime registry.
 *
 * Works for OpenClaw agents (via WebSocket RPC) and Hermes agents (via HTTP API).
 * Used by the Ping panel in the top nav.
 *
 * #1623 / #1610 F-P1: this endpoint is NOT public in cloud mode. We reuse the
 * same conditional read-style gate as the other launch-hardening fixes: when
 * DATABASE_URL is configured (hosted/cloud), require real auth; localhost/file
 * mode without auth configured stays open for OSS/dev ergonomics.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sendToAgent } from '@/lib/runtimes/registry';
import { rpc } from '@/lib/gateway-rpc';
import { authenticateRequestWithContext, requireWriteScope } from '@/lib/auth';
import { isCloudMode } from '@/lib/read-gate';

export async function POST(request: NextRequest) {
  if (isCloudMode()) {
    const auth = await authenticateRequestWithContext(request);
    if (auth.error) return auth.error;
    const denied = requireWriteScope(auth.context);
    if (denied) return denied;
  }
  try {
    const { agentId, message, sessionKey } = await request.json();
    if (!agentId || !message) {
      return NextResponse.json({ error: 'Missing agentId or message' }, { status: 400 });
    }

    const idempotencyKey = `ping-${agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      // Try runtime registry first (routes to correct runtime)
      const result = await sendToAgent(agentId, message, {
        sessionKey: sessionKey || `agent:${agentId}:main`,
        idempotencyKey,
      });
      return NextResponse.json({ ok: true, result });
    } catch (registryErr) {
      // Fallback: direct OpenClaw RPC (agent might not be in registry cache)
      try {
        const result = await rpc('chat.send', {
          sessionKey: sessionKey || `agent:${agentId}:main`,
          message,
          idempotencyKey,
        });
        return NextResponse.json({ ok: true, result });
      } catch (rpcErr) {
        return NextResponse.json(
          { error: `Failed to reach agent ${agentId}: ${(registryErr as any)?.message}` },
          { status: 502 }
        );
      }
    }
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Unknown error' }, { status: 500 });
  }
}
