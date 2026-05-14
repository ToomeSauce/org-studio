/**
 * #1351 slice 2 — end-to-end-ish test of the create-time hook.
 *
 * Reads the live store, plucks the project for #1349 (or fakes one with
 * the Thrivor repos linked), and runs computeMatches() against synthetic
 * task content. Verifies the matcher pipeline + Project.repoUrls
 * resolution work as a unit.
 */
import { computeMatches, resolveProjectRepos } from '../src/lib/possibly-shipped-hook';

const FAKE_PROJECT = {
  id: 'proj-thrivor',
  name: 'Thrivor',
  description: '',
  phase: 'active' as const,
  owner: '',
  priority: 'high' as const,
  createdAt: 0,
  createdBy: '',
  repoUrls: ['teampartial/thrivor', 'teampartial/thrivor-api'],
};

const FAKE_TASK = {
  id: 'test-fake-1349',
  title: 'FE+BE: No way to exit Child Mode back to Parent Mode — parent password gate unreachable',
  description: '**Severity: P0 — blocks MVP**. Per Thrivor MVP spec parent MUST be able to exit Child Mode without logging out. Currently impossible without DevTools.',
  status: 'backlog' as const,
  projectId: 'proj-thrivor',
  assignee: 'mikey',
  createdAt: Date.now(),
};

(async () => {
  console.log('--- resolveProjectRepos ---');
  console.log('  resolved repos:', resolveProjectRepos(FAKE_PROJECT as any));

  console.log('\n--- computeMatches against live PR data ---');
  const result = await computeMatches({
    task: FAKE_TASK as any,
    project: FAKE_PROJECT as any,
    allTasks: [],
  });
  console.log('  meta:', JSON.stringify(result.meta, null, 2));
  console.log('  matches:', result.matches?.length || 0);
  for (const m of result.matches || []) {
    console.log(`    [${m.score.toFixed(3)}] ${m.type} ${m.id}: ${m.title.slice(0,60)}`);
  }
  if (!result.matches || result.matches.length === 0) {
    console.error('FAIL: no matches');
    process.exit(1);
  }
  if (result.matches[0].id !== 'teampartial/thrivor#85') {
    console.error(`FAIL: top match is ${result.matches[0].id}, expected teampartial/thrivor#85`);
    process.exit(1);
  }
  console.log('\nE2E HOOK TEST PASSED ✅');
})().catch(e => { console.error(e); process.exit(1); });
