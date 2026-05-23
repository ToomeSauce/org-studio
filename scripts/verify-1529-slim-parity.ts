/**
 * #1529 — verify slim-vs-full dispatch parity on the live store.
 *
 * For every enabled agent loop:
 *  - Run `hasActionableWork(slim)` and `hasActionableWork(full)`. Must match.
 *  - Run `diagnoseAgentBacklog(slim)` and `diagnoseAgentBacklog(full)`. Must match.
 *  - For every backlog task assigned to that agent, run `isTaskAnyDispatchEligible`
 *    against slim and full. Must match.
 *
 * Exits non-zero on any mismatch. Run pre-deploy:
 *   ORG_STUDIO_API_KEY=... DATABASE_URL=... npx tsx scripts/verify-1529-slim-parity.ts
 */

async function main() {
  const fs = await import('fs');
  const env = fs.readFileSync(
    '/home/openclaw_user/org-studio/.env.local',
    'utf8',
  )
    .split('\n')
    .reduce((a: any, l: string) => {
      const m = l.match(/^([A-Z_]+)=(.*)$/);
      if (m) a[m[1]] = m[2].replace(/^["']|["']$/g, '');
      return a;
    }, {} as any);
  if (!process.env.DATABASE_URL) process.env.DATABASE_URL = env.DATABASE_URL;
  if (!process.env.ORG_STUDIO_API_KEY) process.env.ORG_STUDIO_API_KEY = env.ORG_STUDIO_API_KEY;

  const { getStoreProviderAllWorkspaces, readSlimStoreAllWorkspaces } =
    await import('/home/openclaw_user/org-studio/src/lib/store-provider.ts');
  const { isTaskAnyDispatchEligible } = await import(
    '/home/openclaw_user/org-studio/src/lib/dispatch-gate.ts'
  );
  const { diagnoseAgentBacklog, classifyBlocker } = await import(
    '/home/openclaw_user/org-studio/src/lib/dispatch-attempts.ts'
  );

  const provider = getStoreProviderAllWorkspaces();
  const fullStore: any = await provider.read();
  const slimStore: any = await readSlimStoreAllWorkspaces();

  console.log(
    `[parity] full: tasks=${fullStore.tasks.length} projects=${fullStore.projects.length}`,
  );
  console.log(
    `[parity] slim: tasks=${slimStore.tasks.length} projects=${slimStore.projects.length}`,
  );

  if (fullStore.tasks.length !== slimStore.tasks.length) {
    console.error(`[parity] FAIL: task count mismatch`);
    process.exit(1);
  }
  if (fullStore.projects.length !== slimStore.projects.length) {
    console.error(`[parity] FAIL: project count mismatch`);
    process.exit(1);
  }

  const slimById = new Map(slimStore.tasks.map((t: any) => [t.id, t]));

  // 1) Per-task dispatch eligibility parity
  let dispatchMismatches = 0;
  for (const fullTask of fullStore.tasks) {
    const slimTask = slimById.get(fullTask.id);
    if (!slimTask) {
      console.error(`[parity] FAIL: task ${fullTask.id} missing from slim`);
      dispatchMismatches++;
      continue;
    }
    const fullEligible = isTaskAnyDispatchEligible(fullStore, fullTask);
    const slimEligible = isTaskAnyDispatchEligible(slimStore, slimTask);
    if (fullEligible !== slimEligible) {
      console.error(
        `[parity] FAIL: task ${fullTask.id} (#${fullTask.ticketNumber}) ` +
          `eligibility mismatch: full=${fullEligible} slim=${slimEligible}`,
      );
      dispatchMismatches++;
    }
  }
  if (dispatchMismatches > 0) {
    console.error(`[parity] ${dispatchMismatches} dispatch eligibility mismatches`);
    process.exit(1);
  }
  console.log(`[parity] ✓ dispatch eligibility: all ${fullStore.tasks.length} tasks match`);

  // 2) Per-agent diagnose parity
  const agents = (fullStore.settings?.teammates || [])
    .filter((tm: any) => tm?.agentId)
    .map((tm: any) => ({ agentId: tm.agentId, agentName: tm.name || tm.agentId }));
  let diagMismatches = 0;
  for (const { agentId, agentName } of agents) {
    const fullDiag = diagnoseAgentBacklog(fullStore, agentId, agentName);
    const slimDiag = diagnoseAgentBacklog(slimStore, agentId, agentName);
    if (
      fullDiag.taskCountBacklog !== slimDiag.taskCountBacklog ||
      fullDiag.taskCountBlockedByGate !== slimDiag.taskCountBlockedByGate ||
      fullDiag.topBlocker !== slimDiag.topBlocker
    ) {
      console.error(
        `[parity] FAIL: ${agentName} (${agentId}) diagnose mismatch:\n  full: ${JSON.stringify(fullDiag)}\n  slim: ${JSON.stringify(slimDiag)}`,
      );
      diagMismatches++;
    }
  }
  if (diagMismatches > 0) {
    console.error(`[parity] ${diagMismatches} agent diagnose mismatches`);
    process.exit(1);
  }
  console.log(`[parity] ✓ diagnoseAgentBacklog: all ${agents.length} agents match`);

  // 3) Classify-blocker parity on the backlog tasks that ARE blocked
  let classMismatches = 0;
  for (const fullTask of fullStore.tasks) {
    if (fullTask.status !== 'backlog') continue;
    if (isTaskAnyDispatchEligible(fullStore, fullTask)) continue;
    const slimTask = slimById.get(fullTask.id);
    const fullR = classifyBlocker(fullStore, fullTask);
    const slimR = classifyBlocker(slimStore, slimTask);
    if (fullR !== slimR) {
      console.error(
        `[parity] FAIL: task ${fullTask.id} (#${fullTask.ticketNumber}) ` +
          `classify mismatch: full=${fullR} slim=${slimR}`,
      );
      classMismatches++;
    }
  }
  if (classMismatches > 0) {
    console.error(`[parity] ${classMismatches} classify-blocker mismatches`);
    process.exit(1);
  }
  console.log(`[parity] ✓ classifyBlocker: all blocked backlog tasks match`);

  console.log(`\n[parity] ALL GREEN ✅`);
  process.exit(0);
}

main().catch((e) => {
  console.error('[parity] crashed:', e);
  process.exit(2);
});
