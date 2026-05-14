// #1352 slice 3 — live smoke: simulate an inactive-everywhere assignee and
// verify the escalation ladder fires correctly across 3 ticks.
//
// Setup:
//   1. Pick a sandbox teammate (Mikey) and a sandbox task assigned to them.
//   2. Move task to in-progress, then backdate its lease and ALL of the
//      assignee's task lastActivityAt fields by 90 min — so the assignee
//      shows inactive everywhere (no proxy task within 60 min).
//   3. Reset the teammate's stale-claim fields to clean state.
//
// Then for each iteration:
//   - Trigger the scheduler.
//   - Backdate staleClaimCountedAt back to "yesterday + 1 min" so the
//     cooldown gate doesn't block the next strike (we're simulating
//     hours/days of incidents inside a single test run).
//   - Re-backdate the task's lease + lastActivityAt (the lease gets a
//     fresh 60-min stamp every time the task is touched/claimed).
//   - Read DB → assert Level N effects:
//       L1: staleClaimCount=1, comment with 'Level 1 (warn)', no loopDisabledAt
//       L2: staleClaimCount=2, comment with 'Level 2 (topic ping)', still in-progress
//       L3: staleClaimCount=3, loopDisabledAt set, task bounced to backlog
//
// All DB shape work funnels through provider.updateTask/addComment/updateSettings,
// so this also exercises the same write paths the sweep uses.

import pg from 'pg';
import fs from 'fs';

const envText = fs.readFileSync('.env.local', 'utf8');
const dbUrl = envText.match(/^DATABASE_URL=(.+)$/m)?.[1]?.replace(/^"|"$/g, '');
const apiKey = envText.match(/^ORG_STUDIO_API_KEY=(.+)$/m)?.[1]?.replace(/^"|"$/g, '');
const taskId = process.argv[2] || 'sumqsthqmp509cyi';
const assigneeName = process.argv[3] || 'Mikey';

const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
await client.connect();

async function readTask() {
  const r = await client.query(
    `SELECT status, assignee, data, last_activity_at FROM org_studio_tasks WHERE id=$1`,
    [taskId]
  );
  return r.rows[0];
}

async function readTeammate(name) {
  const r = await client.query(`SELECT data FROM org_studio_settings WHERE id='default'`);
  const teammates = r.rows[0]?.data?.teammates || [];
  return teammates.find(t => (t.name || '').toLowerCase() === name.toLowerCase());
}

async function readLatestStaleComment() {
  const r = await client.query(
    `SELECT id, content, created_at FROM org_studio_comments
      WHERE task_id=$1 AND id LIKE 'sys-stale-%'
      ORDER BY created_at DESC LIMIT 1`,
    [taskId]
  );
  return r.rows[0];
}

async function makeAssigneeInactive() {
  // Backdate lastActivityAt on EVERY task assigned to the assignee so
  // maxOtherTaskActivity() returns a time outside the 60-min window.
  const nintyMinAgo = Date.now() - 90 * 60 * 1000;
  await client.query(
    `UPDATE org_studio_tasks
       SET last_activity_at = $1::bigint,
           data = data || jsonb_build_object('lastActivityAt', $1::bigint)
     WHERE assignee = $2`,
    [nintyMinAgo, assigneeName]
  );
}

async function setupTask() {
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  const nintyMinAgo = Date.now() - 90 * 60 * 1000;
  await client.query(
    `UPDATE org_studio_tasks
       SET data = data || jsonb_build_object(
             'claim_lease_expires_at', $2::bigint,
             'lastActivityAt', $3::bigint
           ),
           last_activity_at = $3::bigint
     WHERE id = $1`,
    [taskId, fiveMinAgo, nintyMinAgo]
  );
}

async function resetCooldown() {
  // Move staleClaimCountedAt back by INCREMENT_COOLDOWN_MS + 1 min so
  // the next strike isn't gated. We DO want the count itself preserved
  // (so the ladder advances), and we want it within the 24h decay window
  // (so it doesn't reset to 0).
  const r = await client.query(`SELECT data FROM org_studio_settings WHERE id='default'`);
  const data = r.rows[0].data;
  const teammates = (data.teammates || []).map(tm => {
    if ((tm.name || '').toLowerCase() !== assigneeName.toLowerCase()) return tm;
    return { ...tm, staleClaimCountedAt: Date.now() - 61 * 60 * 1000 };
  });
  await client.query(
    `UPDATE org_studio_settings SET data = $1 WHERE id='default'`,
    [JSON.stringify({ ...data, teammates })]
  );
}

async function resetStaleFields() {
  const r = await client.query(`SELECT data FROM org_studio_settings WHERE id='default'`);
  const data = r.rows[0].data;
  const teammates = (data.teammates || []).map(tm => {
    if ((tm.name || '').toLowerCase() !== assigneeName.toLowerCase()) return tm;
    const { staleClaimCount, staleClaimCountedAt, loopDisabledAt, loopDisableReason, ...rest } = tm;
    return rest;
  });
  await client.query(
    `UPDATE org_studio_settings SET data = $1 WHERE id='default'`,
    [JSON.stringify({ ...data, teammates })]
  );
}

async function triggerScheduler() {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 5000);
  try {
    await fetch('http://localhost:4501/api/scheduler', {
      signal: ctrl.signal,
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'trigger', agentId: 'mikey', triggerSource: 'manual' }),
    });
  } catch {
    /* expected — dispatch streams, we only care about the sweep that runs first */
  }
}

console.log('\n=== #1352 slice 3 escalation ladder smoke ===\n');

// --- Ensure prerequisites ---
console.log('[setup] resetting teammate stale fields + cleaning task state...');
await resetStaleFields();
// Make sure task is in-progress assigned to Mikey
const initial = await readTask();
if (initial.status !== 'in-progress' || initial.assignee !== assigneeName) {
  // Bring it back to in-progress via API
  await fetch('http://localhost:4501/api/store', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'updateTask',
      id: taskId,
      updates: { status: 'in-progress', assignee: assigneeName },
      by: 'sim',
    }),
  });
  await new Promise(r => setTimeout(r, 500));
}

const results = [];

for (let level = 1; level <= 3; level++) {
  console.log(`\n--- Iteration ${level} (expect Level ${level}) ---`);
  await setupTask();
  await makeAssigneeInactive();
  if (level > 1) await resetCooldown();

  const before = await readTeammate(assigneeName);
  console.log(`  before: staleClaimCount=${before?.staleClaimCount || 0}`);

  await triggerScheduler();
  // give the sweep + provider writes a moment to land
  await new Promise(r => setTimeout(r, 1500));

  const after = await readTeammate(assigneeName);
  const task = await readTask();
  const comment = await readLatestStaleComment();

  console.log(`  after:  staleClaimCount=${after?.staleClaimCount}, loopDisabledAt=${after?.loopDisabledAt || '(unset)'}`);
  console.log(`          task.status=${task.status}, task.assignee=${JSON.stringify(task.assignee)}`);
  console.log(`          latest stale comment: ${comment?.content?.split('\n')[0] || '(none)'}`);

  const assertions = {
    L1: level === 1 && after?.staleClaimCount === 1 && !after?.loopDisabledAt && task.status === 'in-progress' && /Level 1/.test(comment?.content || ''),
    L2: level === 2 && after?.staleClaimCount === 2 && !after?.loopDisabledAt && task.status === 'in-progress' && /Level 2/.test(comment?.content || ''),
    L3: level === 3 && after?.staleClaimCount === 3 && !!after?.loopDisabledAt && task.status === 'backlog' && !task.assignee && /Level 3/.test(comment?.content || ''),
  };
  const passed = assertions.L1 || assertions.L2 || assertions.L3;
  console.log(`  ${passed ? '✅ PASS' : '❌ FAIL'} Level ${level}`);
  results.push({ level, passed });

  // For levels 1 & 2 the task stays in-progress; for level 3 it's bounced.
  // Restore in-progress before next iteration if level < 3.
  if (level < 3) {
    // For level 2 next, we need to re-touch the task (which extends lease)
    // — but our setupTask() overrides it, so this is OK.
  } else {
    console.log('\n[teardown] re-claiming bounced task for cleanup...');
    await fetch('http://localhost:4501/api/store', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'updateTask',
        id: taskId,
        updates: { status: 'in-progress', assignee: assigneeName },
        by: 'sim',
      }),
    });
  }
}

console.log('\n=== Summary ===');
for (const r of results) console.log(`  Level ${r.level}: ${r.passed ? '✅ PASS' : '❌ FAIL'}`);

console.log('\n[teardown] clearing loopDisabledAt + stale fields on Mikey...');
await resetStaleFields();

await client.end();
const allOk = results.every(r => r.passed);
process.exit(allOk ? 0 : 1);
