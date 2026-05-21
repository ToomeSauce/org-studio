/**
 * OpenClaw Runtime — connects to OpenClaw Gateway via WebSocket RPC
 */
import { rpc, connect } from '@/lib/gateway-rpc';
import type { AgentRuntime, RuntimeAgent, AgentMetadata } from './types';

export class OpenClawRuntime implements AgentRuntime {
  id = 'openclaw';
  name = 'OpenClaw';

  async discover(): Promise<RuntimeAgent[]> {
    try {
      await connect();
      const result = await rpc('agents.list');
      if (!result?.agents) return [];

      return result.agents.map((agent: any) => ({
        id: agent.id,
        name: agent.name || agent.id,
        emoji: agent.identity?.emoji,
        runtime: 'openclaw',
        status: agent.status || 'unknown',
        metadata: agent,
      }));
    } catch (e) {
      console.error('OpenClawRuntime.discover error:', e);
      return [];
    }
  }

  async send(
    agentId: string,
    message: string,
    opts?: { sessionKey?: string; idempotencyKey?: string }
  ): Promise<any> {
    try {
      await connect();
      const sessionKey = opts?.sessionKey || `agent:${agentId}:main`;
      return await rpc('chat.send', {
        sessionKey,
        message,
        idempotencyKey: opts?.idempotencyKey,
      });
    } catch (e) {
      console.error('OpenClawRuntime.send error:', e);
      throw e;
    }
  }

  async health(): Promise<{ connected: boolean; detail?: string }> {
    try {
      await connect();
      const status = await rpc('status');
      return {
        connected: true,
        detail: `Gateway ready. Server: ${status?.server || '?'}, Agents: ${status?.agents || '?'}`,
      };
    } catch (e) {
      return {
        connected: false,
        detail: typeof e === 'string' ? e : (e as any)?.message || 'Connection failed',
      };
    }
  }

  /**
   * #1353 — OpenClaw's canonical per-agent metadata lives on the
   * Gateway: the most recent session keyed `agent:<id>:main` carries
   * the active model (set when the session was bound to a model).
   *
   * Lifted directly from the inline lookup that previously lived in
   * `resolveAgentModel()` in src/app/api/store/route.ts. Behavior
   * MUST stay identical so route.ts's refactor in slice 2 is a
   * pure dispatch swap, not a behavior change.
   *
   * Best-effort: any failure (Gateway down, no matching session,
   * malformed response) returns undefined so the caller can fall
   * back to teammate-declared model or stamp nothing.
   *
   * The 1-second AbortController + container-staging guard pattern
   * from #1344 stays in resolveAgentModel itself; this runtime impl
   * only owns the Gateway round-trip when invoked from contexts
   * (e.g. the startup audit) that DO want to consult the gateway.
   * Callers in staging/container envs that can't talk to a Gateway
   * already skip getAgentMetadata via the same env-check guard.
   */
  async getAgentMetadata(agentId: string): Promise<AgentMetadata | undefined> {
    if (!agentId) return undefined;
    // #1353 / #1344 — container/staging guard moved IN here from route.ts
    // so the runtime owns its own env-discipline. The OpenClaw Gateway round-trip
    // talks to port 4501; in container/staging Next IS port 4501, so a fetch
    // would loop back into our own already-busy process and self-deadlock.
    // Hermes is filesystem-only and never hits this, so it doesn't need an
    // equivalent guard.
    const gatewayPortExplicit = !!process.env.GATEWAY_PORT;
    const inContainerOrStaging = !!(
      process.env.CONTAINER_APP_NAME ||
      process.env.WEBSITES_PORT ||
      process.env.K_SERVICE ||
      (process.env.NODE_ENV === 'production' && !process.env.GATEWAY_URL)
    );
    if (!gatewayPortExplicit && inContainerOrStaging) {
      return undefined;
    }
    // #1495 Bug 4 — was: fetch('http://127.0.0.1:${GATEWAY_PORT||4501}/api/gateway'.
    // That hit Org Studio's OWN port (4501), not the Gateway (18789), and was
    // auth-walled to boot — every call returned 401, getAgentMetadata silently
    // returned undefined, no model stamped on Billy/Thelma comments. Trevor
    // (Hermes runtime) worked because Hermes is filesystem-only and never hit
    // this broken HTTP path.
    //
    // Fix: use the same WebSocket rpc() helper that every other server-side
    // caller uses (gateway.ts, scheduler/route.ts, server.mjs). The WS is a
    // singleton across requests in the Node process, doesn't need auth, and
    // talks to the real Gateway URL from GATEWAY_URL env (ws://127.0.0.1:18789
    // by default). The 1s timeout discipline from #1344 is preserved via
    // Promise.race — AbortController has no clean WS surface so we race the
    // call against a sleep.
    const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T | undefined> =>
      Promise.race<T | undefined>([
        p,
        new Promise<undefined>((resolve) =>
          setTimeout(() => {
            console.warn(`[OpenClawRuntime.getAgentMetadata] ${label} timed out (${ms}ms) for ${agentId}`);
            resolve(undefined);
          }, ms),
        ),
      ]);
    try {
      await withTimeout(connect(), 1000, 'gateway connect');
      // 1. Primary source: latest active session keyed `agent:<id>:main`
      //    with a `model` stamp. This is what the agent is ACTUALLY
      //    running right now (may be a fallback model the runtime
      //    selected when the primary was unavailable). Matches the
      //    pre-#1353 behavior of route.ts — doneWhen #8 says Mikey
      //    still stamps opus-4.7 even though his configured primary
      //    is gpt-5.5.
      const sessionsResult = await withTimeout(
        rpc('sessions.list', { limit: 50 }),
        1000,
        'sessions.list',
      );
      const sessions = Array.isArray(sessionsResult)
        ? sessionsResult
        : (sessionsResult?.sessions || sessionsResult?.items || []);
      const agentSession = sessions.find(
        (s: any) => s.key?.startsWith(`agent:${agentId}:`) && s.model,
      );
      if (agentSession?.model) {
        return { model: agentSession.model };
      }
      // 2. Fallback source: agents.list metadata.model.primary. Used
      //    when no active session has been bound to a model yet
      //    (typical for agents that haven't received a message since
      //    Gateway restart). Honest degraded answer: "this is what
      //    the config DECLARES, lacking a live signal."
      try {
        const agentsResult = await withTimeout(rpc('agents.list'), 1000, 'agents.list');
        const agents = agentsResult?.agents || [];
        const match = agents.find((a: any) => a?.id === agentId);
        const primary = match?.model?.primary;
        if (primary) return { model: primary };
      } catch {
        // best-effort fallback; never throw
      }
      return undefined;
    } catch {
      return undefined; // best-effort; never throw
    }
  }

  dispose(): void {
    // WebSocket is managed by gateway-rpc module; no action needed here
  }
}
