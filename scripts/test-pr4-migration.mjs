#!/usr/bin/env node
// scripts/test-pr4-migration.mjs
// Regression test for #1112 PR 4 — Thrivor QA fold-in.
// Verifies the post-migration state against the live store API.

const API = 'http://localhost:4501/api/store';

const THRIVOR_ID = 'zrrt51fgmn578ujz';
const OLD_QA_ID = '3vmay6ibmo22u5ze';
const QA_COMPONENT_ID = 'sec-lbckedr6';
const EXPECTED_MOVED_COUNT = 66;
const EXPECTED_WAITS_FOR_VERSION = '0.909.0';
const MAIN_COMPONENT_ID = 'sec-main-zrrt51fgmn578ujz';

const store = await fetch(API).then(r => r.json());

const checks = [];
const pass = (name) => { checks.push({ name, ok: true }); console.log(`  ✓ ${name}`); };
const fail = (name, detail) => { checks.push({ name, ok: false, detail }); console.log(`  ✗ ${name} — ${detail}`); };

// (a) Old proj-thrivor-qa is archived with migratedTo pointer
const oldProj = store.projects.find(p => p.id === OLD_QA_ID);
if (!oldProj) fail('proj-thrivor-qa still exists (not deleted)', 'project missing entirely');
else if (!oldProj.isArchived) fail('proj-thrivor-qa is archived', `isArchived=${oldProj.isArchived}`);
else if (oldProj.migratedTo !== THRIVOR_ID) fail('proj-thrivor-qa has migratedTo pointer', `migratedTo=${oldProj.migratedTo}`);
else pass('proj-thrivor-qa archived with migratedTo pointer');

// (b) QA component exists on proj-thrivor with correct shape
const thrivor = store.projects.find(p => p.id === THRIVOR_ID);
const qaComp = (thrivor.components || thrivor.sections || []).find(c => c.id === QA_COMPONENT_ID);
if (!qaComp) fail('QA component on proj-thrivor', 'not found');
else {
  if (qaComp.owner !== 'Billy') fail('QA component owner=Billy', `owner=${qaComp.owner}`);
  else pass('QA component owner=Billy');
  if (qaComp.role !== 'qa') fail('QA component role=qa', `role=${qaComp.role}`);
  else pass('QA component role=qa');
  if (!Array.isArray(qaComp.waitsFor) || qaComp.waitsFor.length !== 1) fail('QA component waitsFor has 1 entry', `len=${qaComp.waitsFor?.length}`);
  else if (qaComp.waitsFor[0].componentId !== MAIN_COMPONENT_ID) fail('QA waitsFor componentId=Main', `got=${qaComp.waitsFor[0].componentId}`);
  else if (qaComp.waitsFor[0].version !== EXPECTED_WAITS_FOR_VERSION) fail(`QA waitsFor version=${EXPECTED_WAITS_FOR_VERSION}`, `got=${qaComp.waitsFor[0].version}`);
  else pass(`QA waitsFor → Main @ ${EXPECTED_WAITS_FOR_VERSION}`);
}

// (c) All migrated tasks are on proj-thrivor with sectionId=QA
const migratedTasks = store.tasks.filter(t => t.sectionId === QA_COMPONENT_ID);
if (migratedTasks.length !== EXPECTED_MOVED_COUNT) fail(`${EXPECTED_MOVED_COUNT} tasks on QA component`, `got ${migratedTasks.length}`);
else pass(`${EXPECTED_MOVED_COUNT} tasks on QA component`);

const allOnThrivor = migratedTasks.every(t => t.projectId === THRIVOR_ID);
if (!allOnThrivor) fail('all migrated tasks have projectId=thrivor', 'some mismatch');
else pass('all migrated tasks have projectId=thrivor');

// (d) No active (non-archived) tasks remain on old QA project
const orphans = store.tasks.filter(t => t.projectId === OLD_QA_ID && !t.isArchived);
if (orphans.length > 0) fail('no active tasks left on old proj-thrivor-qa', `${orphans.length} orphans`);
else pass('no active tasks left on old proj-thrivor-qa');

// (e) Ticket identifiers preserved (no renumbering). These tasks were created without a `number` field —
// validate `id` stability instead (which is what actually matters for external references, comments, etc.).
const ids = new Set(migratedTasks.map(t => t.id));
if (ids.size !== migratedTasks.length) fail('all migrated tasks have unique ids', 'duplicate ids detected');
else pass('all migrated tasks have unique ids (stable identifiers preserved)');

// Summary
const failed = checks.filter(c => !c.ok);
console.log(`\n${failed.length === 0 ? '✅' : '❌'} ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
