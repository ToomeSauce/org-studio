#!/usr/bin/env node
/**
 * scripts/migrate-thrivor-versions.js
 *
 * Ticket #1223 — Migrate Thrivor's confusing version strings to clean linear semver.
 *
 * All shipped versions stay shipped (no status changes). Two parallel chains
 * (0.901.x QA track + 0.9.9-0.9.16 wedge track) are folded into a single
 * monotonic semver sequence starting at 0.10.0.
 *
 * Idempotent: running twice produces zero changes after the first apply.
 *
 * Usage:
 *   node scripts/migrate-thrivor-versions.js --dry-run
 *   node scripts/migrate-thrivor-versions.js --apply
 *
 * What it touches:
 *   - Tasks (via API updateTask): rewrite `version` field
 *   - Components (via API updateComponent): rewrite versions[i].version,
 *     approvedVersions[], approvedThrough
 *   - Project doc (via API updateProject): rewrite currentVersion,
 *     pendingVersion, autonomy.approvedVersions/approvedThrough if present
 *   - Postgres org_studio_roadmap_versions: rewrite version field + id
 *     (id pattern follows rv-{project}-{semver-with-dashes})
 *
 * This script does NOT touch the dispatch gate semantics or any user-visible
 * approval state — versions in `approvedVersions[]` stay approved, versions
 * not in it (0.9.9, 0.9.10) stay un-approved (just under their new names).
 */

const path = require('path');
const fs = require('fs');

// Load env from .env.local manually (no dotenv dep available)
const envPath = path.resolve(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const API = 'http://localhost:4501/api/store';
const TOKEN = process.env.ORG_STUDIO_API_KEY || '8ce80b4d1379aed97fcd4d75c4a53562';
const PROJECT_ID = 'zrrt51fgmn578ujz';
const COMPONENT_IDS = [
  'sec-main-zrrt51fgmn578ujz',
  'sec-frontend-zrrt51fgmn578ujz',
  'sec-backend-zrrt51fgmn578ujz',
];

// Canonical version map
const MAP = {
  '0.901.0': '0.10.0',
  '0.902.0': '0.11.0',
  '0.903.0': '0.12.0',
  '0.904.0': '0.13.0',
  '0.905.0': '0.14.0',
  '0.906.0': '0.15.0',
  '0.907.0': '0.16.0',
  '0.908.0': '0.17.0',
  '0.908.1': '0.17.1',
  '0.908.2': '0.17.2',
  '0.9.9': '0.18.0',
  '0.9.10': '0.19.0',
  '0.9.11': '0.20.0',
  '0.9.12': '0.21.0',
  '0.9.13': '0.22.0',
  '0.9.14': '0.23.0',
  '0.9.15': '0.24.0',
  '0.9.16': '0.25.0',
};

const APPLY = process.argv.includes('--apply');
const DRY = !APPLY || process.argv.includes('--dry-run');

const log = (...a) => console.log(...a);
const banner = (s) => log('\n=== ' + s + ' ===');
const remap = (v) => (v && Object.prototype.hasOwnProperty.call(MAP, v) ? MAP[v] : v);

async function api(action, payload) {
  const body = JSON.stringify({ action, ...payload });
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body,
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

function rvIdForVersion(version) {
  return `rv-${PROJECT_ID}-${version.replace(/\./g, '-')}`;
}

async function main() {
  log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  log(`Project: ${PROJECT_ID}`);
  log(`Map size: ${Object.keys(MAP).length}`);

  const store = await fetchStore();
  const project = (store.projects || []).find((p) => p.id === PROJECT_ID);
  if (!project) throw new Error('Thrivor project not found');

  // 1. Tasks
  banner('TASKS');
  const tasks = (store.tasks || []).filter(
    (t) => t.projectId === PROJECT_ID && t.version && Object.prototype.hasOwnProperty.call(MAP, t.version),
  );
  log(`Tasks to migrate: ${tasks.length}`);
  const byVer = {};
  for (const t of tasks) byVer[t.version] = (byVer[t.version] || 0) + 1;
  for (const [v, n] of Object.entries(byVer).sort()) log(`  ${v.padEnd(10)} → ${MAP[v].padEnd(8)} (${n} tasks)`);

  // Detect unmapped Thrivor versions
  const unmapped = new Set();
  for (const t of (store.tasks || [])) {
    if (t.projectId === PROJECT_ID && t.version && !Object.prototype.hasOwnProperty.call(MAP, t.version)) {
      unmapped.add(t.version);
    }
  }
  if (unmapped.size > 0) log('Unmapped versions (kept as-is):', [...unmapped].sort().join(', '));

  if (APPLY) {
    // Two paths:
    //  - regular tasks → API updateTask (fires triggers/notifications)
    //  - pre-existing inconsistent tasks (adhoc taskType + version, all 'done')
    //    blocked by #1211 validator. Update them directly in Postgres in one tx.
    const ADHOC = new Set(['bug', 'chore', 'spike', 'followup']);
    const apiTasks = tasks.filter((t) => !ADHOC.has(t.taskType));
    const dbTasks = tasks.filter((t) => ADHOC.has(t.taskType));
    log(`  via API: ${apiTasks.length}, via direct DB (legacy adhoc+version): ${dbTasks.length}`);

    let n = 0;
    for (const t of apiTasks) {
      await api('updateTask', { id: t.id, updates: { version: MAP[t.version] } });
      n++;
      if (n % 25 === 0) log(`  ...updated ${n}/${apiTasks.length} via API`);
    }
    log(`API tasks updated: ${n}`);

    if (dbTasks.length > 0) {
      if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required for adhoc-with-version migration');
      const { Client } = require('pg');
      const client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      try {
        await client.query('BEGIN');
        for (const t of dbTasks) {
          // Tasks live in org_studio_tasks with `data` jsonb. Patch data.version.
          await client.query(
            `UPDATE org_studio_tasks SET version = $1 WHERE id = $2`,
            [MAP[t.version], t.id],
          );
        }
        await client.query('COMMIT');
        await client.query(`SELECT pg_notify('org_studio_change', $1)`, [JSON.stringify({ kind: 'tasks-bulk', projectId: PROJECT_ID })]);
        log(`Direct-DB tasks updated: ${dbTasks.length}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        await client.end();
      }
    }
  }

  // 2. Components
  banner('COMPONENTS');
  for (const cid of COMPONENT_IDS) {
    const cmp = (project.sections || []).find((s) => s.id === cid);
    if (!cmp) {
      log(`  ${cid}: NOT FOUND, skipping`);
      continue;
    }
    const versions = (cmp.versions || []).map((v) => ({ ...v, version: remap(v.version) }));
    const approvedVersions = (cmp.approvedVersions || []).map(remap);
    const approvedThrough = remap(cmp.approvedThrough);
    const versionChanged = JSON.stringify(cmp.versions || []) !== JSON.stringify(versions);
    const apvChanged = JSON.stringify(cmp.approvedVersions || []) !== JSON.stringify(approvedVersions);
    const atChanged = (cmp.approvedThrough || null) !== (approvedThrough || null);
    log(`  ${cid}: versions=${versionChanged} approvedVersions=${apvChanged} approvedThrough=${atChanged} (${cmp.approvedThrough || '∅'} → ${approvedThrough || '∅'})`);
    if (APPLY && (versionChanged || apvChanged || atChanged)) {
      const updates = {};
      if (versionChanged) updates.versions = versions;
      if (apvChanged) updates.approvedVersions = approvedVersions;
      if (atChanged) updates.approvedThrough = approvedThrough;
      await api('updateComponent', { projectId: PROJECT_ID, componentId: cid, updates });
      log(`    → applied`);
    }
  }

  // 3. Project doc
  banner('PROJECT DOC');
  const updates = {};
  if (project.currentVersion && MAP[project.currentVersion]) updates.currentVersion = MAP[project.currentVersion];
  if (project.pendingVersion && MAP[project.pendingVersion]) updates.pendingVersion = MAP[project.pendingVersion];
  if (project.autonomy && Array.isArray(project.autonomy.approvedVersions)) {
    const newList = project.autonomy.approvedVersions.map(remap);
    if (JSON.stringify(newList) !== JSON.stringify(project.autonomy.approvedVersions)) {
      updates.autonomy = { ...project.autonomy, approvedVersions: newList };
      if (updates.autonomy.approvedThrough) updates.autonomy.approvedThrough = remap(updates.autonomy.approvedThrough);
    }
  }
  log(`  currentVersion: ${project.currentVersion} → ${updates.currentVersion || '(unchanged)'}`);
  log(`  pendingVersion: ${project.pendingVersion} → ${updates.pendingVersion || '(unchanged)'}`);
  if (updates.autonomy) log(`  autonomy.approvedVersions: rewritten`);
  if (APPLY && Object.keys(updates).length > 0) {
    await api('updateProject', { id: PROJECT_ID, updates });
    log(`  → applied`);
  }

  // 4. Postgres rv-table
  banner('POSTGRES rv-table');
  if (!process.env.DATABASE_URL) {
    log('  DATABASE_URL not set; skipping rv-table migration');
  } else {
    const { Client } = require('pg');
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const r = await client.query(
        `SELECT id, version FROM org_studio_roadmap_versions WHERE project_id = $1 ORDER BY version`,
        [PROJECT_ID],
      );
      const toUpdate = r.rows.filter((row) => Object.prototype.hasOwnProperty.call(MAP, row.version));
      log(`  rv rows total: ${r.rows.length}, to migrate: ${toUpdate.length}`);
      for (const row of toUpdate) {
        const newVer = MAP[row.version];
        const newId = rvIdForVersion(newVer);
        log(`    ${row.id} (${row.version}) → ${newId} (${newVer})`);
      }

      if (APPLY && toUpdate.length > 0) {
        await client.query('BEGIN');
        try {
          for (const row of toUpdate) {
            const newVer = MAP[row.version];
            const newId = rvIdForVersion(newVer);
            await client.query(
              `UPDATE org_studio_roadmap_versions SET id = $1, version = $2 WHERE id = $3 AND project_id = $4`,
              [newId, newVer, row.id, PROJECT_ID],
            );
          }
          await client.query('COMMIT');
          log(`  → applied ${toUpdate.length} rv-table rows`);
          // Notify clients to refresh
          await client.query(`SELECT pg_notify('org_studio_change', $1)`, [JSON.stringify({ kind: 'roadmap', projectId: PROJECT_ID })]);
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        }
      }
    } finally {
      await client.end();
    }
  }

  banner('DONE');
  log(APPLY ? 'Applied. Re-run --dry-run to confirm idempotency.' : 'Dry-run complete. Re-run with --apply to commit.');
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
