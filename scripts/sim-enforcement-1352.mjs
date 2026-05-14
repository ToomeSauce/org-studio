/**
 * #1352 slice 4 — live smoke: verify dispatch enforcement of loopDisabledAt
 * + the auto-clear-on-rediscovery path + the updateTeammate(null) clear path.
 *
 * PATTERN (#1355): Self-contained sandbox fixture.
 *   - Does NOT create tasks (only manipulates teammate fields).
 *   - Entire body wrapped in try/finally.
 *   - finally: resetStaleFields + pg close — guaranteed zero residue.
 *   - Re-running leaves ZERO phantom state on the teammate record.
 */
import pg from 'pg';
import fs from 'fs';

const envText = fs.readFileSync('.env.local', 'utf8');
const dbUrl = envText.match(/^DATABASE_URL=(.+)$/m)?.[1]?.replace(/^"|"$/g, '');
const apiKey = envText.match(/^ORG_STUDIO_API_KEY=(.+)$/m)?.[1]?.replace(/^"|"$/g, '');
const BASE = 'http://localhost:4501';
const headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
const assigneeName = 'Mikey';

const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
await client.connect();

// --- Helpers ---
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

async function resetStaleFields() {
  const r = await client.query(`SELECT data FROM org_studio_settings WHERE id='default'`);
  const data = r.rows[0].data;
  const tms = (data.teammates || []).map(t => {
    if ((t.name || '').toLowerCase() !== assigneeName.toLowerCase()) return t;
    const { staleClaimCount, staleClaimCountedAt, loopDisabledAt, loopDisableReason, ...rest } = t;
    return rest;
  });
  await client.query(`UPDATE org_studio_settings SET data=$1 WHERE id='default'`, [
    JSON.stringify({ ...data, teammates: tms }),
  ]);
}

async function triggerScheduler() {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(`${BASE}/api/scheduler`, {
      signal: ctrl.signal,
      method: 'POST', headers,
      body: JSON.stringify({ action: 'trigger', agentId: 'mikey', triggerSource: 'manual' }),
    });
    return await r.json();
  } catch (e) {
    return { error: e.message, aborted: true };
  }
}

console.log('\n=== #1352 slice 4 enforcement + clear smoke (self-cleaning) ===\n');

try {
  // ---- Phase A: enforcement ----
  console.log('[A.1] Stamping loopDisabledAt on Mikey...');
  await stampDisabled();
  const beforeA = await readTeammate();
  console.log(
    `      teammate state: loopDisabledAt=${beforeA?.loopDisabledAt ? 'SET' : '(unset)'},` +
      ` staleClaimCount=${beforeA?.staleClaimCount ?? 0}`
  );

  console.log('\n[A.2] Triggering scheduler (expect skipped with stale-claim-disabled)...');
  await new Promise(r => setTimeout(r, 1500));
  const respA = await triggerScheduler();
  console.log('      response:', JSON.stringify(respA).slice(0, 250));
  const enforced =
    respA?.skipped === true &&
    typeof respA?.reason === 'string' &&
    /stale-claim|auto-disabled/i.test(respA.reason);
  console.log(`      ${enforced ? '✅ PASS' : '❌ FAIL'} A.2 — dispatch was ${enforced ? 'blocked' : 'NOT blocked'} by stale-claim flag`);

  // ---- Phase B: Team-page clear via updateTeammate(null) ----
  console.log('\n[B.1] Calling /api/store updateTeammate with null sentinels to clear...');
  const teammate = await readTeammate();
  const teammateRowId = teammate?.id;
  let clearedB = false;
  if (!teammateRowId) {
    console.log('      ❌ no teammate row id found — skipping');
  } else {
    const clearResp = await fetch(`${BASE}/api/store`, {
      method: 'POST', headers,
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
    clearedB =
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
    console.log(`      ${clearedB ? '✅ PASS' : '❌ FAIL'} B.1 — fields wiped via null sentinel`);
  }

  // ---- Phase C: auto-clear on rediscovery ----
  console.log('\n[C.1] Re-stamping loopDisabledAt for the rediscovery test...');
  await stampDisabled();
  const beforeC = await readTeammate();
  console.log(`      teammate state: loopDisabledAt=${beforeC?.loopDisabledAt ? 'SET' : '(unset)'}`);

  console.log('\n[C.2] Hitting GET /api/runtimes (triggers auto-clear pass)...');
  const rtResp = await fetch(`${BASE}/api/runtimes`, { headers }).then(r => r.json());
  console.log(`      ${rtResp?.runtimes ? `found ${rtResp.runtimes.length} runtime(s)` : 'no runtimes?'}`);

  await new Promise(r => setTimeout(r, 800));

  const afterC = await readTeammate();
  const autoCleared = !afterC?.loopDisabledAt && !afterC?.loopDisableReason;
  console.log(
    `      teammate state: loopDisabledAt=${afterC?.loopDisabledAt ? 'STILL SET ❌' : '(cleared)'},` +
      ` reason=${afterC?.loopDisableReason ? 'STILL SET' : '(cleared)'}`
  );
  console.log(`      ${autoCleared ? '✅ PASS' : '❌ FAIL'} C.2 — auto-clear on rediscovery fired`);

  // ---- Summary ----
  console.log('\n=== Summary ===');
  console.log(`  A. dispatch enforcement   : ${enforced ? '✅' : '❌'}`);
  console.log(`  B. null-sentinel clear    : ${clearedB ? '✅' : '❌'}`);
  console.log(`  C. auto-clear on discover : ${autoCleared ? '✅' : '❌'}`);

  if (!enforced || !autoCleared) process.exitCode = 1;
} finally {
  // ALWAYS clean up — #1355 contract.
  console.log('\n[cleanup] resetStaleFields...');
  try {
    await resetStaleFields();
    console.log('       teammate fields cleaned.');
  } catch (e) {
    console.error('       cleanup failed:', e.message);
  }
  await client.end();
}
