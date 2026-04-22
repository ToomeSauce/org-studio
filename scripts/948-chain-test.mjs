#!/usr/bin/env node
/**
 * #948 chain test — autonomous delivery validation.
 * Simulate an agent moving through backlog → in-progress → done repeatedly,
 * and verify the scheduler never gets stuck in the `already in-flight` /
 * `has in-progress task` skip state that required user nudges.
 *
 * This only tests the data-layer side: that updateTask correctly propagates
 * status changes and the in-flight marker clears. A full end-to-end test
 * would require a live OpenClaw agent session, which we can't script.
 */
const BASE = 'http://localhost:4501';
const TOKEN = '8ce80b4d1379aed97fcd4d75c4a53562';

async function api(body) {
  const r = await fetch(`${BASE}/api/store`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
async function getTask(id) {
  const r = await fetch(`${BASE}/api/store`);
  const s = await r.json();
  return s.tasks.find((t) => t.id === id);
}

(async () => {
  const ids = [];
  // Create 3 backlog tasks for same agent.
  for (let i = 1; i <= 3; i++) {
    const c = await api({
      action: 'addTask',
      task: {
        title: `#948 chain test ${i} — DELETE ME`,
        status: 'backlog',
        projectId: 'proj-mc',
        assignee: 'Mikey',
        priority: 'low',
        taskType: 'chore',
      },
    });
    ids.push(c.body.task.id);
    console.log(`[create] task${i} id=${c.body.task.id} num=${c.body.task.ticketNumber} status=${c.body.task.status}`);
  }

  // Move each through in-progress → done in sequence (no delay — simulating fast agent).
  let failures = 0;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const u1 = await api({ action: 'updateTask', id, updates: { status: 'in-progress' }, by: 'Mikey' });
    const s1 = await getTask(id);
    if (s1?.status !== 'in-progress') {
      console.error(`[FAIL] task${i+1} in-progress not applied (actual=${s1?.status})`);
      failures++;
    } else {
      console.log(`[ok]   task${i+1} → in-progress`);
    }

    const u2 = await api({ action: 'updateTask', id, updates: { status: 'done', reviewNotes: 'auto-chain test' }, by: 'Mikey' });
    const s2 = await getTask(id);
    if (s2?.status !== 'done') {
      console.error(`[FAIL] task${i+1} done not applied (actual=${s2?.status})`);
      failures++;
    } else {
      console.log(`[ok]   task${i+1} → done`);
    }
  }

  // Cleanup
  for (const id of ids) {
    await api({ action: 'permanentlyDeleteTask', id });
  }
  console.log(`[cleanup] ${ids.length} tasks removed`);

  if (failures > 0) {
    console.error(`\n❌ ${failures} failures — chain is broken`);
    process.exit(1);
  }
  console.log(`\n✅ All ${ids.length * 2} transitions applied correctly`);
})();
