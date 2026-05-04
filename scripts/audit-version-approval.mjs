#!/usr/bin/env node
/**
 * #1211: audit-version-approval.mjs
 *
 * Read-only audit of version-approval consistency across active tasks.
 *
 * For each non-done, non-archived task, flag and group by project:
 *   - INCONSISTENT     : adhoc taskType (bug/chore/followup/spike) AND version is set
 *   - ORPHAN VERSION   : task.version not present in org_studio_roadmap_versions
 *                        (project_id, version)
 *   - OUT OF HORIZON   : task.version > matching component.approvedThrough
 *                        (when project.data.components[] has the component)
 *
 * Usage:
 *   node scripts/audit-version-approval.mjs
 */

import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env.local without dotenv dep
const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = val;
  }
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set; cannot run audit.');
  process.exit(0);
}

const ADHOC_TYPES = new Set(['bug', 'chore', 'followup', 'spike']);

function parseSemver(v) {
  if (typeof v !== 'string') return null;
  const m = v.match(/^v?(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
}

function cmpSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  const { rows: tasks } = await client.query(
    `SELECT id, ticket_number, title, status, project_id, assignee, data
       FROM org_studio_tasks
      WHERE status <> 'done'`
  );
  const { rows: projects } = await client.query(
    `SELECT id, name, data FROM org_studio_projects`
  );
  const { rows: rvs } = await client.query(
    `SELECT project_id, version FROM org_studio_roadmap_versions`
  );

  const projectsById = new Map();
  for (const p of projects) {
    const data = typeof p.data === 'string' ? JSON.parse(p.data) : (p.data || {});
    projectsById.set(p.id, { id: p.id, name: p.name, data });
  }

  const versionsByProject = new Map();
  for (const r of rvs) {
    if (!versionsByProject.has(r.project_id)) versionsByProject.set(r.project_id, new Set());
    versionsByProject.get(r.project_id).add(r.version);
  }

  // findings[projectId] = { name, INCONSISTENT: [], ORPHAN: [], OUT_OF_HORIZON: [] }
  const findings = new Map();
  function bucket(projId, kind, item) {
    const proj = projectsById.get(projId);
    const name = proj?.name || `(unknown project ${projId})`;
    if (!findings.has(projId)) {
      findings.set(projId, { name, INCONSISTENT: [], ORPHAN: [], OUT_OF_HORIZON: [] });
    }
    findings.get(projId)[kind].push(item);
  }

  let totalScanned = 0;
  let totalFlagged = 0;

  for (const t of tasks) {
    const overflow = typeof t.data === 'string' ? JSON.parse(t.data) : (t.data || {});
    if (overflow.isArchived) continue;
    totalScanned++;

    const taskType = overflow.taskType;
    const version = overflow.version;
    const sectionId = overflow.sectionId;
    const tag = `#${t.ticket_number || t.id} ${t.title || ''}`.trim();
    let flaggedHere = false;

    if (version && taskType && ADHOC_TYPES.has(taskType)) {
      bucket(t.project_id, 'INCONSISTENT', `${tag} [taskType=${taskType}, version=${version}]`);
      flaggedHere = true;
    }

    if (version) {
      const versSet = versionsByProject.get(t.project_id);
      if (!versSet || !versSet.has(version)) {
        bucket(t.project_id, 'ORPHAN', `${tag} [version=${version}]`);
        flaggedHere = true;
      }
    }

    if (version) {
      const proj = projectsById.get(t.project_id);
      const components = Array.isArray(proj?.data?.components) ? proj.data.components : [];
      if (components.length) {
        const cmp = sectionId
          ? components.find((c) => c.id === sectionId)
          : components[0];
        const approvedThrough = cmp?.approvedThrough;
        if (approvedThrough && cmpSemver(version, approvedThrough) > 0) {
          bucket(
            t.project_id,
            'OUT_OF_HORIZON',
            `${tag} [version=${version} > approvedThrough=${approvedThrough}${sectionId ? `, section=${sectionId}` : ''}]`,
          );
          flaggedHere = true;
        }
      }
    }

    if (flaggedHere) totalFlagged++;
  }

  console.log('=== #1211 version-approval audit ===');
  console.log(`Active tasks scanned: ${totalScanned}`);
  console.log(`Tasks flagged       : ${totalFlagged}`);
  console.log('');

  if (findings.size === 0) {
    console.log('No findings. Clean.');
  } else {
    let totalIncon = 0, totalOrphan = 0, totalHorizon = 0;
    const sorted = [...findings.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
    for (const [projId, f] of sorted) {
      console.log(`---- Project: ${f.name} (${projId}) ----`);
      if (f.INCONSISTENT.length) {
        console.log(`  INCONSISTENT (adhoc + version): ${f.INCONSISTENT.length}`);
        for (const line of f.INCONSISTENT) console.log(`    - ${line}`);
        totalIncon += f.INCONSISTENT.length;
      }
      if (f.ORPHAN.length) {
        console.log(`  ORPHAN VERSION (no roadmap row): ${f.ORPHAN.length}`);
        for (const line of f.ORPHAN) console.log(`    - ${line}`);
        totalOrphan += f.ORPHAN.length;
      }
      if (f.OUT_OF_HORIZON.length) {
        console.log(`  OUT OF HORIZON (> approvedThrough): ${f.OUT_OF_HORIZON.length}`);
        for (const line of f.OUT_OF_HORIZON) console.log(`    - ${line}`);
        totalHorizon += f.OUT_OF_HORIZON.length;
      }
      console.log('');
    }
    console.log('=== Totals ===');
    console.log(`  INCONSISTENT   : ${totalIncon}`);
    console.log(`  ORPHAN VERSION : ${totalOrphan}`);
    console.log(`  OUT OF HORIZON : ${totalHorizon}`);
  }

  await client.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('Audit failed:', err?.message || err);
  process.exit(0);
});
