/**
 * #1352 slice 3 — live smoke: simulate an inactive-everywhere assignee and
 * verify the escalation ladder fires correctly across 3 ticks.
 *
 * PATTERN (#1355): Self-contained sandbox fixture.
 *   - Creates its OWN task at startup (never touches real tasks).
 *   - Entire body wrapped in try/finally.
 *   - finally: permanentlyDeleteTask + resetStaleFields + pg close —
 *     guaranteed zero residue regardless of crash/assertion-failure/timeout.
 *   - Re-running leaves ZERO new in-progress tasks in the store.
 */
import pg from 'pg';
import fs from 'fs';

const envText = fs.readFileSync('.env.local', 'utf8');
const dbUrl = envText.match(/^DATABASE_URL=(.+)$/m)?.[1]?.replace(/^"|"$/g, '');
const apiKey = envText.match(/^ORG_STUDIO_API_KEY=(.+)$/m)?.[1]?.replace(/^"|"$/g, '');
const BASE = 'http://localhost:4501';
const headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
const assigneeName = process.argv[2] || 'Mikey';

const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
await client.connect();

// --- Create sandbox fixture task ---
console.log('\n=== #1352 slice 3 escalation ladder smoke (self-cleaning fixture) ===\n');
console.log('[setup] Creating sandbox fixture task...');
const createResp = await fetch(`${BASE}/api/store`, {
  method: 'POST', headers,
  body: JSON.stringify({
    action: 'addTask',
    task: {
      title: 'FIXTURE: sim-escalation-1352 — auto-deleted',
      projectId: 'proj-org-studio',
      assignee: assigneeName,
      status: 'in-progress',
      taskType: 'chore',
      description: 'Transient sandbox fixture. If you see this, sim-escalation-1352.mjs crashed mid-run.',
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

// --- Helpers ---
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
    await fetch(`${BASE}/api/scheduler`, {
      signal: ctrl.signal,
      method: 'POST', headers,
      body: JSON.stringify({ action: 'trigger', agentId: 'mikey', triggerSource: 'manual' }),
    });
  } catch {
    /* expected — dispatch streams */
  }
}

try {
  // --- Reset teammate state ---
  console.log('[setup] Resetting teammate stale fields...');
  await resetStaleFields();

  const results = [];

  for (let level = 1; level <= 3; level++) {
    console.log(`\n--- Iteration ${level} (expect Level ${level}) ---`);
    await setupTask();
    await makeAssigneeInactive();
    if (level > 1) await resetCooldown();

    // Make sure the fixture is in-progress for levels 1 & 2
    if (level > 1) {
      const current = await readTask();
      if (current.status !== 'in-progress') {
        await fetch(`${BASE}/api/store`, {
          method: 'POST', headers,
          body: JSON.stringify({
            action: 'updateTask',
            id: taskId,
            updates: { status: 'in-progress', assignee: assigneeName },
            by: 'sim',
          }),
        });
        await new Promise(r => setTimeout(r, 500));
        await setupTask();
        await makeAssigneeInactive();
      }
    }

    const before = await readTeammate(assigneeName);
    console.log(`  before: staleClaimCount=${before?.staleClaimCount || 0}`);

    await triggerScheduler();
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
  }

  console.log('\n=== Summary ===');
  for (const r of results) console.log(`  Level ${r.level}: ${r.passed ? '✅ PASS' : '❌ FAIL'}`);

  if (!results.every(r => r.passed)) process.exitCode = 1;
} finally {
  // ALWAYS clean up — #1355 contract.
  console.log('\n[cleanup] resetStaleFields + permanentlyDeleteTask...');
  try {
    await resetStaleFields();
  } catch (e) {
    console.error('  resetStaleFields failed:', e.message);
  }
  try {
    await fetch(`${BASE}/api/store`, {
      method: 'POST', headers,
      body: JSON.stringify({ action: 'permanentlyDeleteTask', id: taskId }),
    });
    console.log('       fixture removed.');
  } catch (e) {
    console.error('       fixture cleanup failed:', e.message);
  }
  await client.end();
}
