#!/usr/bin/env node
/**
 * #1126 PR 5 — Versioned-ownership migration script.
 *
 * Folds a project's standalone `role: 'qa'` section into its Main section
 * as a sequence of versioned slices, each with its own `owner` set to the
 * old QA section's owner. Then deletes the QA section.
 *
 * Naming convention (Basil locked, 2026-04-26):
 *   No special QA version syntax. The folded QA slice is numbered as the
 *   next-natural progression on Main: when Main has v0.908.1 (shipped, dev),
 *   the QA pass becomes v0.908.2 (current, owner=Billy). We do NOT special-
 *   case "qa" anywhere — it's just another version with a different owner.
 *
 * Usage:
 *   node scripts/migrate-versioned-ownership.mjs --dry-run             # safe, prints diff
 *   node scripts/migrate-versioned-ownership.mjs --execute              # writes
 *   node scripts/migrate-versioned-ownership.mjs --execute --project zrrt51fgmn578ujz
 *   node scripts/migrate-versioned-ownership.mjs --dry-run --delete-test-projects
 *
 * Flags:
 *   --dry-run              No writes; print plan + diff.
 *   --execute              Apply writes (mutually exclusive with --dry-run).
 *   --project <id>         Limit to one project (default: all role:qa projects).
 *   --delete-test-projects Also delete projects flagged as test fixtures.
 *                          Today: 8xvk4ydrmoc8j6ff ("#1112-test component
 *                          round-trip"). Explicit allowlist, not a heuristic.
 *
 * Outputs (on --execute):
 *   /backups/pre-versioned-ownership-<projectId>-<ts>.json   full snapshot
 *   /backups/pre-versioned-ownership-<projectId>-<ts>-diff.json
 *                                                              touched-records-only diff
 *
 * Idempotent: re-running on a partially-migrated project is safe — the
 * detect step looks for `role: 'qa'` sections; once removed, nothing
 * matches and the script no-ops.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// --- CLI parsing ---
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isExecute = args.includes('--execute');
const deleteTest = args.includes('--delete-test-projects');
const projectArgIdx = args.indexOf('--project');
const onlyProjectId = projectArgIdx >= 0 ? args[projectArgIdx + 1] : null;

if (!isDryRun && !isExecute) {
  console.error('Error: must specify --dry-run or --execute.');
  process.exit(1);
}
if (isDryRun && isExecute) {
  console.error('Error: --dry-run and --execute are mutually exclusive.');
  process.exit(1);
}

// Test-project allowlist (explicit, not pattern-matched)
const TEST_PROJECT_IDS = new Set([
  '8xvk4ydrmoc8j6ff', // "#1112-test component round-trip"
]);

const API_BASE = process.env.OS_API_BASE || 'http://localhost:4501';
const API_KEY  = process.env.ORG_STUDIO_API_KEY || '8ce80b4d1379aed97fcd4d75c4a53562';

async function api(path, init = {}) {
  const res = await fetch(API_BASE + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.body ? { 'Authorization': `Bearer ${API_KEY}` } : {}),
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`API ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function logHeader(label) {
  console.log('\n' + '='.repeat(70));
  console.log(label);
  console.log('='.repeat(70));
}

function bumpPatch(version) {
  // 0.908.1 → 0.908.2; 0.9.0 → 0.9.1; 0.1.0 → 0.1.1
  const parts = String(version).split('.');
  if (parts.length < 2) return `${version}.1`;
  const last = parseInt(parts[parts.length - 1], 10);
  if (Number.isNaN(last)) return `${version}.1`;
  parts[parts.length - 1] = String(last + 1);
  return parts.join('.');
}

function planMigrationFor(project) {
  const sections = project.sections || project.components || [];
  const qaSec = sections.find(s => s.role === 'qa');
  if (!qaSec) return null;
  const mainSec = sections.find(s => s.role !== 'qa');
  if (!mainSec) {
    return { project, qaSec, error: 'No non-QA section found to fold into.' };
  }
  const mainVersions = (mainSec.versions || []).slice();
  const mainByVersion = new Map(mainVersions.map(v => [v.version, v]));
  const folds = [];
  for (const qaV of (qaSec.versions || [])) {
    // Match QA version to a Main version (same string).
    const matchedMain = mainByVersion.get(qaV.version);
    if (!matchedMain) {
      folds.push({ qaVersion: qaV, error: `No matching Main version v${qaV.version}` });
      continue;
    }
    // Pick the next-bumped version string that doesn't already exist on Main.
    let proposed = bumpPatch(qaV.version);
    let attempts = 0;
    while (mainByVersion.has(proposed) && attempts < 50) {
      proposed = bumpPatch(proposed);
      attempts++;
    }
    if (mainByVersion.has(proposed)) {
      folds.push({ qaVersion: qaV, error: `Could not find unused version after ${attempts} bumps from v${qaV.version}` });
      continue;
    }
    folds.push({
      qaVersion: qaV,
      matchedMainVersion: matchedMain,
      foldedAs: {
        version: proposed,
        status: qaV.status,
        owner: qaSec.owner, // every fold inherits old QA-section owner
        items: (qaV.items || []).slice(), // includes taskId refs
        sort_order: (matchedMain.sort_order || 0) + 500, // immediately after match, before next Main version
        version_type: qaV.version_type || 'outcome',
        // PR 6 invariant: Rule 4 still relies on per-version waitsFor for
        // genuine cross-section coupling. The OLD QA waitsFor (pointing at
        // Main of the same version) was the implicit "QA waits for Main"
        // gate; the NEW fold sits AFTER Main on the timeline, which the
        // sequential gate (Rule 5) handles. We drop it.
        // If a QA version has a cross-PROJECT waitsFor (different projectId),
        // we preserve it.
        ...(qaV.waitsFor && qaV.waitsFor.projectId ? { waitsFor: qaV.waitsFor } : {}),
      },
      // Tasks that need .version rewritten to the new fold version
      tasksToRewrite: { fromVersion: qaV.version, toVersion: proposed },
    });
    // Track in the local map so subsequent folds don't collide
    mainByVersion.set(proposed, folds[folds.length - 1].foldedAs);
  }
  return { project, qaSec, mainSec, folds };
}

async function loadStore() {
  const data = await api('/api/store');
  return data;
}

async function main() {
  logHeader(`#1126 PR 5 migration — mode=${isDryRun ? 'DRY-RUN' : 'EXECUTE'}`);
  console.log(`API: ${API_BASE}`);
  console.log(`Filter: ${onlyProjectId ? `project=${onlyProjectId}` : 'all projects with role:qa sections'}`);
  console.log(`Test-project deletion: ${deleteTest ? 'YES' : 'no'}`);

  const store = await loadStore();
  const candidates = (store.projects || []).filter(p => {
    if (onlyProjectId && p.id !== onlyProjectId) return false;
    const secs = p.sections || p.components || [];
    return secs.some(s => s.role === 'qa');
  });

  logHeader(`Found ${candidates.length} project(s) with role:qa sections`);
  for (const p of candidates) console.log(`  - ${p.id} "${p.name || '(unnamed)'}"`);

  const plans = candidates.map(planMigrationFor).filter(Boolean);

  for (const plan of plans) {
    if (plan.error) {
      logHeader(`SKIP ${plan.project.id} "${plan.project.name || ''}" — ${plan.error}`);
      continue;
    }
    logHeader(`Plan for ${plan.project.id} "${plan.project.name || ''}"`);
    console.log(`Folding QA section "${plan.qaSec.name}" (id=${plan.qaSec.id}, owner=${plan.qaSec.owner}) into "${plan.mainSec.name}" (id=${plan.mainSec.id}).`);
    console.log('');
    console.log(`${plan.folds.length} fold(s):`);
    for (const f of plan.folds) {
      if (f.error) {
        console.log(`  ❌  v${f.qaVersion.version}  →  ERROR: ${f.error}`);
        continue;
      }
      const itemCount = (f.foldedAs.items || []).length;
      console.log(`  →   v${f.qaVersion.version} (${f.qaVersion.status}, items=${itemCount})  becomes  Main v${f.foldedAs.version} (${f.foldedAs.status}, owner=${f.foldedAs.owner}, sort_order=${f.foldedAs.sort_order})`);
    }
    // Tasks
    const taskRewrites = [];
    for (const f of plan.folds) {
      if (f.error) continue;
      const matching = (store.tasks || []).filter(t =>
        t.projectId === plan.project.id &&
        t.sectionId === plan.qaSec.id &&
        t.version === f.qaVersion.version &&
        !t.isArchived
      );
      for (const t of matching) {
        taskRewrites.push({
          taskId: t.id,
          ticketNumber: t.ticketNumber,
          fromSectionId: plan.qaSec.id,
          toSectionId: plan.mainSec.id,
          fromVersion: f.qaVersion.version,
          toVersion: f.foldedAs.version,
          status: t.status,
        });
      }
    }
    console.log('');
    console.log(`Tasks to rewrite (sectionId+version): ${taskRewrites.length}`);
    for (const r of taskRewrites.slice(0, 5)) {
      console.log(`  #${r.ticketNumber} (${r.status})  ${r.fromSectionId}/v${r.fromVersion}  →  ${r.toSectionId}/v${r.toVersion}`);
    }
    if (taskRewrites.length > 5) console.log(`  ... ${taskRewrites.length - 5} more`);

    // Tasks that won't be rewritten (would be orphaned by QA section deletion)
    const orphaned = (store.tasks || []).filter(t =>
      t.projectId === plan.project.id &&
      t.sectionId === plan.qaSec.id &&
      !t.isArchived &&
      !taskRewrites.some(r => r.taskId === t.id)
    );
    if (orphaned.length > 0) {
      console.log('');
      console.log(`ℹ️  ${orphaned.length} active task(s) on the QA section have no version-fold match (typically v=null adhoc tasks).`);
      console.log(`   They will be re-pointed at the Main section (sectionId only) so they aren't orphaned. Their version field is left untouched.`);
      for (const t of orphaned) {
        console.log(`    #${t.ticketNumber} v=${t.version} status=${t.status} "${(t.title || '').slice(0, 50)}"  →  Main`);
        taskRewrites.push({
          taskId: t.id,
          ticketNumber: t.ticketNumber,
          fromSectionId: plan.qaSec.id,
          toSectionId: plan.mainSec.id,
          fromVersion: t.version || null,
          toVersion: t.version || null, // unchanged
          status: t.status,
          isUnversionedRescue: true,
        });
      }
    }
    plan.taskRewrites = taskRewrites;
    plan.orphaned = orphaned;
  }

  // Test projects
  if (deleteTest) {
    logHeader(`Test-project deletion plan`);
    for (const id of TEST_PROJECT_IDS) {
      const p = (store.projects || []).find(x => x.id === id);
      if (!p) {
        console.log(`  ${id} — not found, skip`);
        continue;
      }
      const tcount = (store.tasks || []).filter(t => t.projectId === id).length;
      console.log(`  ${id} "${p.name}" — DELETE (active tasks: ${(store.tasks || []).filter(t => t.projectId === id && !t.isArchived).length}, total: ${tcount})`);
    }
  }

  if (isDryRun) {
    logHeader('DRY-RUN — no writes performed.');
    console.log('Re-run with --execute to apply.');
    return;
  }

  // ---- EXECUTE PATH ----
  // Snapshot first.
  const backupDir = path.join(ROOT, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  for (const plan of plans) {
    if (plan.error) continue;
    const tstamp = ts();
    const snap = path.join(backupDir, `pre-versioned-ownership-${plan.project.id}-${tstamp}.json`);
    const diff = path.join(backupDir, `pre-versioned-ownership-${plan.project.id}-${tstamp}-diff.json`);
    const projectSnapshot = JSON.parse(JSON.stringify(plan.project));
    const taskSnapshots = (plan.taskRewrites || []).map(r => {
      return JSON.parse(JSON.stringify((store.tasks || []).find(t => t.id === r.taskId)));
    });
    fs.writeFileSync(snap, JSON.stringify({ project: projectSnapshot, tasks: taskSnapshots }, null, 2));
    fs.writeFileSync(diff, JSON.stringify({
      mode: 'pre-state',
      projectId: plan.project.id,
      sections_before: plan.project.sections || plan.project.components,
      taskRewrites: plan.taskRewrites,
    }, null, 2));
    console.log(`Snapshot: ${snap}`);
    console.log(`Diff: ${diff}`);
  }

  for (const plan of plans) {
    if (plan.error) continue;
    logHeader(`EXECUTE ${plan.project.id}`);
    // 1. Update Main section to include the new folded versions
    const mainNew = JSON.parse(JSON.stringify(plan.mainSec));
    mainNew.versions = (mainNew.versions || []).slice();
    for (const f of plan.folds) {
      if (f.error) continue;
      mainNew.versions.push(f.foldedAs);
    }
    mainNew.versions.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

    // 2. Build new sections array (drop QA section, replace Main)
    const oldSections = plan.project.sections || plan.project.components || [];
    const newSections = oldSections
      .filter(s => s.id !== plan.qaSec.id)
      .map(s => s.id === plan.mainSec.id ? mainNew : s);

    // Determine which top-level field name the project uses
    const fieldName = plan.project.sections ? 'sections' : 'components';

    const updates = { [fieldName]: newSections };
    console.log(`Updating project sections (${fieldName}: ${newSections.length} sections, was ${oldSections.length})...`);
    await api('/api/store', {
      method: 'POST',
      body: JSON.stringify({ action: 'updateProject', id: plan.project.id, updates }),
    });

    // 3. Rewrite affected tasks (sectionId + version)
    let ok = 0, fail = 0;
    for (const r of plan.taskRewrites || []) {
      try {
        const updates = { sectionId: r.toSectionId };
        if (r.toVersion !== r.fromVersion && r.toVersion != null) {
          updates.version = r.toVersion;
        }
        await api('/api/store', {
          method: 'POST',
          body: JSON.stringify({
            action: 'updateTask',
            id: r.taskId,
            updates,
          }),
        });
        ok++;
      } catch (e) {
        console.error(`  task #${r.ticketNumber} rewrite failed:`, e.message);
        fail++;
      }
    }
    console.log(`Tasks rewritten: ${ok} OK / ${fail} failed`);
  }

  if (deleteTest) {
    logHeader('Deleting test projects');
    for (const id of TEST_PROJECT_IDS) {
      const p = (store.projects || []).find(x => x.id === id);
      if (!p) continue;
      try {
        await api('/api/store', {
          method: 'POST',
          body: JSON.stringify({ action: 'deleteProject', id }),
        });
        console.log(`  ✓ deleted ${id}`);
      } catch (e) {
        console.error(`  ✗ delete ${id} failed: ${e.message}`);
      }
    }
  }

  logHeader('EXECUTE complete.');
}

// #1312 guard: only auto-run when invoked as a script. When imported by
// another module (e.g. server.mjs), do NOT trigger main() — let the
// caller decide. Prevents one Postgres hiccup from killing the dashboard.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => {
    console.error('Migration failed:', e);
    process.exit(1);
  });
}
