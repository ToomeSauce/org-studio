#!/usr/bin/env node
/**
 * #863 stress test — fire 50 concurrent addTask requests, verify no duplicate
 * ticketNumbers, then clean up by deleting the test tasks.
 */

const BASE = 'http://localhost:4501';
const TOKEN = '8ce80b4d1379aed97fcd4d75c4a53562';
const N = 50;

async function addOne(i) {
  const res = await fetch(`${BASE}/api/store`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      action: 'addTask',
      task: {
        title: `#863 stress-test ${i} — DELETE ME`,
        status: 'backlog',
        projectId: 'proj-mc',
        assignee: 'Mikey',
        priority: 'low',
        taskType: 'chore',
      },
    }),
  });
  const json = await res.json();
  return { i, ok: res.ok, id: json?.task?.id, num: json?.task?.ticketNumber };
}

async function deleteOne(id) {
  await fetch(`${BASE}/api/store`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ action: 'permanentlyDeleteTask', id }),
  });
}

(async () => {
  const start = Date.now();
  const results = await Promise.all([...Array(N).keys()].map((i) => addOne(i)));
  const elapsed = Date.now() - start;

  const nums = results.map((r) => r.num).filter((n) => typeof n === 'number');
  const unique = new Set(nums);
  const failures = results.filter((r) => !r.ok);

  console.log(`[stress] ${N} concurrent addTask in ${elapsed}ms`);
  console.log(`[stress] ticket numbers issued: ${nums.length}`);
  console.log(`[stress] unique numbers: ${unique.size}`);
  console.log(`[stress] failures: ${failures.length}`);
  console.log(`[stress] range: ${Math.min(...nums)} → ${Math.max(...nums)}`);

  const duplicates = nums.filter((n, i, arr) => arr.indexOf(n) !== i);
  if (duplicates.length) {
    console.error(`[stress] ❌ DUPLICATES FOUND:`, [...new Set(duplicates)]);
  } else {
    console.log(`[stress] ✅ NO DUPLICATES`);
  }

  // Cleanup
  console.log(`[stress] cleaning up ${results.length} test tasks...`);
  await Promise.all(results.filter((r) => r.id).map((r) => deleteOne(r.id)));
  console.log(`[stress] cleanup done`);

  process.exit(duplicates.length ? 1 : 0);
})();
