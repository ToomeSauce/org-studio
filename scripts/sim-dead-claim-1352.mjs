// #1352 slice 2 — live smoke: simulate a dead claim and verify auto-bounce.
import pg from 'pg';
import fs from 'fs';

const envText = fs.readFileSync('.env.local', 'utf8');
const dbUrl = envText.match(/^DATABASE_URL=(.+)$/m)?.[1]?.replace(/^"|"$/g, '');
const apiKey = envText.match(/^ORG_STUDIO_API_KEY=(.+)$/m)?.[1]?.replace(/^"|"$/g, '');
const taskId = process.argv[2] || 'sumqsthqmp509cyi';

const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
await client.connect();

async function readTask() {
  // status/assignee are top-level columns; claim_* live in the data JSONB blob
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

console.log('\n[step 1] BEFORE — task on disk:');
const before = await readTask();
console.log('  ', JSON.stringify(fmt(before), null, 2));

if (before.status !== 'in-progress') {
  console.error('  → task must be in-progress before sim; aborting');
  await client.end();
  process.exit(1);
}

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

console.log('[step 3] Ensure Mikey is "active elsewhere" (within 60min) on another task...');
const otherTasks = await client.query(
  "SELECT id, data FROM org_studio_tasks WHERE assignee='Mikey' AND id<>$1 LIMIT 1",
  [taskId]
);
if (otherTasks.rows.length === 0) {
  console.error('  → no other Mikey task; aborting');
  await client.end();
  process.exit(1);
}
const otherId = otherTasks.rows[0].id;
console.log(`  proxy task: ${otherId}`);
const recentMs = Date.now() - 30 * 1000;
await client.query(
  `UPDATE org_studio_tasks
     SET last_activity_at = $1::bigint,
         data = data || $2::jsonb
   WHERE id = $3`,
  [recentMs, JSON.stringify({ lastActivityAt: recentMs }), otherId]
);

console.log('\n[step 4] Trigger scheduler tick for mikey (5s timeout — dispatch may stream)...');
const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 5000);
let triggerJson;
try {
  const trigger = await fetch('http://localhost:4501/api/scheduler', {
    signal: ctrl.signal,
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'trigger', agentId: 'mikey', triggerSource: 'manual' }),
  });
  triggerJson = await trigger.json();
} catch (e) {
  console.log('  trigger aborted/timeout (expected if dispatch streams):', e.name || e.message);
  triggerJson = { aborted: true };
}
console.log('  response:', JSON.stringify(triggerJson).slice(0, 300));

console.log('\n[step 5] AFTER — task on disk:');
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

await client.end();
process.exit(ok ? 0 : 1);
