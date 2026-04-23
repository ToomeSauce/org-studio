// Unit test for #1100: buildDispatchMessage must show blocked tasks in a
// visibility-only section and NEVER list them as actionable work.
//
// Run: npx tsx scripts/test-blocked-in-dispatch.ts

import { buildDispatchMessage } from '../src/lib/scheduler';

const store: any = {
  projects: [
    {
      id: 'proj-thrivor',
      name: 'Thrivor',
      devOwner: 'Mikey',
      qaOwner: 'Billy',
      sections: [{ id: 'sec-main-proj-thrivor', name: 'Main', owner: 'Mikey' }],
      autonomy: { approvedThrough: '0.99.0' },
      state: 'started',
    },
  ],
  tasks: [
    // Blocked — must NOT be dispatched but MUST appear in visibility section
    { id: 't-580', ticketNumber: 580, title: 'Parent creates reward', status: 'blocked',
      projectId: 'proj-thrivor', assignee: 'Billy', version: '0.1.0' },
    { id: 't-581', ticketNumber: 581, title: 'Child sees rewards',    status: 'blocked',
      projectId: 'proj-thrivor', assignee: 'Billy', version: '0.1.0' },
    // Actionable backlog
    { id: 't-582', ticketNumber: 582, title: 'Child redeems reward',  status: 'backlog',
      projectId: 'proj-thrivor', assignee: 'Billy', version: '0.1.0' },
    // Done — should be invisible
    { id: 't-579', ticketNumber: 579, title: 'Setup schema',          status: 'done',
      projectId: 'proj-thrivor', assignee: 'Billy', version: '0.1.0' },
    // Unknown status (drift sentinel)
    { id: 't-ufo', ticketNumber: 999, title: 'Mystery task',          status: 'alpaca',
      projectId: 'proj-thrivor', assignee: 'Billy', version: '0.1.0' },
  ],
  settings: { teammates: [{ agentId: 'billy', name: 'Billy' }] },
};

(async () => {
  const msg = await buildDispatchMessage(store, 'billy', 'Billy');
  console.log('\n─── DISPATCH MESSAGE ───\n');
  console.log(msg);
  console.log('\n─── ASSERTIONS ───\n');

  const assert = (cond: boolean, label: string) => {
    console.log(cond ? '✅' : '❌', label);
    if (!cond) process.exitCode = 1;
  };

  assert(msg !== null, 'message produced (Billy has actionable #582)');
  assert(msg!.includes('#582'),   'actionable #582 listed');
  assert(msg!.includes('Blocked (2)'), 'blocked visibility section (count=2)');
  assert(msg!.includes('#580'),   '#580 shown in visibility section');
  assert(msg!.includes('#581'),   '#581 shown in visibility section');
  assert(!msg!.includes('#579'),  "#579 (done) NOT shown");
  // #580/#581 must NOT appear under "Resume in-progress" or "Next from backlog"
  const resumeSection = msg!.split('Blocked')[0];
  assert(!resumeSection.includes('#580'), "#580 not listed as actionable work");
  assert(!resumeSection.includes('#581'), "#581 not listed as actionable work");
  assert(msg!.includes('do NOT work these'), 'visibility-only hint present');
  assert(msg!.includes('Blocked tasks are not yours'), 'instruction #6 present');

  console.log('\nNegative case: agent with ONLY blocked tasks\n');
  const blockedOnlyStore = {
    ...store,
    tasks: store.tasks.filter((t: any) => t.status === 'blocked'),
  };
  const msg2 = await buildDispatchMessage(blockedOnlyStore, 'billy', 'Billy');
  assert(msg2 === null, 'no dispatch when ONLY blocked work exists');
})();
