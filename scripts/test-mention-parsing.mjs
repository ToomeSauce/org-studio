#!/usr/bin/env node
/**
 * Test mention parsing — validates the lookbehind regex excludes email addresses.
 * Uses the same regex as parseMentions / extractMentions / renderCommentWithMentions.
 */

const mentionPattern = /(?<![\w.])@([\w][\w-]*)/g;

function extractMentions(text) {
  const matches = [];
  let m;
  while ((m = mentionPattern.exec(text)) !== null) {
    matches.push(m[1]);
  }
  mentionPattern.lastIndex = 0; // reset for next call
  return matches;
}

const cases = [
  { input: 'hey @Mikey',                            expected: ['Mikey'],         label: 'simple mention' },
  { input: 'email me at test@gmail.com',             expected: [],                label: 'email — no match' },
  { input: 'test@gmail.com @Mikey',                  expected: ['Mikey'],         label: 'email then mention' },
  { input: '@Mikey, @Ana, see test@gmail.com',       expected: ['Mikey', 'Ana'],  label: 'multiple + email' },
  { input: 'a.b@c.d',                                expected: [],                label: 'dotted email' },
  { input: '(@Mikey)',                                expected: ['Mikey'],         label: 'parens' },
  { input: '\n@Mikey',                                expected: ['Mikey'],         label: 'newline prefix' },
];

let passed = 0;
let failed = 0;

for (const { input, expected, label } of cases) {
  const result = extractMentions(input);
  const ok = JSON.stringify(result) === JSON.stringify(expected);
  if (ok) {
    console.log(`✅ ${label}: ${JSON.stringify(result)}`);
    passed++;
  } else {
    console.log(`❌ ${label}: got ${JSON.stringify(result)}, expected ${JSON.stringify(expected)}`);
    failed++;
  }
}

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
