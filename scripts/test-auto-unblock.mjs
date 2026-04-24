#!/usr/bin/env node
// #1102 integration test: auto-unblock fan-out on blocker completion.
//
// Uses the Org Studio proj-mikey-sandbox-like project? No — uses the real
// Org Studio API but creates throwaway tasks under proj-org-studio, cleans up
// after. If the project doesn't accept adhoc without roadmap, we fall back
// to any project we can write to.

const BEARER = 'Bearer 8ce80b4d1379aed97fcd4d75c4a53562';
const H = { 'Content-Type': 'application/json', 'Authorization': BEARER };

async function api(action, extra = {}) {
  const res = await fetch('http://localhost:4501/api/store', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ action, ...extra }),
  });
  return res.json();
}

async function getStore() {
  const res = await fetch('http://localhost:4501/api/store');
  return res.json();
}

const log = (...a) => console.log(...a);
let exitCode = 0;
const assert = (cond, label) => { log(cond ? '✅' : '❌', label); if (!cond) exitCode = 1; };

(async () => {
  // --- Seed: create 2 blocker tasks + 1 blocked task ---
  const mkTask = async (title, extras = {}) => {
    const r = await api('addTask', {
      task: {
        projectId: 'proj-org-studio',
        title,
        description: '[#1102 test] auto-unblock integration test — safe to delete',
        status: 'backlog',
        assignee: 'Mikey',
        priority: 'low',
        taskType: 'chore',
        ...extras,
      },
    });
    if (!r.ok) { log('seed failed:', r); process.exit(2); }
    return r.task;
  };

  log('\n--- Seeding ---');
  const blockerA = await mkTask('#1102-test blocker A');
  const blockerB = await mkTask('#1102-test blocker B');
  const downstream = await mkTask('#1102-test downstream (auto-unblock target)', {
    status: 'blocked',
    blockedBy: [blockerA.ticketNumber, blockerB.ticketNumber],
  });
  log(`  blockerA = #${blockerA.ticketNumber} (${blockerA.id})`);
  log(`  blockerB = #${blockerB.ticketNumber} (${blockerB.id})`);
  log(`  downstream = #${downstream.ticketNumber} (${downstream.id}) blockedBy=[${blockerA.ticketNumber},${blockerB.ticketNumber}]`);

  // Sanity: downstream has blockedBy in the store
  const s0 = await getStore();
  const d0 = s0.tasks.find(t => t.id === downstream.id);
  assert(Array.isArray(d0.blockedBy) && d0.blockedBy.length === 2, 'downstream.blockedBy survived round-trip');

  // --- Phase 1: complete blockerA — downstream should STAY blocked (blockerB still open) ---
  log('\n--- Phase 1: complete blockerA only ---');
  await api('updateTask', { id: blockerA.id, updates: { status: 'done' } });
  await new Promise(r => setTimeout(r, 500));
  const s1 = await getStore();
  const d1 = s1.tasks.find(t => t.id === downstream.id);
  assert(d1.status === 'blocked', 'downstream still blocked with 1 of 2 blockers open');
  assert(d1.blockedBy.length === 2, 'blockedBy not cleared prematurely');

  // --- Phase 2: complete blockerB — downstream should flip to backlog ---
  log('\n--- Phase 2: complete blockerB (final blocker) ---');
  await api('updateTask', { id: blockerB.id, updates: { status: 'done' } });
  await new Promise(r => setTimeout(r, 800)); // allow async updates + comment write
  const s2 = await getStore();
  const d2 = s2.tasks.find(t => t.id === downstream.id);
  assert(d2.status === 'backlog', 'downstream auto-flipped to backlog');
  assert(Array.isArray(d2.blockedBy) && d2.blockedBy.length === 0, 'blockedBy cleared on unblock');
  assert(
    Array.isArray(d2.previouslyBlockedBy) &&
    d2.previouslyBlockedBy.includes(blockerA.ticketNumber) &&
    d2.previouslyBlockedBy.includes(blockerB.ticketNumber),
    'previouslyBlockedBy populated with audit trail'
  );
  const sysComment = (d2.comments || []).find(c => c.author === 'System' && /Auto-unblocked/.test(c.content));
  assert(!!sysComment, 'System comment posted with "Auto-unblocked" marker');
  if (sysComment) {
    assert(sysComment.content.includes(`#${blockerA.ticketNumber}`), 'comment mentions blockerA');
    assert(sysComment.content.includes(`#${blockerB.ticketNumber}`), 'comment mentions blockerB');
  }

  // --- Phase 3: negative — a blocked task with NO blockedBy stays blocked ---
  log('\n--- Phase 3: negative (blocked w/o blockedBy stays blocked) ---');
  const blockerC = await mkTask('#1102-test blocker C');
  const orphanBlocked = await mkTask('#1102-test orphan blocked (no blockedBy)', { status: 'blocked' });
  await api('updateTask', { id: blockerC.id, updates: { status: 'done' } });
  await new Promise(r => setTimeout(r, 400));
  const s3 = await getStore();
  const orphan3 = s3.tasks.find(t => t.id === orphanBlocked.id);
  assert(orphan3.status === 'blocked', 'blocked task with empty blockedBy stays blocked (manual-only)');

  // --- Cleanup: archive the test tasks so they don't pollute the board ---
  log('\n--- Cleanup ---');
  for (const id of [blockerA.id, blockerB.id, blockerC.id, downstream.id, orphanBlocked.id]) {
    await api('updateTask', { id, updates: { isArchived: true, archivedAt: Date.now(), archivedBy: 'Mikey (1102 test cleanup)' } });
  }
  log('  archived all test tasks');

  log(`\n${exitCode === 0 ? 'ALL GREEN ✅' : 'FAILURES ❌'}`);
  process.exit(exitCode);
})();
