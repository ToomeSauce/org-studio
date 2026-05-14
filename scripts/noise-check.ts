import { getMergedPRsForRepos } from '../src/lib/gh-pr-cache';
import { findMatches } from '../src/lib/duplicate-matcher';

const CASES = [
  {
    name: 'Unrelated billing ticket',
    title: 'Stripe webhook for failed subscription renewal',
    desc: 'Catch failed_payment events and surface them in the billing dashboard.',
  },
  {
    name: 'Unrelated infra ticket',
    title: 'Migrate Postgres to pgvector for embeddings',
    desc: 'Set up pgvector extension for storing OpenAI ada embeddings.',
  },
  {
    name: 'Generic onboarding ticket',
    title: 'Onboarding flow: collect timezone on signup',
    desc: 'Add timezone picker to the third step of the onboarding wizard.',
  },
];

(async () => {
  const prs = await getMergedPRsForRepos(['teampartial/thrivor','teampartial/thrivor-api']);
  for (const c of CASES) {
    console.log(`\n--- ${c.name} ---`);
    const matches = findMatches({
      sourceTitle: c.title,
      sourceDescription: c.desc,
      prs,
      doneTasks: [],
      minScore: 0.20,
    });
    if (matches.length === 0) {
      console.log('  (no matches — good)');
    } else {
      for (const m of matches) {
        console.log(`  [${m.score.toFixed(3)}] ${m.id}: ${m.title.slice(0,70)}`);
      }
    }
  }
})();
