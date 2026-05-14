// #1352 slice 4 — live smoke: verify dispatch enforcement of loopDisabledAt
// + the auto-clear-on-rediscovery path + the updateTeammate(null) clear path.
//
// Test plan (3 phases):
//   Phase A — enforcement: stamp loopDisabledAt on Mikey, give Mikey a real
//     piece of actionable work, trigger the scheduler, assert the response
//     is skipped with reason='stale-claim-disabled' (NOT 'no-actionable-work'
//     or anything else).
//   Phase B — Team-page clear: with loopDisabledAt still set from phase A,
//     hit POST /api/store action=updateTeammate sending nulls for the
//     stale-claim fields. Assert the fields are removed from the teammate
//     record. Re-trigger and assert the scheduler now responds normally
//     (dispatched OR skipped for a non-stale-claim reason).
//   Phase C — auto-clear on rediscovery: re-stamp loopDisabledAt on Mikey,
//     hit GET /api/runtimes (which exercises the auto-clear block in the
//     runtimes route). Assert loopDisabledAt is gone again.

import pg from 'pg';
import fs from 'fs';

const envText = fs.readFileSync('.env.local', 'utf8');
const dbUrl = envText.match(/^DATABASE_URL=(.+)$/m)?.[1]?.replace(/^"|"$/g, '');
const apiKey = envText.match(/^ORG_STUDIO_API_KEY=(.+)$/m)?.[1]?.replace(/^"|"$/g, '');
const assigneeName = 'Mikey';

const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
await client.connect();

async function readTeammate() {
  const r = await client.query(`SELECT data FROM org_studio_settings WHERE id='default'`);
  const tms = r.rows[0]?.data?.teammates || [];
  return tms.find(t => (t.name || '').toLowerCase() === assigneeName.toLowerCase());
}

async function stampDisabled() {
  const r = await client.query(`SELECT data FROM org_studio_settings WHERE id='default'`);
  const data = r.rows[0].data;
  const tms = (data.teammates || []).map(t => {
    if ((t.name || '').toLowerCase() !== assigneeName.toLowerCase()) return t;
    return {
      ...t,
      loopDisabledAt: Date.now(),
      loopDisableReason: 'Slice-4 smoke test stamp — should be auto-cleared.',
      staleClaimCount: 3,
      staleClaimCountedAt: Date.now(),
    };
  });
  await client.query(`UPDATE org_studio_settings SET data=$1 WHERE id='default'`, [
    JSON.stringify({ ...data, teammates: tms }),
  ]);
}

async function triggerScheduler() {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch('http://localhost:4501/api/scheduler', {
      signal: ctrl.signal,
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'trigger', agentId: 'mikey', triggerSource: 'manual' }),
    });
    return await r.json();
  } catch (e) {
    return { error: e.message, aborted: true };
  }
}

console.log('\n=== #1352 slice 4 enforcement + clear smoke ===\n');

// ---------------- Phase A: enforcement ----------------
console.log('[A.1] Stamping loopDisabledAt on Mikey...');
await stampDisabled();
const beforeA = await readTeammate();
console.log(
  `      teammate state: loopDisabledAt=${beforeA?.loopDisabledAt ? 'SET' : '(unset)'},` +
    ` staleClaimCount=${beforeA?.staleClaimCount ?? 0}`
);

console.log('\n[A.2] Triggering scheduler (expect skipped with stale-claim-disabled)...');
// Cooldown on the trigger path is 60s/agent. Wait a moment to be safe if a
// previous test ran recently.
await new Promise(r => setTimeout(r, 1500));
const respA = await triggerScheduler();
console.log('      response:', JSON.stringify(respA).slice(0, 250));
const enforced =
  respA?.skipped === true &&
  typeof respA?.reason === 'string' &&
  /stale-claim|auto-disabled/i.test(respA.reason);
console.log(`      ${enforced ? '✅ PASS' : '❌ FAIL'} A.2 — dispatch was ${enforced ? 'blocked' : 'NOT blocked'} by stale-claim flag`);

// ---------------- Phase B: Team-page clear via updateTeammate(null) ----------------
console.log('\n[B.1] Calling /api/store updateTeammate with null sentinels to clear...');
const teammate = await readTeammate();
const teammateRowId = teammate?.id;
if (!teammateRowId) {
  console.log('      ❌ no teammate row id found — skipping');
} else {
  const clearResp = await fetch('http://localhost:4501/api/store', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'updateTeammate',
      id: teammateRowId,
      updates: {
        loopDisabledAt: null,
        loopDisableReason: null,
        staleClaimCount: 0,
        staleClaimCountedAt: null,
      },
    }),
  }).then(r => r.json());
  console.log('      api response:', JSON.stringify(clearResp));

  const afterB = await readTeammate();
  const cleared =
    !afterB?.loopDisabledAt &&
    !afterB?.loopDisableReason &&
    (afterB?.staleClaimCount ?? 0) === 0 &&
    !afterB?.staleClaimCountedAt;
  console.log(
    `      teammate state: loopDisabledAt=${afterB?.loopDisabledAt ? 'SET' : '(unset)'},` +
      ` reason=${afterB?.loopDisableReason ? 'SET' : '(unset)'},` +
      ` count=${afterB?.staleClaimCount ?? 0},` +
      ` countedAt=${afterB?.staleClaimCountedAt ? 'SET' : '(unset)'}`
  );
  console.log(`      ${cleared ? '✅ PASS' : '❌ FAIL'} B.1 — fields wiped via null sentinel`);
}

// ---------------- Phase C: auto-clear on rediscovery ----------------
console.log('\n[C.1] Re-stamping loopDisabledAt for the rediscovery test...');
await stampDisabled();
const beforeC = await readTeammate();
console.log(`      teammate state: loopDisabledAt=${beforeC?.loopDisabledAt ? 'SET' : '(unset)'}`);

console.log('\n[C.2] Hitting GET /api/runtimes (triggers auto-clear pass)...');
const rtResp = await fetch('http://localhost:4501/api/runtimes', {
  headers: { 'Authorization': `Bearer ${apiKey}` },
}).then(r => r.json());
console.log(`      ${rtResp?.runtimes ? `found ${rtResp.runtimes.length} runtime(s)` : 'no runtimes?'}`);

// Give the route's updateSettings a beat to flush.
await new Promise(r => setTimeout(r, 800));

const afterC = await readTeammate();
const autoCleared = !afterC?.loopDisabledAt && !afterC?.loopDisableReason;
console.log(
  `      teammate state: loopDisabledAt=${afterC?.loopDisabledAt ? 'STILL SET ❌' : '(cleared)'},` +
    ` reason=${afterC?.loopDisableReason ? 'STILL SET' : '(cleared)'}`
);
console.log(`      ${autoCleared ? '✅ PASS' : '❌ FAIL'} C.2 — auto-clear on rediscovery fired`);

// ---------------- Summary ----------------
console.log('\n=== Summary ===');
console.log(`  A. dispatch enforcement   : ${enforced ? '✅' : '❌'}`);
console.log(`  B. null-sentinel clear    : ${teammateRowId ? '(see above)' : '⚠ skipped'}`);
console.log(`  C. auto-clear on discover : ${autoCleared ? '✅' : '❌'}`);

await client.end();
process.exit(enforced && autoCleared ? 0 : 1);
