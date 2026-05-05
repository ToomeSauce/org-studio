#!/usr/bin/env node
/**
 * scripts/migrate-remove-approvedthrough.js
 *
 * Ticket #1224 — Remove the legacy `approvedThrough` scalar from all
 * components and project autonomy blocks. After this runs, the only
 * approval source of truth is `approvedVersions[]`.
 *
 * Pre-conditions surveyed (2026-05-04):
 *   - Every component that has `approvedThrough` ALSO has `approvedVersions[]`
 *     populated (the #1188 auto-mirror ensured this).
 *   - One project (Thrivor / zrrt51fgmn578ujz) has a stale
 *     `autonomy.approvedThrough` field at the project level — drop it too.
 *
 * If any component is found with `approvedThrough` but no `approvedVersions[]`,
 * synthesize the list as every version on the component <= approvedThrough
 * (numeric part-by-part compare). This is the safety-net path; current data
 * shouldn't hit it, but the script must handle it correctly.
 *
 * Idempotent. Two flags: --dry-run (default) and --apply.
 *
 * Usage:
 *   node scripts/migrate-remove-approvedthrough.js --dry-run
 *   node scripts/migrate-remove-approvedthrough.js --apply
 */

const path = require('path');
const fs = require('fs');

const envPath = path.resolve(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const API = 'http://localhost:4501/api/store';
const TOKEN = process.env.ORG_STUDIO_API_KEY || '8ce80b4d1379aed97fcd4d75c4a53562';

const APPLY = process.argv.includes('--apply');
const log = (...a) => console.log(...a);
const banner = (s) => log('\n=== ' + s + ' ===');

// Numeric part-by-part compare (mirrors src/lib/version-utils.ts compareVersions
// well enough for the synthesis fallback path).
function cmpVersions(a, b) {
  const ap = String(a).split('.').map((s) => parseInt(s, 10));
  const bp = String(b).split('.').map((s) => parseInt(s, 10));
  const len = Math.max(ap.length, bp.length);
  for (let i = 0; i < len; i++) {
    const x = Number.isFinite(ap[i]) ? ap[i] : 0;
    const y = Number.isFinite(bp[i]) ? bp[i] : 0;
    if (x !== y) return x - y;
  }
  return 0;
}

async function api(action, payload) {
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ action, ...payload }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`API ${action} failed: HTTP ${r.status} ${t.slice(0, 300)}`);
  }
  return r.json();
}

async function fetchStore() {
  const r = await fetch(API);
  return r.json();
}

async function main() {
  log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  const store = await fetchStore();

  // 1. Components
  banner('COMPONENTS');
  const componentTouches = [];
  for (const project of store.projects || []) {
    const comps = project.sections || project.components || [];
    for (const cmp of comps) {
      if (!cmp.approvedThrough) continue;
      const hasList = Array.isArray(cmp.approvedVersions) && cmp.approvedVersions.length > 0;
      let synthesized = null;
      if (!hasList) {
        // safety-net synthesis
        synthesized = (cmp.versions || [])
          .map((v) => v.version)
          .filter((v) => cmpVersions(v, cmp.approvedThrough) <= 0);
      }
      componentTouches.push({
        projectId: project.id,
        componentId: cmp.id,
        approvedThrough: cmp.approvedThrough,
        approvedVersionsCount: hasList ? cmp.approvedVersions.length : 0,
        synthesized,
      });
    }
  }
  log(`Components with approvedThrough to clear: ${componentTouches.length}`);
  let synthCount = 0;
  for (const t of componentTouches) {
    if (t.synthesized) {
      synthCount++;
      log(`  SYNTHESIZE ${t.projectId}/${t.componentId}: AT=${t.approvedThrough} → approvedVersions=[${t.synthesized.join(',')}]`);
    } else {
      log(`  CLEAR     ${t.projectId}/${t.componentId}: AT=${t.approvedThrough} (already has approvedVersions[${t.approvedVersionsCount}])`);
    }
  }
  log(`Synthesis needed: ${synthCount} | clean clears: ${componentTouches.length - synthCount}`);

  if (APPLY) {
    for (const t of componentTouches) {
      const updates = { approvedThrough: null };
      if (t.synthesized) updates.approvedVersions = t.synthesized;
      await api('updateComponent', { projectId: t.projectId, componentId: t.componentId, updates });
    }
    log(`  → applied ${componentTouches.length} component updates`);
  }

  // 2. Project-level autonomy.approvedThrough
  banner('PROJECT autonomy.approvedThrough');
  const projectTouches = [];
  for (const project of store.projects || []) {
    const a = project.autonomy || {};
    if (a.approvedThrough) {
      projectTouches.push({ id: project.id, value: a.approvedThrough });
    }
  }
  log(`Projects with autonomy.approvedThrough: ${projectTouches.length}`);
  for (const p of projectTouches) log(`  CLEAR ${p.id}: ${p.value}`);

  if (APPLY) {
    for (const p of projectTouches) {
      const proj = (store.projects || []).find((x) => x.id === p.id);
      const newAutonomy = { ...(proj.autonomy || {}) };
      delete newAutonomy.approvedThrough;
      await api('updateProject', { id: p.id, updates: { autonomy: newAutonomy } });
    }
    log(`  → applied ${projectTouches.length} project updates`);
  }

  banner('DONE');
  log(APPLY ? 'Applied. Re-run --dry-run to confirm idempotency.' : 'Dry-run complete. Re-run with --apply to commit.');
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
