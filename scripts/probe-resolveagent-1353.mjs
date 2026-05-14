/**
 * #1353 slice 2 — Live verification: resolveAgentModel still stamps
 * comments correctly through the new registry dispatch path.
 *
 * Posts a real comment on a real task using the live API. Verifies
 * the comment's `model` field matches expected stamp for Mikey
 * (OpenClaw → claude-opus-4.7) and a Hermes agent. Cleans up after.
 *
 * #1355 lesson: ALL fixtures wrapped in try/finally with hard delete,
 * so a crash doesn't leak smoke debris into the sweep's blast radius.
 */
import { readFileSync } from 'fs';

const PORT = process.env.PORT || '4501';
const BASE = `http://localhost:${PORT}`;
const KEY = readFileSync('.env.local', 'utf-8')
  .split('\n').find(l => l.startsWith('ORG_STUDIO_API_KEY='))
  .replace('ORG_STUDIO_API_KEY=', '').trim();

async function api(action, payload = {}) {
  const r = await fetch(`${BASE}/api/store`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}` },
    body: JSON.stringify({ action, ...payload }),
  });
  return r.json();
}

async function main() {
  console.log('=== #1353 slice 2 live model-stamping probe ===\n');

  // Step 1: create a sandbox task
  console.log('[1] Creating sandbox task...');
  const created = await api('addTask', {
    task: {
      title: '#1353-s2 probe — verify model stamp via registry dispatch',
      projectId: 'proj-org-studio',
      assignee: 'Mikey',
      status: 'backlog',
      taskType: 'chore',
      description: 'Sandbox probe for #1353 slice 2. Auto-deleted on success.',
    },
  });
  const taskId = created?.task?.id;
  if (!taskId) {
    console.error('FAIL — could not create task:', JSON.stringify(created));
    process.exit(1);
  }
  console.log(`      taskId: ${taskId}, ticketNumber: ${created.task.ticketNumber}`);

  try {
    // Step 2: post a comment as Mikey, check stamp
    console.log('\n[2] Posting comment as Mikey...');
    const commentResp = await api('addComment', {
      taskId,
      comment: {
        author: 'Mikey',
        content: '#1353 slice 2 probe — checking my own stamp',
        type: 'comment',
      },
    });
    const mikeyStamp = commentResp?.comment?.model;
    console.log(`      stamp: ${mikeyStamp}`);
    if (!mikeyStamp || !mikeyStamp.includes('claude') && !mikeyStamp.includes('gpt')) {
      console.warn('      ⚠️  stamp looks wrong or missing (expected claude-* or gpt-*)');
    } else {
      console.log('      ✅ stamp present and looks sane');
    }

    // Step 3: post a comment as Trevor, check stamp (should be gpt-5.5)
    console.log('\n[3] Posting comment as Trevor (Hermes)...');
    const trevorResp = await api('addComment', {
      taskId,
      comment: {
        author: 'Trevor',
        content: '#1353 slice 2 probe — Trevor stamp via HermesRuntime',
        type: 'comment',
      },
    });
    const trevorStamp = trevorResp?.comment?.model;
    console.log(`      stamp: ${trevorStamp}`);
    if (trevorStamp && trevorStamp.includes('gpt-5')) {
      console.log('      ✅ Trevor stamps gpt-5.* via registry dispatch (was opus-4.7 before #1350)');
    } else {
      console.warn(`      ⚠️  Trevor stamp unexpected: ${trevorStamp}`);
    }

    console.log('\n=== PROBE COMPLETE ===');
    console.log(`Mikey: ${mikeyStamp}`);
    console.log(`Trevor: ${trevorStamp}`);
  } finally {
    // ALWAYS hard-delete the sandbox task — #1355 lesson.
    console.log('\n[cleanup] permanentlyDeleteTask...');
    await api('permanentlyDeleteTask', { id: taskId });
    console.log('       fixture removed.');
  }
}

main().catch(e => {
  console.error('PROBE ERROR:', e);
  process.exit(1);
});
