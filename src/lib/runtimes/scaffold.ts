/**
 * Agent scaffolding — the store-mutating side-effects that used to live in
 * GET /api/runtimes (#1623 / #1610 F-P3).
 *
 * A GET must never mutate state (it was CSRF-able and unauthenticated). The
 * persist-new-teammates / auto-create-loop / clear-loopDisabledAt logic is
 * moved here verbatim and is now invoked only from the AUTHENTICATED
 * POST /api/runtimes path. GET stays read-only.
 *
 * This is the single source of truth for that logic — do not re-inline it into
 * the route.
 */
import type { RuntimeAgent } from './types';
import { getStoreProvider } from '@/lib/store-provider';

const DEFAULT_AGENT_COLORS = ['cyan', 'emerald', 'purple', 'blue', 'pink', 'orange'];

export interface ScaffoldResult {
  newAgents: string[];
  loopsCreated: number;
  loopReenabled: string[];
}

/**
 * Persist any newly-discovered agents into the teammate store, auto-create a
 * default scheduler loop for each, and clear loopDisabledAt on any previously
 * loop-disabled agent that has re-appeared in discovery (the #1352
 * "re-discovery = give it another chance" behavior).
 *
 * Best-effort: never throws — returns a summary, logs on failure. Callers
 * (the POST route) must not let a scaffold failure break the response.
 */
export async function scaffoldDiscoveredAgents(
  workspaceId: string,
  allAgents: RuntimeAgent[],
): Promise<ScaffoldResult> {
  const result: ScaffoldResult = { newAgents: [], loopsCreated: 0, loopReenabled: [] };
  try {
    const store = await getStoreProvider(workspaceId).read();
    const teammates = store?.settings?.teammates || [];
    const existingAgentIds = new Set(
      teammates.filter((t: any) => t.agentId).map((t: any) => t.agentId),
    );

    const newAgents = allAgents.filter((a) => !existingAgentIds.has(a.id));
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
          const maxOffset = updatedLoops.reduce(
            (max: number, l: any) => Math.max(max, l.startOffsetMinutes || 0),
            0,
          );
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

      await getStoreProvider(workspaceId).updateSettings({
        teammates: updatedTeammates,
        loops: updatedLoops,
      });
      result.newAgents = newAgents.map((a) => a.id);
      result.loopsCreated = loopsCreated;
      console.log(
        `[Runtimes] Auto-scaffolded ${newAgents.length} new agent(s): ${result.newAgents.join(', ')}` +
          (loopsCreated ? ` (${loopsCreated} loop(s) created)` : ''),
      );
    }

    // #1352 slice 4 — Auto-clear loopDisabledAt on agent re-discovery.
    // The escalation ladder's Level-3 punishment is meant to be reversible:
    // 'Level-3 loop-disable reversible by human OR agent on next start'. When a
    // previously-disabled agent re-appears in discovery, interpret that as
    // 'agent is back, give it another chance'. Clear loopDisabledAt +
    // loopDisableReason and reset staleClaimCount to 0 so the ladder restarts.
    //
    // Re-fetch teammates from the store rather than reusing the closure var,
    // because the scaffold block above just persisted it; reusing the closure
    // would re-apply the wipe even after another writer touched teammates.
    try {
      const discoveredIds = new Set(allAgents.map((a) => a.id.toLowerCase()));
      const freshStore = await getStoreProvider(workspaceId).read();
      const freshTeammates = freshStore?.settings?.teammates || [];
      let clearedCount = 0;
      const clearedIds: string[] = [];
      const cleared = freshTeammates.map((tm: any) => {
        if (!tm.loopDisabledAt) return tm;
        if (!discoveredIds.has((tm.agentId || '').toLowerCase())) return tm;
        clearedCount++;
        clearedIds.push(tm.agentId || tm.id);
        const { loopDisabledAt, loopDisableReason, staleClaimCount, staleClaimCountedAt, ...rest } = tm;
        return rest;
      });
      if (clearedCount > 0) {
        await getStoreProvider(workspaceId).updateSettings({ teammates: cleared });
        result.loopReenabled = clearedIds;
        console.log(`[Runtimes #1352] Auto-cleared loopDisabledAt on ${clearedCount} re-discovered agent(s)`);
      }
    } catch (clearErr) {
      console.warn('[Runtimes #1352] Auto-clear loopDisabledAt failed:', (clearErr as any)?.message);
    }
  } catch (scaffoldErr) {
    // Best-effort — never break the caller.
    console.warn('[Runtimes] Auto-scaffold failed:', (scaffoldErr as any)?.message);
  }
  return result;
}
