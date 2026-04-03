/**
 * OpenClaw Runtime — connects to OpenClaw Gateway via WebSocket RPC
 */
import { rpc, connect } from '@/lib/gateway-rpc';
import type { AgentRuntime, RuntimeAgent } from './types';

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

  dispose(): void {
    // WebSocket is managed by gateway-rpc module; no action needed here
  }
}
