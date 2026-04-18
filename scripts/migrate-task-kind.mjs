#!/usr/bin/env node
/**
 * migrate-task-kind.mjs  (#698)
 *
 * Backfills taskKind and taskType on existing tasks.
 *
 * Rules:
 *   - version set (non-empty) → taskKind='roadmap', taskType='feature' (only if unset)
 *   - version unset/empty     → taskKind='adhoc',   taskType='followup' (only if unset)
 *   - Tasks that already have taskKind AND taskType are skipped (idempotent)
 *
 * Usage:
 *   node scripts/migrate-task-kind.mjs           # dry-run (default)
 *   node scripts/migrate-task-kind.mjs --apply   # actually write changes
 *
 * Env:
 *   ORG_STUDIO_API_KEY — Bearer token for the store API
 *   BASE_URL           — default http://localhost:4501
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:4501';
const API_KEY = process.env.ORG_STUDIO_API_KEY || '';
const APPLY = process.argv.includes('--apply');

const headers = { 'Content-Type': 'application/json' };
if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;

async function main() {
  console.log(`migrate-task-kind: ${APPLY ? 'APPLY mode' : 'DRY-RUN mode'}`);
  console.log(`Base URL: ${BASE_URL}\n`);

  // 1. Fetch all tasks
  const res = await fetch(`${BASE_URL}/api/store`, { headers });
  if (!res.ok) {
    console.error(`Failed to fetch store: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const store = await res.json();
  const tasks = store.tasks || [];

  let roadmapCount = 0;
  let adhocCount = 0;
  let skippedCount = 0;

  for (const task of tasks) {
    // Skip if already has both fields
    if (task.taskKind && task.taskType) {
      skippedCount++;
      continue;
    }

    const version = (task.version || '').trim();
    const updates = {};

    if (version) {
      // Roadmap task
      if (!task.taskKind) updates.taskKind = 'roadmap';
      if (!task.taskType) updates.taskType = 'feature';
      roadmapCount++;
    } else {
      // Adhoc task
      if (!task.taskKind) updates.taskKind = 'adhoc';
      if (!task.taskType) updates.taskType = 'followup';
      adhocCount++;
    }

    if (Object.keys(updates).length === 0) {
      skippedCount++;
      continue;
    }

    const label = version ? `roadmap (v${version})` : 'adhoc';
    console.log(`  ${APPLY ? '✏️' : '🔍'} #${task.ticketNumber || '?'} "${task.title}" → ${label} [${JSON.stringify(updates)}]`);

    if (APPLY) {
      const updateRes = await fetch(`${BASE_URL}/api/store`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'updateTask', id: task.id, updates }),
      });
      if (!updateRes.ok) {
        console.error(`  ❌ Failed to update task ${task.id}: ${updateRes.status}`);
      }
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(`Migrated ${roadmapCount} roadmap, ${adhocCount} adhoc, ${skippedCount} skipped`);
  if (!APPLY) {
    console.log(`\nThis was a dry run. Run with --apply to execute changes.`);
  }
}

main().catch(e => {
  console.error('Migration failed:', e);
  process.exit(1);
});
