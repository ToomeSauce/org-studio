// Merge Gateway agents with store teammates.
// Gateway is source of truth for agent existence.
// Store provides enrichment (color, domain, description) + human teammates.

import { Teammate } from './teammates';

interface GatewayAgent {
  id: string;
  name?: string;
  identity?: {
    name?: string;
    emoji?: string;
  };
}

interface GatewayAgentsResult {
  agents?: GatewayAgent[];
  defaultId?: string;
}

const DEFAULT_AGENT_COLORS = ['cyan', 'emerald', 'purple', 'blue', 'pink', 'orange'];

export function mergeTeammates(
  storeTeammates: Teammate[],
  gatewayAgents: GatewayAgentsResult | null,
): { merged: Teammate[]; newAgents: GatewayAgent[] } {
  const gwAgents = gatewayAgents?.agents || [];
  const gwAgentIds = new Set(gwAgents.map(a => a.id));
  const storeByAgentId = new Map<string, Teammate>();
  const storeHumans: Teammate[] = [];

  for (const t of storeTeammates) {
    if (t.isHuman || !t.agentId) {
      storeHumans.push(t);
    } else {
      storeByAgentId.set(t.agentId, t);
    }
  }

  const merged: Teammate[] = [];
  const newAgents: GatewayAgent[] = [];

  // 1. Humans first (store-only)
  merged.push(...storeHumans);

  // 2. Gateway agents — enriched with store data
  let colorIdx = 0;
  for (const gw of gwAgents) {
    const existing = storeByAgentId.get(gw.id);
    if (existing) {
      // Merge: store metadata wins, but use gateway name/emoji as fallback
      merged.push({
        ...existing,
        name: existing.name || gw.identity?.name || gw.name || gw.id,
        emoji: existing.emoji || gw.identity?.emoji || '🤖',
      });
      storeByAgentId.delete(gw.id);
    } else {
      // New agent from Gateway — auto-scaffold
      const color = DEFAULT_AGENT_COLORS[colorIdx % DEFAULT_AGENT_COLORS.length];
      colorIdx++;
      const newTeammate: Teammate = {
        id: gw.id,
        agentId: gw.id,
        name: gw.identity?.name || gw.name || gw.id,
        emoji: gw.identity?.emoji || '🤖',
        title: 'Agent',
        domain: '',
        description: '',
        color,
        isHuman: false,
      };
      merged.push(newTeammate);
      newAgents.push(gw);
    }
  }

  // 3. Store agents not in Gateway — mark as disconnected but keep them
  // (User may have customized them; removing silently would lose data)
  for (const [, orphan] of storeByAgentId) {
    merged.push({ ...orphan, _disconnected: true } as any);
  }

  return { merged, newAgents };
}

// Check if Gateway data is available
export function hasGateway(gatewayAgents: GatewayAgentsResult | null): boolean {
  return gatewayAgents !== null && Array.isArray(gatewayAgents.agents);
}
