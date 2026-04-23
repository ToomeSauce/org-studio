// Quick smoke test for buildDispatchMessage with blocked tasks.
// Run: node --experimental-vm-modules scripts/test-blocked-in-dispatch.mjs
import fetch from 'node-fetch';

const res = await fetch('http://localhost:4501/api/store');
const store = await res.json();

const BILLY_ID = 'billy';
const billyTasks = store.tasks.filter(t => (t.assignee || '').toLowerCase() === 'billy' && !t.isArchived);
const byStatus = {};
for (const t of billyTasks) {
  byStatus[t.status] = (byStatus[t.status] || 0) + 1;
}
console.log('Billy task breakdown:', byStatus);
console.log('Total non-archived:', billyTasks.length);
console.log();

// Poke the scheduler to produce a fresh dispatch and rely on the cooldown having expired
// (we can't call buildDispatchMessage directly since it's in a compiled Next.js bundle)
// Instead, check what agentOwnedSections would see
console.log('Blocked tasks assigned to Billy:');
for (const t of billyTasks.filter(t => t.status === 'blocked')) {
  console.log(`  #${t.ticketNumber} ${t.title.substring(0, 60)}`);
}
console.log('\nActive (in-progress + backlog) assigned to Billy:');
for (const t of billyTasks.filter(t => ['in-progress', 'backlog'].includes(t.status))) {
  console.log(`  #${t.ticketNumber} ${t.status} ${t.title.substring(0, 60)}`);
}
