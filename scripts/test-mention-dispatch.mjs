#!/usr/bin/env node
/**
 * Smoke test: post a comment with @Mikey mention and verify the LISTEN handler
 * picks it up and routes it via the scheduler API.
 */
const API = 'http://127.0.0.1:4501';
const API_KEY = '8ce80b4d1379aed97fcd4d75c4a53562';
const TASK_ID = 'w16uxsuimo4n12se';
const timestamp = Date.now();
const testContent = `@Mikey smoke-test-${timestamp}`;

async function main() {
  console.log(`[test] Posting comment: "${testContent}" on task ${TASK_ID}`);
  
  const res = await fetch(`${API}/api/store`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      action: 'addComment',
      taskId: TASK_ID,
      comment: {
        author: 'SmokeTest',
        content: testContent,
        mentions: ['Mikey'],
      },
    }),
  });

  if (!res.ok) {
    console.error(`[test] Failed to post comment: ${res.status} ${await res.text()}`);
    process.exit(1);
  }

  const result = await res.json();
  console.log(`[test] Comment posted: id=${result.id || result.comment?.id || 'unknown'}`);

  // Wait for LISTEN handler to process
  console.log('[test] Waiting 3s for NOTIFY processing...');
  await new Promise(r => setTimeout(r, 3000));

  // Check server log
  const { execSync } = await import('child_process');
  const log = execSync('tail -n 30 /tmp/org-studio-server.log').toString();
  
  const lines = log.split('\n');
  const mentionLines = lines.filter(l => l.includes('Mention') || l.includes('comment_added'));
  
  if (mentionLines.length > 0) {
    console.log('[test] ✅ Found mention routing in server log:');
    for (const l of mentionLines) console.log(`  ${l}`);
    
    const hasRouting = mentionLines.some(l => l.includes('agentId=mikey') || l.includes('Mention routing'));
    if (hasRouting) {
      console.log('[test] ✅ Mention successfully routed to mikey');
    } else {
      console.log('[test] ⚠️ Mention event received but routing not confirmed (may be cooldown)');
    }
  } else {
    console.log('[test] ❌ No mention routing found in server log');
    console.log('[test] Last 10 log lines:');
    for (const l of lines.slice(-10)) console.log(`  ${l}`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('[test] Error:', e);
  process.exit(1);
});
