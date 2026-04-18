#!/usr/bin/env node
/**
 * reconcile-project-integrity.mjs — One-shot repair of project integrity violations (#697)
 *
 * Usage:
 *   node scripts/reconcile-project-integrity.mjs           # dry-run (default)
 *   node scripts/reconcile-project-integrity.mjs --apply   # execute fixes
 *
 * Env:
 *   ORG_STUDIO_API_KEY  — Required for --apply (POST to /api/store)
 *   BASE_URL            — Defaults to http://localhost:4501
 *
 * Logic:
 *   1. Fetches all projects via GET /api/store
 *   2. For each non-archived project with empty versions[] or unset autoAdvance:
 *      - Adds a blank v0.1 planned row
 *      - Sets autoAdvance = true
 *      - Sets approvedThrough = null (if undefined)
 *   3. Does NOT touch projects that already have roadmaps (versions.length > 0)
 *   4. Fixes ALL violators including test projects
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:4501';
const API_KEY = process.env.ORG_STUDIO_API_KEY || '';
const apply = process.argv.includes('--apply');

async function main() {
  console.log(`\n🔍 Project Integrity Reconciliation (${apply ? 'APPLY' : 'DRY-RUN'})`);
  console.log(`   Base URL: ${BASE_URL}\n`);

  // 1. Fetch all projects
  const res = await fetch(`${BASE_URL}/api/store`);
  if (!res.ok) {
    console.error(`❌ Failed to fetch store: HTTP ${res.status}`);
    process.exit(1);
  }
  const store = await res.json();
  const projects = store.projects || [];

  let fixed = 0;
  let skipped = 0;

  for (const project of projects) {
    if (project.isArchived) continue;

    const hasRoadmap = Array.isArray(project.versions) && project.versions.length > 0;
    const needsAutoAdvance = project.autoAdvance === undefined || project.autoAdvance === null;
    const needsApprovedThrough = project.approvedThrough === undefined;

    if (hasRoadmap && !needsAutoAdvance && !needsApprovedThrough) {
      skipped++;
      continue;
    }

    // Build updates
    const updates = {};
    const fixes = [];

    if (!hasRoadmap) {
      const versionId = 'rv-' + project.id + '-v0-1';
      updates.versions = [{
        id: versionId,
        version: '0.1',
        title: '',
        status: 'planned',
        items: [],
        sort_order: 0.1,
        version_type: 'outcome',
      }];
      fixes.push('add v0.1 planned row');
    }

    if (needsAutoAdvance) {
      updates.autoAdvance = true;
      fixes.push('set autoAdvance=true');
    }

    if (needsApprovedThrough) {
      updates.approvedThrough = null;
      fixes.push('set approvedThrough=null');
    }

    if (fixes.length === 0) {
      skipped++;
      continue;
    }

    if (!apply) {
      console.log(`[dry-run] Would fix ${project.id} (${project.name}): ${fixes.join(', ')}`);
      fixed++;
      continue;
    }

    // Apply: POST updateProject
    if (!API_KEY) {
      console.error('❌ --apply requires ORG_STUDIO_API_KEY env var');
      process.exit(1);
    }

    try {
      const updateRes = await fetch(`${BASE_URL}/api/store`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          action: 'updateProject',
          id: project.id,
          updates,
        }),
      });

      if (!updateRes.ok) {
        const body = await updateRes.text();
        console.error(`❌ Failed to update ${project.id}: HTTP ${updateRes.status} — ${body}`);
        continue;
      }

      console.log(`✅ Fixed ${project.id} (${project.name}): ${fixes.join(', ')}`);
      fixed++;
    } catch (e) {
      console.error(`❌ Error updating ${project.id}:`, e.message);
    }
  }

  console.log(`\n📊 Summary: Fixed ${fixed} project(s), skipped ${skipped} with existing roadmaps.`);
  if (!apply && fixed > 0) {
    console.log('   Run with --apply to execute fixes.\n');
  }
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
