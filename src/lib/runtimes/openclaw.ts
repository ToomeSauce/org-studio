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
    try {
      // #1344: 1-second AbortController on the Gateway round-trip.
      // Use the HTTP route (same path resolveAgentModel used) rather
      // than direct rpc() because the AbortController surface is
      // simpler over fetch.
      const port = process.env.GATEWAY_PORT || '4501';
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 1000);
      let resp: Response;
      try {
        resp = await fetch(`http://127.0.0.1:${port}/api/gateway`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method: 'sessions.list', params: { limit: 50 } }),
          signal: ac.signal,
        });
      } catch (e: any) {
        if (e?.name === 'AbortError') {
          console.warn(`[OpenClawRuntime.getAgentMetadata] gateway fetch timed out for ${agentId}`);
        }
        return undefined;
      } finally {
        clearTimeout(timer);
      }
      const data = await resp.json().catch(() => null);
      if (!data) return undefined;
      const sessions = Array.isArray(data.result)
        ? data.result
        : (data.result?.sessions || data.result?.items || []);
      // Match the latest active session for this agent that has a model stamp.
      const agentSession = sessions.find(
        (s: any) => s.key?.startsWith(`agent:${agentId}:`) && s.model,
      );
      if (!agentSession?.model) return undefined;
      return { model: agentSession.model };
    } catch {
      return undefined; // best-effort; never throw
    }
  }

  dispose(): void {
    // WebSocket is managed by gateway-rpc module; no action needed here
  }
}
