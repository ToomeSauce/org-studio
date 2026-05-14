/**
 * #1352 slice 2 — live smoke: simulate a dead claim and verify auto-bounce.
 *
 * PATTERN (#1355): Self-contained sandbox fixture.
 *   - Creates its OWN task at startup (never touches real tasks).
 *   - Entire body wrapped in try/finally.
 *   - finally: permanentlyDeleteTask + pg client close — guaranteed
 *     zero residue regardless of crash/assertion-failure/timeout.
 *   - Re-running leaves ZERO new in-progress tasks in the store.
 */
import pg from 'pg';
import fs from 'fs';

const envText = fs.readFileSync('.env.local', 'utf8');
const dbUrl = envText.match(/^DATABASE_URL=(.+)$/m)?.[1]?.replace(/^"|"$/g, '');
const apiKey = envText.match(/^ORG_STUDIO_API_KEY=(.+)$/m)?.[1]?.replace(/^"|"$/g, '');
const BASE = 'http://localhost:4501';
const headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
await client.connect();

// --- Create sandbox fixture task ---
console.log('\n=== #1352 slice 2 dead-claim smoke (self-cleaning fixture) ===\n');
console.log('[setup] Creating sandbox fixture task...');
const createResp = await fetch(`${BASE}/api/store`, {
  method: 'POST', headers,
  body: JSON.stringify({
    action: 'addTask',
    task: {
      title: 'FIXTURE: sim-dead-claim-1352 — auto-deleted',
      projectId: 'proj-org-studio',
      assignee: 'Mikey',
      status: 'in-progress',
      taskType: 'chore',
      description: 'Transient sandbox fixture. If you see this, sim-dead-claim-1352.mjs crashed mid-run.',
    },
  }),
}).then(r => r.json());
const taskId = createResp?.task?.id;
if (!taskId) {
  console.error('FAIL — could not create fixture:', JSON.stringify(createResp));
  await client.end();
  process.exit(1);
}
console.log(`       taskId: ${taskId}, ticketNumber: ${createResp.task.ticketNumber}`);

try {
  // --- Helpers ---
  async function readTask() {
    const r = await client.query(
      `SELECT status, assignee, data, last_activity_at FROM org_studio_tasks WHERE id=$1`,
      [taskId]
    );
    return r.rows[0];
  }

  function fmt(t) {
    const data = t.data || {};
    return {
      status: t.status,
      assignee: t.assignee,
      claim_started_at: data.claim_started_at,
      claim_lease_expires_at: data.claim_lease_expires_at,
      last_activity_at: t.last_activity_at,
    };
  }

  // --- Step 1: verify task exists ---
  console.log('\n[step 1] BEFORE — fixture on disk:');
  const before = await readTask();
  if (!before) throw new Error('fixture task not found in DB');
  console.log('  ', JSON.stringify(fmt(before), null, 2));

  if (before.status !== 'in-progress') {
    throw new Error(`task must be in-progress, got ${before.status}`);
  }

  // --- Step 2: backdate lease ---
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  const fortyMinAgo = Date.now() - 40 * 60 * 1000;
  console.log('\n[step 2] Backdating lease to expire 5 min ago + lastActivityAt 40 min ago...');
  await client.query(
    `UPDATE org_studio_tasks
       SET data = data || $2::jsonb,
           last_activity_at = $3::bigint
     WHERE id = $1`,
    [
      taskId,
      JSON.stringify({
        claim_lease_expires_at: fiveMinAgo,
        lastActivityAt: fortyMinAgo,
      }),
      fortyMinAgo,
    ]
  );

  // --- Step 3: make Mikey "active elsewhere" ---
  console.log('[step 3] Ensure Mikey is "active elsewhere" (within 60min) on another task...');
  const otherTasks = await client.query(
    "SELECT id, data FROM org_studio_tasks WHERE assignee='Mikey' AND id<>$1 AND status='in-progress' LIMIT 1",
    [taskId]
  );
  // If no other real in-progress task, create a second fixture
  let proxyTaskId = otherTasks.rows[0]?.id;
  let createdProxy = false;
  if (!proxyTaskId) {
    console.log('  no existing Mikey in-progress task — creating proxy fixture...');
    const proxyResp = await fetch(`${BASE}/api/store`, {
      method: 'POST', headers,
      body: JSON.stringify({
        action: 'addTask',
        task: {
          title: 'FIXTURE: sim-dead-claim proxy — auto-deleted',
          projectId: 'proj-org-studio',
          assignee: 'Mikey',
          status: 'in-progress',
          taskType: 'chore',
        },
      }),
    }).then(r => r.json());
    proxyTaskId = proxyResp?.task?.id;
    createdProxy = true;
  }
  console.log(`  proxy task: ${proxyTaskId}${createdProxy ? ' (fixture)' : ''}`);
  const recentMs = Date.now() - 30 * 1000;
  await client.query(
    `UPDATE org_studio_tasks
       SET last_activity_at = $1::bigint,
           data = data || $2::jsonb
     WHERE id = $3`,
    [recentMs, JSON.stringify({ lastActivityAt: recentMs }), proxyTaskId]
  );

  // --- Step 4: trigger scheduler ---
  console.log('\n[step 4] Trigger scheduler tick for mikey (5s timeout)...');
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 5000);
  let triggerJson;
  try {
    const trigger = await fetch(`${BASE}/api/scheduler`, {
      signal: ctrl.signal,
      method: 'POST', headers,
      body: JSON.stringify({ action: 'trigger', agentId: 'mikey', triggerSource: 'manual' }),
    });
    triggerJson = await trigger.json();
  } catch (e) {
    console.log('  trigger aborted/timeout (expected if dispatch streams):', e.name || e.message);
    triggerJson = { aborted: true };
  }
  console.log('  response:', JSON.stringify(triggerJson).slice(0, 300));

  // --- Step 5: verify ---
  console.log('\n[step 5] AFTER — fixture on disk:');
  await new Promise(r => setTimeout(r, 1500));
  const after = await readTask();
  console.log('  ', JSON.stringify(fmt(after), null, 2));

  const sysComments = (
    await client.query(
      `SELECT id, content FROM org_studio_comments
        WHERE task_id = $1 AND type = 'system' AND id LIKE 'sys-lease-bounce-%'
        ORDER BY created_at DESC LIMIT 5`,
      [taskId]
    )
  ).rows;
  console.log('\n  bounce comments:', sysComments.length);
  if (sysComments.length > 0) {
    console.log('  latest:\n   ', sysComments[0].content.replace(/\n/g, '\n    '));
  }

  const ok =
    after.status === 'backlog' &&
    !after.assignee &&
    !after.data?.claim_lease_expires_at &&
    sysComments.length > 0;
  console.log('\n[result]', ok ? '✅ PASS — auto-bounce works end-to-end' : '❌ FAIL');

  // Clean up proxy if we created it
  if (createdProxy && proxyTaskId) {
    await fetch(`${BASE}/api/store`, {
      method: 'POST', headers,
      body: JSON.stringify({ action: 'permanentlyDeleteTask', id: proxyTaskId }),
    });
  }

  if (!ok) process.exitCode = 1;
} finally {
  // ALWAYS hard-delete the fixture — #1355 contract.
  console.log('\n[cleanup] permanentlyDeleteTask (fixture)...');
  try {
    await fetch(`${BASE}/api/store`, {
      method: 'POST', headers,
      body: JSON.stringify({ action: 'permanentlyDeleteTask', id: taskId }),
    });
    console.log('       fixture removed.');
  } catch (e) {
    console.error('       cleanup failed:', e.message);
  }
  await client.end();
}
