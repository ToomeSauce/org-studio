/**
 * GET /api/runtimes — Discover all configured runtimes with health + agents
 * 
 * Returns only runtimes that are actually configured (based on env vars
 * and local detection). A fresh install with no runtimes returns an empty array.
 * 
 * Also auto-scaffolds newly discovered agents into the teammate store
 * so they appear on all pages (Home, Team, etc.) in both file and Postgres mode.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getRuntimeRegistry } from '@/lib/runtimes/registry';
import { getStoreProvider } from '@/lib/store-provider';

const DEFAULT_AGENT_COLORS = ['cyan', 'emerald', 'purple', 'blue', 'pink', 'orange'];

export async function GET(request: NextRequest) {
  try {
    const registry = await getRuntimeRegistry();

    // Discover all agents from all configured runtimes
    const allAgents = await registry.discoverAll();

    // Get health status for each runtime
    const health = await registry.healthAll();

    // Auto-scaffold: persist any newly discovered agents into the store
    try {
      const store = await getStoreProvider().read();
      const teammates = store?.settings?.teammates || [];
      const existingAgentIds = new Set(
        teammates.filter((t: any) => t.agentId).map((t: any) => t.agentId)
      );

      const newAgents = allAgents.filter(a => !existingAgentIds.has(a.id));
      if (newAgents.length > 0) {
        let colorIdx = teammates.filter((t: any) => !t.isHuman).length;
        const updatedTeammates = [...teammates];
        const loops = store?.settings?.loops || [];
        const updatedLoops = [...loops];
        let loopsCreated = 0;

        for (const agent of newAgents) {
          const color = DEFAULT_AGENT_COLORS[colorIdx % DEFAULT_AGENT_COLORS.length];
          colorIdx++;
          updatedTeammates.push({
            id: agent.id,
            agentId: agent.id,
            name: agent.name || agent.id,
            emoji: agent.emoji || '🤖',
            title: 'Agent',
            domain: '',
            description: '',
            color,
            isHuman: false,
          });

          // Auto-create scheduler loop (mirrors addTeammate logic)
          if (!updatedLoops.some((l: any) => l.agentId === agent.id)) {
            const maxOffset = updatedLoops.reduce((max: number, l: any) => Math.max(max, l.startOffsetMinutes || 0), 0);
            updatedLoops.push({
              id: 'loop-' + Math.random().toString(36).slice(2, 10),
              steps: [
                { id: 'step-org', type: 'read-org', enabled: true, description: 'Read ORG.md — refresh mission, values, domain boundaries' },
                { id: 'step-sync', type: 'sync-tasks', enabled: true, description: 'Sync tasks — check Context Board for assigned work' },
                { id: 'step-work', type: 'work-next', enabled: true, description: 'Work next — progress highest priority in-progress task, or pull from backlog' },
                { id: 'step-report', type: 'report', enabled: true, description: 'Report — update task status, move completed to Done, set activity status' },
              ],
              agentId: agent.id,
              enabled: true,
              cronJobId: null,
              intervalMinutes: 30,
              startOffsetMinutes: maxOffset + 5,
            });
            loopsCreated++;
          }
        }

        await getStoreProvider().updateSettings({ teammates: updatedTeammates, loops: updatedLoops });
        console.log(`[Runtimes] Auto-scaffolded ${newAgents.length} new agent(s): ${newAgents.map(a => a.id).join(', ')}${loopsCreated ? ` (${loopsCreated} loop(s) created)` : ''}`);
      }
    } catch (scaffoldErr) {
      // Best-effort — don't fail the response if scaffolding fails
      console.warn('[Runtimes] Auto-scaffold failed:', (scaffoldErr as any)?.message);
    }

    // Build response dynamically from whatever runtimes are registered
    const runtimes = Object.entries(health).map(([id, status]) => ({
      id,
      name: registry.getRuntimeName(id) || id,
      connected: status.connected,
      detail: status.detail,
      agents: allAgents.filter(a => a.runtime === id),
    }));

    return NextResponse.json({ runtimes });
  } catch (e: any) {
    const msg = typeof e === 'string' ? e : e?.message || 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
