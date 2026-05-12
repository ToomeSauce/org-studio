#!/usr/bin/env node
/**
 * migrate-qa-projects.mjs — QA-fold migration (ticket #685)
 *
 * Migrates QA-only projects into sections on their parent project.
 * Uses the Org Studio HTTP API so it works with File and Postgres backends.
 *
 * Usage:
 *   node scripts/migrate-qa-projects.mjs                       # dry-run (default)
 *   node scripts/migrate-qa-projects.mjs --apply               # actually execute
 *   node scripts/migrate-qa-projects.mjs --url=http://host:4501/api/store
 *   node scripts/migrate-qa-projects.mjs --token=<api-key>
 *
 * Environment variables (fallbacks):
 *   ORG_STUDIO_API_KEY — bearer token
 */

// --- Arg parsing (plain Node, no deps) ---
const args = process.argv.slice(2);
const flags = {};
for (const a of args) {
  if (a === '--apply') flags.apply = true;
  else if (a.startsWith('--url=')) flags.url = a.slice(6);
  else if (a.startsWith('--token=')) flags.token = a.slice(8);
  else if (a === '--help' || a === '-h') {
    console.log(`Usage: node scripts/migrate-qa-projects.mjs [--apply] [--url=<store-api>] [--token=<key>]`);
    process.exit(0);
  }
}

const API = flags.url || process.env.ORG_STUDIO_URL || 'http://localhost:4501/api/store';
const TOKEN = flags.token || process.env.ORG_STUDIO_API_KEY || '';
const DRY = !flags.apply;

if (!TOKEN) {
  console.error('Error: API token required. Set ORG_STUDIO_API_KEY or pass --token=<key>');
  process.exit(1);
}

const tag = DRY ? '[dry-run]' : '[APPLY]';

// --- HTTP helpers ---
async function apiGet() {
  const res = await fetch(API, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`GET ${API} → ${res.status} ${res.statusText}`);
  return res.json();
}

async function apiPost(body) {
  if (DRY) {
    console.log(`  ${tag} POST ${JSON.stringify(body).slice(0, 200)}`);
    return { ok: true };
  }
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST ${API} → ${res.status}: ${text}`);
  }
  return res.json();
}

// --- Detection (mirrors src/lib/qa-migration.ts) ---
function detectQaProjects(projects) {
  const matches = [];
  for (const p of projects) {
    const name = (p.name || '').trim();
    if (!name.toLowerCase().endsWith(' qa')) continue;
    if (p.isArchived && p.archivedReason === 'qa-fold') continue;
    const prefix = name.slice(0, -3).trim();
    if (!prefix) continue;
    const parent = projects.find(
      (o) => o.id !== p.id && (o.name || '').trim().toLowerCase() === prefix.toLowerCase()
    );
    if (!parent) continue;
    matches.push({
      qaProject: p,
      parentProject: parent,
      sectionId: `sec-qa-${parent.id}`,
      sectionOwner: p.qaOwner || p.devOwner || parent.qaOwner || '',
    });
  }
  return matches;
}

// --- Main ---
async function main() {
  console.log(`\n${tag} QA-fold migration`);
  console.log(`  API: ${API}`);
  console.log(`  Mode: ${DRY ? 'DRY RUN (pass --apply to execute)' : 'LIVE'}\n`);

  const store = await apiGet();
  const projects = store.projects || [];
  const tasks = store.tasks || [];

  const matches = detectQaProjects(projects);

  if (matches.length === 0) {
    console.log('No QA-only projects to migrate.');
    console.log('Migrated 0 project(s), moved 0 task(s).');
    process.exit(0);
  }

  let projectsMigrated = 0;
  let tasksMoved = 0;

  for (const { qaProject, parentProject, sectionId, sectionOwner } of matches) {
    console.log(`\n--- ${qaProject.name} → ${parentProject.name} (section ${sectionId}) ---`);

    // Check if parent already has this section
    const parentSections = parentProject.sections || [];
    const existingSection = parentSections.find((s) => s.id === sectionId);

    // Collect tasks to move (non-archived tasks still in QA project)
    const tasksToMove = tasks.filter(
      (t) => t.projectId === qaProject.id && !t.isArchived
    );

    if (existingSection && tasksToMove.length === 0) {
      console.log(`  skipped: section exists, no tasks to move`);
      // Ensure project is archived even if tasks already moved
      if (!qaProject.isArchived) {
        console.log(`  ${tag} Archive QA project`);
        await apiPost({
          action: 'updateProject',
          id: qaProject.id,
          updates: {
            isArchived: true,
            archivedAt: Date.now(),
            archivedReason: 'qa-fold',
            migratedTo: { projectId: parentProject.id, sectionId },
          },
        });
        projectsMigrated++;
      }
      continue;
    }

    // 1. Create section on parent (if not existing)
    if (!existingSection) {
      console.log(`  ${tag} Add QA section to ${parentProject.name} (owner: ${sectionOwner || '<none>'})`);
      await apiPost({
        action: 'addSection',
        projectId: parentProject.id,
        section: {
          id: sectionId,
          name: 'QA',
          owner: sectionOwner,
          outcomes: 'End-user QA, bug validation, regression',
          contract: 'Validates work from other sections before it ships',
        },
      });
    } else {
      console.log(`  Section already exists — reusing`);
    }

    // 2. Move tasks
    for (const task of tasksToMove) {
      console.log(`  ${tag} Move task #${task.ticketNumber || task.id} "${task.title}" → ${parentProject.name}/${sectionId}`);
      await apiPost({
        action: 'updateTask',
        id: task.id,
        updates: { projectId: parentProject.id, sectionId },
      });
      tasksMoved++;
    }

    // 3. Set parent qaOwner if empty
    if (!parentProject.qaOwner && sectionOwner) {
      console.log(`  ${tag} Set ${parentProject.name} qaOwner → ${sectionOwner}`);
      await apiPost({
        action: 'updateProject',
        id: parentProject.id,
        updates: { qaOwner: sectionOwner },
      });
    }

    // 4. Archive QA project
    console.log(`  ${tag} Archive ${qaProject.name}`);
    await apiPost({
      action: 'updateProject',
      id: qaProject.id,
      updates: {
        isArchived: true,
        archivedAt: Date.now(),
        archivedReason: 'qa-fold',
        migratedTo: { projectId: parentProject.id, sectionId },
      },
    });

    projectsMigrated++;
  }

  console.log(`\nMigrated ${projectsMigrated} project(s), moved ${tasksMoved} task(s).`);
  process.exit(0);
}

// #1312 guard: only auto-run when invoked as a script. When imported by
// another module (e.g. server.mjs), do NOT trigger main() — let the
// caller decide. Prevents one Postgres hiccup from killing the dashboard.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Migration failed:', err.message || err);
    process.exit(1);
  });
}
