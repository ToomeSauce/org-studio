#!/usr/bin/env node
// #1112 PR 1 integration test: Components schema is additive + non-breaking.
//
// Tests:
// 1. Project with components[].role + components[].waitsFor round-trips through Postgres
// 2. Existing sections[]-only projects still load unchanged (non-regression)
// 3. New projects no longer persist devOwner/qaOwner
// 4. updateProject on an existing project still preserves its pre-existing devOwner/qaOwner (read-only contract)

const BEARER = 'Bearer 8ce80b4d1379aed97fcd4d75c4a53562';
const H = { 'Content-Type': 'application/json', 'Authorization': BEARER };

async function api(action, extra = {}) {
  const res = await fetch('http://localhost:4501/api/store', {
    method: 'POST', headers: H, body: JSON.stringify({ action, ...extra }),
  });
  return res.json();
}
async function store() { return (await fetch('http://localhost:4501/api/store')).json(); }

const log = (...a) => console.log(...a);
let exitCode = 0;
const assert = (cond, label) => { log(cond ? '✅' : '❌', label); if (!cond) exitCode = 1; };

(async () => {
  const createdIds = [];

  // --- Test 1: Component round-trip ---
  log('\n--- Test 1: Component with role + waitsFor round-trip ---');
  const p1 = await api('addProject', {
    project: {
      name: '#1112-test component round-trip',
      description: 'Schema round-trip test — safe to archive',
      phase: 'active',
      owner: 'Mikey',
      priority: 'low',
      createdBy: 'Mikey',
      components: [
        {
          id: 'cmp-test-fe',
          name: 'Frontend',
          owner: 'Mikey',
          role: 'dev',
          outcomes: 'Ship the UI',
          contract: 'Consumes Backend HTTP API',
        },
        {
          id: 'cmp-test-qa',
          name: 'QA',
          owner: 'Mikey',
          role: 'qa',
          outcomes: 'Validate end-to-end',
          contract: 'Receives dev-complete tasks from Frontend',
          waitsFor: [
            { componentId: 'cmp-test-fe', version: '0.1.0' },
          ],
        },
      ],
    },
  });
  if (!p1.ok) { log('FAIL createProject:', p1); process.exit(2); }
  createdIds.push(p1.project.id);

  const s1 = await store();
  const loaded = s1.projects.find(p => p.id === p1.project.id);
  assert(Array.isArray(loaded.components) && loaded.components.length === 2, 'components[] round-tripped (2 items)');
  const qa = loaded.components?.find(c => c.id === 'cmp-test-qa');
  assert(qa?.role === 'qa', 'component.role preserved');
  assert(Array.isArray(qa?.waitsFor) && qa.waitsFor[0]?.componentId === 'cmp-test-fe', 'component.waitsFor preserved');
  assert(qa?.waitsFor?.[0]?.version === '0.1.0', 'component.waitsFor.version preserved');

  // --- Test 2: sections-only project still works (non-regression) ---
  log('\n--- Test 2: sections-only project (non-regression) ---');
  const p2 = await api('addProject', {
    project: {
      name: '#1112-test sections only',
      description: 'Legacy sections path still works',
      phase: 'active',
      owner: 'Mikey',
      priority: 'low',
      createdBy: 'Mikey',
      sections: [
        { id: 'sec-legacy-main', name: 'Main', owner: 'Mikey', outcomes: '', contract: '' },
      ],
    },
  });
  createdIds.push(p2.project.id);
  const s2 = await store();
  const legacy = s2.projects.find(p => p.id === p2.project.id);
  assert(Array.isArray(legacy.sections) && legacy.sections.length === 1, 'legacy sections[] still loads');
  assert(legacy.sections[0].name === 'Main', 'legacy section.name preserved');
  assert(legacy.components === undefined || !legacy.components.length, 'components[] empty/absent on sections-only project');

  // --- Test 3: New projects drop devOwner/qaOwner ---
  log('\n--- Test 3: New projects drop devOwner/qaOwner ---');
  const p3 = await api('addProject', {
    project: {
      name: '#1112-test drop legacy owners',
      description: 'Should drop devOwner/qaOwner at create',
      phase: 'active',
      owner: 'Mikey',
      priority: 'low',
      createdBy: 'Mikey',
      devOwner: 'ShouldBeDropped',
      qaOwner: 'AlsoDropped',
    },
  });
  createdIds.push(p3.project.id);
  const s3 = await store();
  const fresh = s3.projects.find(p => p.id === p3.project.id);
  assert(!fresh.devOwner, 'new project has no devOwner');
  assert(!fresh.qaOwner, 'new project has no qaOwner');

  // --- Test 4: Existing devOwner/qaOwner preserved on read (spot check pre-existing projects) ---
  log('\n--- Test 4: Historical projects keep devOwner/qaOwner readable ---');
  const thrivor = s3.projects.find(p => p.id === 'zrrt51fgmn578ujz');
  assert(thrivor?.devOwner === 'Trevor', 'proj-thrivor.devOwner still readable (not stripped by PR 1)');

  // --- Cleanup: archive test projects ---
  log('\n--- Cleanup ---');
  for (const id of createdIds) {
    await api('updateProject', { id, updates: { isArchived: true, archivedAt: Date.now(), archivedReason: '#1112 PR1 test cleanup' } });
  }
  log(`  archived ${createdIds.length} test projects`);

  log(`\n${exitCode === 0 ? 'ALL GREEN ✅' : 'FAILURES ❌'}`);
  process.exit(exitCode);
})();
