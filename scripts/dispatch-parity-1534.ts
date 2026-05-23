/**
 * #1534 parity verifier — dispatch-prompt byte-identity check between the
 * pre-#1534 full-read path and the post-#1534 slim+per-agent path.
 *
 * For every enabled agent loop in settings.loops, build the dispatch
 * message TWO ways:
 *   (A) via full readStore()        ← pre-#1534 baseline
 *   (B) via readSlim() + getTasksForAgent(name, id) + merge ← post-#1534
 *
 * Then byte-compare A vs B. Any mismatch is a regression and aborts with
 * exit code 1 and a unified diff to stderr. Exit 0 = "ship it."
 *
 * # Usage
 *
 *   tsx scripts/dispatch-parity-1534.ts                # all enabled loops
 *   tsx scripts/dispatch-parity-1534.ts mikey ana      # specific agents
 *
 * # Why this script exists
 *
 * The ticket's doneWhen requires byte-identical dispatch prompts before
 * shipping. buildDispatchMessage walks store.projects, store.tasks
 * (filtered to agent), and dispatch-gate cross-agent signal. The merge
 * step keeps cross-agent slim and per-agent full; this verifier catches
 * any shape drift between slim and full rows that would change the
 * rendered prompt (e.g. a numeric field arriving as string from one
 * path and Number from the other).
 *
 * The verifier ALSO measures wall-clock per-path so we can confirm the
 * ~5x speedup claim. Output format is two lines per agent:
 *
 *   mikey:  full=612ms  slim=94ms  bytes=4218  PARITY OK
 *   ana:    full=587ms  slim=88ms  bytes=3902  PARITY OK
 *
 * # Reversibility
 *
 * Pure verifier — does no writes, mutates no state. Safe to run against
 * production at any time.
 */

import { buildDispatchMessage } from '../src/lib/scheduler';
import { getStoreProviderAllWorkspaces, type StoreData } from '../src/lib/store-provider';

type AgentLoop = { agentId: string; agentName?: string; enabled?: boolean };

function unifiedDiff(a: string, b: string): string {
  const la = a.split('\n');
  const lb = b.split('\n');
  const out: string[] = [];
  const max = Math.max(la.length, lb.length);
  for (let i = 0; i < max; i++) {
    if (la[i] !== lb[i]) {
      out.push(`@ line ${i + 1}`);
      if (la[i] != null) out.push(`- ${la[i]}`);
      if (lb[i] != null) out.push(`+ ${lb[i]}`);
    }
  }
  return out.length === 0 ? '(no diff)' : out.slice(0, 80).join('\n');
}

function getAgentName(store: StoreData, agentId: string): string {
  const teammates = (store as any).settings?.teammates || [];
  const m = teammates.find((t: any) => t.agentId === agentId);
  return m?.name || agentId;
}

function getAgentRole(store: StoreData, agentId: string): string | undefined {
  const teammates = (store as any).settings?.teammates || [];
  return teammates.find((t: any) => t.agentId === agentId)?.role;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const provider = getStoreProviderAllWorkspaces() as any;

  // Bootstrap read (full) to discover enabled loops.
  const bootstrap = (await provider.read()) as StoreData;
  const allLoops: AgentLoop[] = (bootstrap as any).settings?.loops || [];
  const enabled = allLoops.filter((l) => l.enabled !== false);
  const targets = argv.length > 0 ? enabled.filter((l) => argv.includes(l.agentId)) : enabled;

  if (targets.length === 0) {
    console.error('No enabled loops to verify.');
    process.exit(1);
  }

  let failures = 0;

  for (const loop of targets) {
    // --- PATH A: full readStore() ---
    const ta = Date.now();
    const fullStore = (await provider.read()) as StoreData;
    const fullMs = Date.now() - ta;
    const nameA = getAgentName(fullStore, loop.agentId);
    const roleA = getAgentRole(fullStore, loop.agentId);
    const promptA = await buildDispatchMessage(fullStore, loop.agentId, nameA, roleA);

    // --- PATH B: slim + getTasksForAgent + merge ---
    const tb = Date.now();
    const slim = (await provider.readSlim()) as StoreData;
    const nameB = getAgentName(slim, loop.agentId);
    const roleB = getAgentRole(slim, loop.agentId);
    const fullAgentTasks: any[] = await provider.getTasksForAgent(nameB, loop.agentId);
    const fullById = new Map(fullAgentTasks.map((t: any) => [t.id, t]));
    const mergedTasks = (slim.tasks || []).map((t: any) => (fullById.has(t.id) ? fullById.get(t.id) : t));
    const mergedStore: StoreData = { ...slim, tasks: mergedTasks };
    const slimMs = Date.now() - tb;
    const promptB = await buildDispatchMessage(mergedStore, loop.agentId, nameB, roleB);

    const a = promptA ?? '';
    const b = promptB ?? '';
    const matched = a === b;
    const bytes = a.length;
    const label = `${loop.agentId.padEnd(10)} full=${String(fullMs).padStart(4)}ms  slim=${String(slimMs).padStart(4)}ms  bytes=${bytes}`;
    if (matched) {
      console.log(`${label}  PARITY OK`);
    } else {
      failures++;
      console.error(`${label}  PARITY MISMATCH`);
      console.error(unifiedDiff(a, b));
      console.error('---');
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} agent(s) failed parity.`);
    process.exit(1);
  }
  console.log(`\nAll ${targets.length} agent(s) PARITY OK.`);
}

main().catch((err) => {
  console.error('Verifier crashed:', err);
  process.exit(2);
});
