#!/usr/bin/env node
/**
 * migrate-per-component-roadmaps.mjs  (#1112 PR 6)
 *
 * One-shot migration: flatten legacy project-level roadmap/horizon/component-
 * level waitsFor into the per-component shape introduced by PR 3:
 *
 *   project.versions[]                     → primaryComponent.versions[]
 *   project.autonomy.approvedThrough       → primaryComponent.approvedThrough
 *   component.waitsFor[]                   → for every existing version on
 *                                            that component, copy waitsFor[0]
 *                                            into version.waitsFor. If the
 *                                            component has no versions yet,
 *                                            we drop the legacy field and
 *                                            leave the user to create versions
 *                                            manually per the skill doc.
 *
 * Idempotent — safe to re-run. A project is considered already migrated
 * when:
 *   • project.versions is absent OR empty, AND
 *   • project.autonomy.approvedThrough is absent, AND
 *   • no component has a top-level waitsFor array.
 *
 * Pre-mutation snapshot saved to
 *   /backups/pre-components-migration-<ISO-ts>.json
 *
 * Invoke: node scripts/migrate-per-component-roadmaps.mjs [--dry-run]
 *
 * Flags:
 *   --dry-run   read + plan only; prints the diff per project, no writes
 *
 * Rollback: restore the pre-migration snapshot into the org_studio_projects
 * table (jsonb column `data`) for the rows listed in the snapshot, or
 * restore store.json from /backups if running file-mode.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

const DATABASE_URL = process.env.DATABASE_URL;
const DRY_RUN = process.argv.includes('--dry-run');

/** Pick the primary component: first non-QA, non-support component. */
function getPrimaryComponent(project) {
  const comps = Array.isArray(project.components) && project.components.length > 0
    ? project.components
    : Array.isArray(project.sections) ? project.sections : [];
  return comps.find((c) => !c.role || (c.role !== 'qa' && c.role !== 'support')) || comps[0];
}

/** Does this project still carry legacy fields? */
function needsMigration(project) {
  const hasProjectVersions = Array.isArray(project.versions) && project.versions.length > 0;
  const hasLegacyHorizon = !!(project.autonomy && project.autonomy.approvedThrough);
  const comps = Array.isArray(project.components) ? project.components : [];
  const hasComponentWaitsFor = comps.some((c) => Array.isArray(c.waitsFor) && c.waitsFor.length > 0);
  return hasProjectVersions || hasLegacyHorizon || hasComponentWaitsFor;
}

/**
 * Transform a project record. Returns { after, changes[] } — never
 * mutates the input.
 */
function migrateProject(project) {
  const changes = [];
  // Deep-clone to keep the snapshot honest.
  const p = JSON.parse(JSON.stringify(project));
  const comps = Array.isArray(p.components) && p.components.length > 0
    ? p.components
    : Array.isArray(p.sections) ? p.sections : null;

  if (!comps || comps.length === 0) {
    // No components at all — nothing to migrate into. Drop legacy fields;
    // the project will render using the "no components" fallback in the UI.
    if (Array.isArray(p.versions) && p.versions.length > 0) {
      changes.push({ kind: 'drop-project-versions-no-components', count: p.versions.length });
      delete p.versions;
    }
    if (p.autonomy && 'approvedThrough' in p.autonomy) {
      changes.push({ kind: 'drop-legacy-horizon-no-components', value: p.autonomy.approvedThrough });
      delete p.autonomy.approvedThrough;
    }
    return { after: p, changes };
  }

  const primary = getPrimaryComponent(p);

  // 1) project.versions → primary.versions (only if primary has none of its own).
  if (Array.isArray(p.versions) && p.versions.length > 0) {
    if (Array.isArray(primary.versions) && primary.versions.length > 0) {
      changes.push({
        kind: 'skip-project-versions-primary-has-own',
        projectVersionCount: p.versions.length,
        primaryVersionCount: primary.versions.length,
        primaryId: primary.id,
      });
    } else {
      primary.versions = p.versions.map((v) => ({ ...v }));
      changes.push({
        kind: 'move-project-versions',
        from: 'project.versions',
        to: `components[${primary.id}].versions`,
        count: p.versions.length,
      });
    }
    delete p.versions;
  }

  // 2) project.autonomy.approvedThrough → primary.approvedThrough.
  if (p.autonomy && p.autonomy.approvedThrough) {
    if (primary.approvedThrough) {
      changes.push({
        kind: 'skip-horizon-primary-has-own',
        legacy: p.autonomy.approvedThrough,
        primary: primary.approvedThrough,
        primaryId: primary.id,
      });
    } else {
      primary.approvedThrough = p.autonomy.approvedThrough;
      changes.push({
        kind: 'move-horizon',
        from: 'project.autonomy.approvedThrough',
        to: `components[${primary.id}].approvedThrough`,
        value: p.autonomy.approvedThrough,
      });
    }
    delete p.autonomy.approvedThrough;
  }

  // 3) component.waitsFor[] → copy onto each existing version on that component.
  //    We copy the FIRST waitsFor entry (typical case: one dep per component)
  //    onto every existing version.waitsFor. If the component has no versions
  //    yet, the legacy waitsFor is simply dropped — the user (or a later
  //    manual step, e.g. Thrivor QA) defines versions + per-version waitsFor
  //    per the skill doc.
  for (const comp of comps) {
    if (!Array.isArray(comp.waitsFor) || comp.waitsFor.length === 0) continue;
    const firstDep = comp.waitsFor[0];
    if (Array.isArray(comp.versions) && comp.versions.length > 0) {
      let applied = 0;
      for (const v of comp.versions) {
        if (v.waitsFor) continue; // respect any already-set per-version dep
        v.waitsFor = { ...firstDep };
        applied++;
      }
      changes.push({
        kind: 'propagate-component-waitsFor-to-versions',
        componentId: comp.id,
        dep: firstDep,
        versionsUpdated: applied,
        versionsSkippedHaveOwn: comp.versions.length - applied,
      });
    } else {
      changes.push({
        kind: 'drop-orphan-component-waitsFor',
        componentId: comp.id,
        dep: firstDep,
        note: 'component has no versions; user must create versions per skill doc',
      });
    }
    delete comp.waitsFor;
  }

  return { after: p, changes };
}

async function runPostgres() {
  const { default: pg } = await import('pg');
  const { Pool } = pg;
  const pool = new Pool({ connectionString: DATABASE_URL });

  const { rows } = await pool.query('SELECT id, data FROM org_studio_projects');
  console.log(`[Migrate] Loaded ${rows.length} project rows from Postgres`);

  const snapshotDir = join(rootDir, 'backups');
  if (!existsSync(snapshotDir)) mkdirSync(snapshotDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotPath = join(snapshotDir, `pre-components-migration-${ts}.json`);

  const preSnapshot = [];
  const results = [];

  for (const row of rows) {
    const p = row.data;
    preSnapshot.push({ id: row.id, data: p });
    if (!needsMigration(p)) {
      results.push({ id: row.id, name: p.name, skipped: true, reason: 'already migrated' });
      continue;
    }
    const { after, changes } = migrateProject(p);
    results.push({ id: row.id, name: p.name, skipped: false, changes });
    if (!DRY_RUN) {
      await pool.query('UPDATE org_studio_projects SET data = $1 WHERE id = $2', [after, row.id]);
    }
  }

  if (!DRY_RUN) {
    writeFileSync(snapshotPath, JSON.stringify(preSnapshot, null, 2));
    console.log(`[Migrate] Pre-migration snapshot saved → ${snapshotPath}`);
  } else {
    console.log(`[Migrate] DRY-RUN — no writes, no snapshot saved`);
  }

  await pool.end();
  return results;
}

async function runFile() {
  const storePath = join(rootDir, 'data', 'store.json');
  if (!existsSync(storePath)) {
    console.log('[Migrate] No DATABASE_URL and no data/store.json — nothing to do');
    return [];
  }
  const store = JSON.parse(readFileSync(storePath, 'utf8'));
  const snapshotDir = join(rootDir, 'backups');
  if (!existsSync(snapshotDir)) mkdirSync(snapshotDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotPath = join(snapshotDir, `pre-components-migration-${ts}.json`);

  const results = [];
  const nextProjects = store.projects.map((p) => {
    if (!needsMigration(p)) {
      results.push({ id: p.id, name: p.name, skipped: true, reason: 'already migrated' });
      return p;
    }
    const { after, changes } = migrateProject(p);
    results.push({ id: p.id, name: p.name, skipped: false, changes });
    return after;
  });

  if (!DRY_RUN) {
    writeFileSync(snapshotPath, JSON.stringify(store, null, 2));
    store.projects = nextProjects;
    writeFileSync(storePath, JSON.stringify(store, null, 2));
    console.log(`[Migrate] Pre-migration snapshot saved → ${snapshotPath}`);
    console.log(`[Migrate] Wrote migrated store → ${storePath}`);
  } else {
    console.log(`[Migrate] DRY-RUN — no writes, no snapshot saved`);
  }

  return results;
}

async function main() {
  console.log(`[Migrate] per-component roadmaps — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  const results = DATABASE_URL ? await runPostgres() : await runFile();

  const migrated = results.filter((r) => !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  console.log(`\n[Migrate] ${migrated.length} project(s) migrated, ${skipped.length} already up-to-date`);
  for (const r of migrated) {
    console.log(`  • ${r.name} (${r.id})`);
    for (const c of r.changes) {
      console.log(`      - ${c.kind}${c.value ? `: ${c.value}` : c.count ? ` × ${c.count}` : c.componentId ? ` (${c.componentId})` : ''}`);
    }
  }
  if (skipped.length && process.env.VERBOSE) {
    console.log('\nSkipped (already migrated):');
    for (const r of skipped) console.log(`  • ${r.name} (${r.id})`);
  }
}

main().catch((e) => {
  console.error('[Migrate] FAILED:', e);
  process.exit(1);
});

// Exported for tests.
export { migrateProject, needsMigration, getPrimaryComponent };
