#!/usr/bin/env node
/**
 * audit-semver.mjs
 * 
 * Pre-migration validation: shows exactly what will change, detects issues, zero writes.
 * 
 * Usage:
 *   node scripts/audit-semver.mjs
 * 
 * Output:
 *   - Mapping of all version string changes
 *   - Orphaned reference detection
 *   - Sortability validation
 *   - Risk assessment
 *   - Detailed per-project report
 */

const port = process.env.PORT || 4501;
const apiKey = process.env.ORG_STUDIO_API_KEY || '';

const headers = { 'Content-Type': 'application/json' };
if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

// Semver migration map
const SEMVER_MAP = {
  'v0.1': '0.1.0',
  'v0.14': '0.14.0',
  'v0.141': '0.14.1',
  'v0.15': '0.15.0',
  'v0.16': '0.16.0',
  'v0.17': '0.17.0',
  'v1.0': '1.0.0',
  'v1.1': '1.1.0',
  '0.1': '0.1.0',
  '0.14': '0.14.0',
  '0.141': '0.14.1',
  '0.15': '0.15.0',
  '0.16': '0.16.0',
  '1.0': '1.0.0',
  '1.1': '1.1.0',
  '1.11': '1.11.0',
};

const STATE_MAP = {
  'planned': 'draft',
  'shipped': 'shipped',
  'current': 'in-progress',
};

function migrateVersion(version) {
  return SEMVER_MAP[version] || null;
}

function compareVersions(v1, v2) {
  // Numeric comparison for semver
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 < p2) return -1;
    if (p1 > p2) return 1;
  }
  return 0;
}

async function auditSemver() {
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║           SEMVER MIGRATION AUDIT (Pre-Migration Check)         ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  try {
    console.log('[1/5] Fetching store data...');
    const storeRes = await fetch(`http://localhost:${port}/api/store`, { headers });
    if (!storeRes.ok) {
      console.error(`❌ Failed to fetch store: ${storeRes.status}`);
      process.exit(1);
    }

    const store = await storeRes.json();
    const { projects = [], tasks = [] } = store;

    console.log(`✅ Loaded ${projects.length} projects, ${tasks.length} tasks\n`);

    // Collect all unique version strings
    const allVersionStrings = new Set();
    projects.forEach(p => {
      if (p.versions) p.versions.forEach(v => allVersionStrings.add(v.version));
      if (p.currentVersion) allVersionStrings.add(p.currentVersion);
      if (p.autonomy?.approvedThrough) allVersionStrings.add(p.autonomy.approvedThrough);
    });
    tasks.forEach(t => {
      if (t.version) allVersionStrings.add(t.version);
    });

    console.log('[2/5] Building version migration map...');
    const versionMapping = new Map();
    const unmappableVersions = [];

    for (const oldVer of allVersionStrings) {
      const newVer = migrateVersion(oldVer);
      if (newVer) {
        versionMapping.set(oldVer, newVer);
        console.log(`  ✅ ${oldVer} → ${newVer}`);
      } else {
        unmappableVersions.push(oldVer);
        console.log(`  ⚠️ ${oldVer} — NO MAPPING (will need manual review)`);
      }
    }

    if (unmappableVersions.length > 0) {
      console.log(`\n⚠️ ${unmappableVersions.length} unmappable version(s) detected:`);
      unmappableVersions.forEach(v => console.log(`   - ${v}`));
    }

    console.log('\n[3/5] Validating sortability...');
    const sortableVersions = Array.from(versionMapping.values()).sort(compareVersions);
    console.log('  Sorted order (after migration):');
    sortableVersions.forEach((v, i) => console.log(`    ${i + 1}. ${v}`));

    console.log('\n[4/5] Detecting orphaned references...');
    const issues = [];

    for (const project of projects) {
      const existingVersionSet = new Set();
      if (project.versions) {
        project.versions.forEach(v => existingVersionSet.add(v.version));
      }

      // Check currentVersion
      if (project.currentVersion && !existingVersionSet.has(project.currentVersion)) {
        issues.push({
          type: 'orphaned_current_version',
          project: project.name,
          projectId: project.id,
          value: project.currentVersion,
          detail: `currentVersion "${project.currentVersion}" does not exist in roadmap`,
        });
      }

      // Check approvedThrough
      if (project.autonomy?.approvedThrough) {
        if (!existingVersionSet.has(project.autonomy.approvedThrough)) {
          issues.push({
            type: 'orphaned_approval_horizon',
            project: project.name,
            projectId: project.id,
            value: project.autonomy.approvedThrough,
            detail: `approvedThrough "${project.autonomy.approvedThrough}" does not exist in roadmap`,
          });
        }
      }
    }

    if (issues.length > 0) {
      console.log(`⚠️ ${issues.length} orphaned reference(s) found:\n`);
      issues.forEach(issue => {
        console.log(`  ${issue.type}`);
        console.log(`    Project: ${issue.project} (${issue.projectId})`);
        console.log(`    Value: ${issue.value}`);
        console.log(`    Detail: ${issue.detail}\n`);
      });
    } else {
      console.log('✅ No orphaned references detected\n');
    }

    console.log('[5/5] Analyzing per-project impact...\n');

    // Generate detailed per-project report
    const activeProjects = [];
    const inactiveProjects = [];

    for (const project of projects) {
      const projectTasks = tasks.filter(t => t.projectId === project.id);
      const isActive = projectTasks.length > 0 && projectTasks.some(t => t.status !== 'done');

      const report = {
        name: project.name,
        id: project.id,
        isActive,
        versions: {
          total: project.versions?.length || 0,
          migrations: (project.versions || []).map(v => ({
            old: v.version,
            new: versionMapping.get(v.version) || 'UNMAPPED',
            status: v.status,
            items: v.items?.length || 0,
          })),
        },
        autonomy: {
          currentVersion: project.currentVersion,
          currentVersionMigrated: project.currentVersion ? versionMapping.get(project.currentVersion) : null,
          approvedThrough: project.autonomy?.approvedThrough,
          approvedThroughMigrated: project.autonomy?.approvedThrough
            ? versionMapping.get(project.autonomy.approvedThrough)
            : null,
        },
        taskCount: projectTasks.length,
        activeTaskCount: projectTasks.filter(t => t.status !== 'done').length,
      };

      if (isActive) {
        activeProjects.push(report);
      } else {
        inactiveProjects.push(report);
      }
    }

    console.log('╔════════ ACTIVE PROJECTS (PRIORITY) ════════╗\n');
    if (activeProjects.length === 0) {
      console.log('  None\n');
    } else {
      for (const proj of activeProjects) {
        console.log(`  📍 ${proj.name} (${proj.id})`);
        console.log(`     Status: ${proj.isActive ? '🔥 ACTIVE' : '⏸️ Idle'}`);
        console.log(`     Tasks: ${proj.taskCount} total, ${proj.activeTaskCount} in-progress`);
        console.log(`     Versions: ${proj.versions.total}`);

        if (proj.versions.migrations.length > 0) {
          proj.versions.migrations.forEach(m => {
            const warn = m.new === 'UNMAPPED' ? ' ⚠️' : '';
            console.log(`       • ${m.old} → ${m.new} (${m.status}, ${m.items} items)${warn}`);
          });
        }

        if (proj.autonomy.currentVersion) {
          const migrated = proj.autonomy.currentVersionMigrated;
          const orphaned = !proj.versions.migrations.some(m => m.old === proj.autonomy.currentVersion);
          const warn = orphaned ? ' ⚠️ ORPHANED' : '';
          console.log(`     Current: ${proj.autonomy.currentVersion} → ${migrated}${warn}`);
        }

        if (proj.autonomy.approvedThrough) {
          const migrated = proj.autonomy.approvedThroughMigrated;
          const orphaned = !proj.versions.migrations.some(m => m.old === proj.autonomy.approvedThrough);
          const warn = orphaned ? ' ⚠️ ORPHANED' : '';
          console.log(`     Approved: ${proj.autonomy.approvedThrough} → ${migrated}${warn}`);
        }
        console.log();
      }
    }

    console.log('\n╔════════ INACTIVE PROJECTS (CAN MIGRATE SAFELY) ════════╗\n');
    if (inactiveProjects.length === 0) {
      console.log('  None\n');
    } else {
      console.log(`  ${inactiveProjects.length} project(s):\n`);
      for (const proj of inactiveProjects) {
        console.log(`  • ${proj.name} (${proj.id})`);
        if (proj.versions.total > 0) {
          console.log(`    ${proj.versions.migrations.map(m => m.old).join(', ')}`);
        }
      }
      console.log();
    }

    // Risk summary
    console.log('\n╔════════ RISK SUMMARY ════════╗\n');
    const risks = [];

    if (unmappableVersions.length > 0) {
      risks.push(`${unmappableVersions.length} unmappable version(s)`);
    }

    if (issues.length > 0) {
      risks.push(`${issues.length} orphaned reference(s)`);
    }

    if (activeProjects.length > 0) {
      const activeWithIssues = activeProjects.filter(p =>
        p.autonomy.currentVersionMigrated === 'UNMAPPED' ||
        p.autonomy.approvedThroughMigrated === 'UNMAPPED'
      );
      if (activeWithIssues.length > 0) {
        risks.push(`${activeWithIssues.length} active project(s) with unmappable versions`);
      }
    }

    if (risks.length === 0) {
      console.log('✅ GREEN: Migration is safe to proceed');
      console.log('  - All versions mappable');
      console.log('  - No orphaned references');
      console.log('  - Ready to migrate\n');
    } else {
      console.log('⚠️ YELLOW: Migration requires manual intervention');
      risks.forEach(r => console.log(`  - ${r}`));
      console.log('\n  Next steps:');
      console.log('  1. Address unmappable versions (add to SEMVER_MAP)');
      console.log('  2. Review orphaned references (clear or map)');
      console.log('  3. Re-run audit after fixes\n');
    }

    console.log('╔════════ MIGRATION STRATEGY ════════╗\n');
    console.log('When ready, run: node scripts/migrate-semver.mjs');
    console.log('  - Will backup store to /backups/pre-semver-{timestamp}');
    console.log('  - Migrate version strings in atomic transaction');
    console.log('  - Validate data integrity');
    console.log('  - Log all changes for audit trail\n');
    console.log('After migration, run: node scripts/verify-semver.mjs\n');

  } catch (e) {
    console.error('❌ Fatal error:', e.message);
    process.exit(1);
  }
}

auditSemver();
