#!/usr/bin/env node
/**
 * backfill-version-owner.mjs (#1214)
 *
 * Populate org_studio_roadmap_versions.owner for existing rows.
 *
 * Logic
 * -----
 * For every project, for every roadmap-version row whose `owner` IS NULL, set
 * owner = the owning component's owner (the component identified by the
 * project's components[]/sections[] tree). Idempotent: re-running is a no-op
 * once all rows carry a non-null owner.
 *
 * Resolving "owning component" for an rv-table row
 * ------------------------------------------------
 * The rv-table doesn't carry a section/component id. We mirror the read-side
 * hydration rule: rv rows belong to the project's *primary* component
 * (first component whose role is not 'qa' or 'support', else components[0]).
 * That matches the same rule store-provider.hydrateComponentVersions and
 * scripts/hydrate-component-versions.mjs use.
 *
 * Usage
 * -----
 *   node scripts/backfill-version-owner.mjs --dry-run   # preview
 *   node scripts/backfill-version-owner.mjs             # apply
 */

import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

const DRY_RUN = process.argv.includes('--dry-run');
const DATABASE_URL = process.env.DATABASE_URL || (() => {
  try {
    const env = fs.readFileSync(path.resolve('.env.local'), 'utf8');
    return env.split('\n').find(l => l.startsWith('DATABASE_URL='))?.split('=').slice(1).join('=');
  } catch {
    return undefined;
  }
})();

const WORKSPACE = 'default-workspace';

if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

function isPrimary(comp) {
  if (!comp || !comp.role) return true;
  const r = String(comp.role).toLowerCase();
  return r !== 'qa' && r !== 'support';
}

function pickPrimaryComponent(data) {
  const comps = (data?.components && data.components.length > 0)
    ? data.components
    : (data?.sections || []);
  if (!comps.length) return undefined;
  return comps.find(isPrimary) || comps[0];
}

const pool = new Pool({ connectionString: DATABASE_URL });

async function main() {
  const client = await pool.connect();
  try {
    console.log(DRY_RUN ? '🔍 DRY-RUN — no writes' : '🔧 APPLY — committing changes');
    console.log('');

    // Before count
    const beforeRes = await client.query(
      `SELECT COUNT(*)::int AS n FROM org_studio_roadmap_versions
        WHERE workspace_id = $1 AND owner IS NULL`,
      [WORKSPACE],
    );
    const beforeNull = beforeRes.rows[0].n;

    const totalRes = await client.query(
      `SELECT COUNT(*)::int AS n FROM org_studio_roadmap_versions WHERE workspace_id = $1`,
      [WORKSPACE],
    );
    const total = totalRes.rows[0].n;

    console.log(`📊 Before: ${beforeNull} / ${total} rows have NULL owner`);
    console.log('');

    if (beforeNull === 0) {
      console.log('✅ Nothing to do — all rows already carry an owner.');
      return;
    }

    // Read all projects
    const projRes = await client.query(
      `SELECT id, name, data FROM org_studio_projects WHERE workspace_id = $1`,
      [WORKSPACE],
    );

    let totalUpdated = 0;
    for (const projRow of projRes.rows) {
      const data = typeof projRow.data === 'string' ? JSON.parse(projRow.data) : (projRow.data || {});
      if (data?.isArchived) continue;

      const primary = pickPrimaryComponent(data);
      if (!primary) continue;
      const componentOwner = (primary.owner && String(primary.owner).trim().length > 0)
        ? String(primary.owner).trim()
        : null;
      if (!componentOwner) continue; // nothing to inherit

      // How many NULL-owner rows does this project have?
      const peek = await client.query(
        `SELECT COUNT(*)::int AS n FROM org_studio_roadmap_versions
          WHERE workspace_id = $1 AND project_id = $2 AND owner IS NULL`,
        [WORKSPACE, projRow.id],
      );
      const willUpdate = peek.rows[0].n;
      if (willUpdate === 0) continue;

      console.log(`  ${(projRow.name || projRow.id).padEnd(36)} → ${willUpdate} row(s) → owner='${componentOwner}'`);
      totalUpdated += willUpdate;

      if (!DRY_RUN) {
        await client.query(
          `UPDATE org_studio_roadmap_versions
              SET owner = $1
            WHERE workspace_id = $2 AND project_id = $3 AND owner IS NULL`,
          [componentOwner, WORKSPACE, projRow.id],
        );
      }
    }

    console.log('');
    console.log(`📦 ${DRY_RUN ? 'Would update' : 'Updated'} ${totalUpdated} row(s) across ${projRes.rows.length} projects.`);

    if (!DRY_RUN) {
      const afterRes = await client.query(
        `SELECT COUNT(*)::int AS n FROM org_studio_roadmap_versions
          WHERE workspace_id = $1 AND owner IS NULL`,
        [WORKSPACE],
      );
      const afterNull = afterRes.rows[0].n;
      console.log(`📊 After:  ${afterNull} / ${total} rows have NULL owner`);
      if (afterNull > 0) {
        console.log('   (remaining nulls = projects whose primary component has no owner set; ignore)');
      }
    } else {
      console.log('');
      console.log('Re-run without --dry-run to apply.');
    }
  } finally {
    client.release();
    await pool.end();
  }
}

// #1312 guard: only auto-run when invoked as a script. When imported by
// another module (e.g. server.mjs), do NOT trigger main() — let the
// caller decide. Prevents one Postgres hiccup from killing the dashboard.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
