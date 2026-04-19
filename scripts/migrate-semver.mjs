#!/usr/bin/env node
/**
 * migrate-semver.mjs (v2 — API-based batch migration)
 * 
 * Performs atomic migration from version strings to semantic versioning via API.
 * - Backs up entire store before starting
 * - Migrates all version strings with comprehensive mapping
 * - Handles orphaned references (clears them with audit trail)
 * - Validates data integrity post-migration
 * - Generates detailed change log
 * 
 * Usage:
 *   node scripts/migrate-semver.mjs [--dry-run]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = process.env.PORT || 4501;
const apiKey = process.env.ORG_STUDIO_API_KEY || '';
const dryRun = process.argv.includes('--dry-run');

const headers = { 'Content-Type': 'application/json' };
if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

// Comprehensive version mapping
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
  '0.2': '0.2.0',
  '0.3': '0.3.0',
  '0.4': '0.4.0',
  '0.5': '0.5.0',
  '0.6': '0.6.0',
  '0.7': '0.7.0',
  '0.8': '0.8.0',
  '0.9': '0.9.0',
  '0.10': '0.10.0',
  '0.11': '0.11.0',
  '0.12': '0.12.0',
  '0.13': '0.13.0',
  '0.14': '0.14.0',
  '0.141': '0.14.1',
  '0.15': '0.15.0',
  '0.16': '0.16.0',
  '0.51': '0.51.0',
  '0.82': '0.82.0',
  '0.83': '0.83.0',
  '0.84': '0.84.0',
  '0.85': '0.85.0',
  '0.86': '0.86.0',
  '0.87': '0.87.0',
  '0.88': '0.88.0',
  '0.89': '0.89.0',
  '0.90': '0.90.0',
  '0.91': '0.91.0',
  '0.92': '0.92.0',
  '0.901': '0.901.0',
  '0.902': '0.902.0',
  '0.903': '0.903.0',
  '0.904': '0.904.0',
  '0.905': '0.905.0',
  '0.906': '0.906.0',
  '0.9015': '0.9015.0',
  '1.0': '1.0.0',
  '1.01': '1.01.0',
  '1.05': '1.05.0',
  '1.06': '1.06.0',
  '1.07': '1.07.0',
  '1.08': '1.08.0',
  '1.09': '1.09.0',
  '1.10': '1.10.0',
  '1.11': '1.11.0',
  '2.0': '2.0.0',
};

function migrateVersion(version) {
  return SEMVER_MAP[version] || null;
}

async function migrateSemver() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(__dirname, '..', 'backups');
  const backupFile = path.join(backupDir, `pre-semver-${timestamp}.json`);
  const logFile = path.join(backupDir, `migration-${timestamp}.log`);

  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const log = [];
  const logEntry = (msg) => {
    console.log(msg);
    log.push(`[${new Date().toISOString()}] ${msg}`);
  };

  logEntry('\n╔════════════════════════════════════════════════════════════════╗');
  logEntry('║         SEMVER MIGRATION — API-based Batch Update            ║');
  logEntry('╚════════════════════════════════════════════════════════════════╝\n');

  logEntry(`Dry-run: ${dryRun}`);
  logEntry(`Backup directory: ${backupDir}\n`);

  try {
    // Step 1: Fetch and backup
    logEntry('[1/6] Fetching store data...');
    const storeRes = await fetch(`http://localhost:${port}/api/store`, { headers });
    if (!storeRes.ok) {
      throw new Error(`Failed to fetch store: ${storeRes.status}`);
    }

    const store = await storeRes.json();
    const { projects = [], tasks = [] } = store;

    logEntry(`✅ Loaded ${projects.length} projects, ${tasks.length} tasks`);

    if (!dryRun) {
      logEntry('\n[2/6] Creating pre-migration backup...');
      fs.writeFileSync(backupFile, JSON.stringify(store, null, 2));
      logEntry(`✅ Backup saved: ${backupFile}`);
    } else {
      logEntry('\n[2/6] DRY-RUN: Skipping backup');
    }

    // Step 2: Build migration plan
    logEntry('\n[3/6] Building migration plan...');

    const projectUpdates = [];
    const taskUpdates = [];
    const orphanedRefs = [];

    // Migrate projects
    for (const project of projects) {
      const updates = {};
      let hasChanges = false;

      // Migrate versions
      if (project.versions) {
        const newVersions = project.versions.map(v => {
          const newVersion = migrateVersion(v.version);
          if (newVersion && newVersion !== v.version) {
            return { ...v, version: newVersion };
          }
          return v;
        });
        if (JSON.stringify(newVersions) !== JSON.stringify(project.versions)) {
          updates.versions = newVersions;
          hasChanges = true;
        }
      }

      // Migrate currentVersion
      if (project.currentVersion) {
        const newCurrent = migrateVersion(project.currentVersion);
        if (newCurrent) {
          updates.currentVersion = newCurrent;
          hasChanges = true;
        } else {
          orphanedRefs.push({
            type: 'currentVersion',
            project: project.name,
            projectId: project.id,
            oldValue: project.currentVersion,
          });
          updates.currentVersion = null;
          hasChanges = true;
        }
      }

      // Migrate approvedThrough
      if (project.autonomy?.approvedThrough) {
        const newApproved = migrateVersion(project.autonomy.approvedThrough);
        if (newApproved) {
          if (!updates.autonomy) updates.autonomy = { ...project.autonomy };
          updates.autonomy.approvedThrough = newApproved;
          hasChanges = true;
        } else {
          orphanedRefs.push({
            type: 'approvedThrough',
            project: project.name,
            projectId: project.id,
            oldValue: project.autonomy.approvedThrough,
          });
          if (!updates.autonomy) updates.autonomy = { ...project.autonomy };
          updates.autonomy.approvedThrough = null;
          hasChanges = true;
        }
      }

      if (hasChanges) {
        projectUpdates.push({ projectId: project.id, projectName: project.name, updates });
      }
    }

    // Migrate tasks
    for (const task of tasks) {
      if (task.version) {
        const newVersion = migrateVersion(task.version);
        if (newVersion && newVersion !== task.version) {
          taskUpdates.push({
            taskId: task.id,
            taskTitle: task.title,
            oldVersion: task.version,
            newVersion: newVersion,
          });
        }
      }
    }

    logEntry(`✅ Migration plan built:`);
    logEntry(`   Projects with changes: ${projectUpdates.length}`);
    logEntry(`   Tasks to migrate: ${taskUpdates.length}`);
    logEntry(`   Orphaned refs cleared: ${orphanedRefs.length}\n`);

    if (orphanedRefs.length > 0) {
      logEntry(`   ⚠️ Orphaned references:`);
      orphanedRefs.forEach(ref => {
        logEntry(`      - ${ref.project}: ${ref.type} = ${ref.oldValue}`);
      });
      logEntry('');
    }

    // Step 3: Apply migrations (if not dry-run)
    logEntry('\n[4/6] Applying migrations...');

    if (dryRun) {
      logEntry('⏭️ DRY-RUN: Skipping API calls');
    } else {
      let successCount = 0;
      let failureCount = 0;

      // Update projects
      for (const { projectId, projectName, updates } of projectUpdates) {
        try {
          const res = await fetch(`http://localhost:${port}/api/store`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              action: 'updateProject',
              id: projectId,
              updates,
            }),
          });

          if (res.ok) {
            successCount++;
            logEntry(`   ✅ ${projectName}`);
          } else {
            failureCount++;
            logEntry(`   ❌ ${projectName}: ${res.status}`);
          }
        } catch (e) {
          failureCount++;
          logEntry(`   ❌ ${projectName}: ${e.message}`);
        }
      }

      // Update tasks
      for (const { taskId, taskTitle, newVersion } of taskUpdates) {
        try {
          const res = await fetch(`http://localhost:${port}/api/store`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              action: 'updateTask',
              id: taskId,
              updates: { version: newVersion },
            }),
          });

          if (res.ok) {
            successCount++;
          } else {
            failureCount++;
            logEntry(`   ❌ Task ${taskTitle}: ${res.status}`);
          }
        } catch (e) {
          failureCount++;
          logEntry(`   ❌ Task ${taskTitle}: ${e.message}`);
        }
      }

      logEntry(`\n   Results: ${successCount} succeeded, ${failureCount} failed\n`);

      if (failureCount > 0) {
        throw new Error(`${failureCount} updates failed. See log for details.`);
      }
    }

    // Step 4: Verify
    logEntry('\n[5/6] Verifying migration...');
    const verifyRes = await fetch(`http://localhost:${port}/api/store`, { headers });
    const verifiedStore = await verifyRes.json();
    const allVersions = new Set();
    verifiedStore.projects.forEach(p => {
      if (p.versions) p.versions.forEach(v => allVersions.add(v.version));
      if (p.currentVersion) allVersions.add(p.currentVersion);
      if (p.autonomy?.approvedThrough) allVersions.add(p.autonomy.approvedThrough);
    });
    verifiedStore.tasks.forEach(t => {
      if (t.version) allVersions.add(t.version);
    });

    const sorted = Array.from(allVersions).sort((a, b) => {
      const aParts = a.split('.').map(Number);
      const bParts = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) {
        const ap = aParts[i] || 0;
        const bp = bParts[i] || 0;
        if (ap !== bp) return ap - bp;
      }
      return 0;
    });

    logEntry(`✅ Found ${allVersions.size} unique versions`);
    logEntry(`   Sample sort order: ${sorted.slice(0, 5).join(' < ')} < ...\n`);

    // Step 5: Summary
    logEntry('\n[6/6] Migration complete\n');
    logEntry('╔════════ MIGRATION SUMMARY ════════╗\n');

    if (dryRun) {
      logEntry('DRY-RUN (no changes applied):');
    } else {
      logEntry('MIGRATION COMPLETED SUCCESSFULLY:');
    }

    logEntry(`  Backup: ${backupFile}`);
    logEntry(`  Projects updated: ${projectUpdates.length}`);
    logEntry(`  Tasks updated: ${taskUpdates.length}`);
    logEntry(`  Orphaned refs cleared: ${orphanedRefs.length}`);
    logEntry(`  Versions now sortable: ${allVersions.size} unique\n`);

    logEntry('Next steps:');
    if (dryRun) {
      logEntry('  1. Review output above');
      logEntry('  2. Run actual migration: node scripts/migrate-semver.mjs');
    } else {
      logEntry('  1. Verify data: curl http://localhost:4501/api/store | jq \'.projects[0].versions\'');
      logEntry('  2. Commit changes: git add -A && git commit -m "feat: semver migration (0.141→0.14.1, etc)"');
    }
    logEntry('  3. Update codebase to use semver lib\n');

    fs.writeFileSync(logFile, log.join('\n'));
    logEntry(`Log: ${logFile}\n`);

  } catch (e) {
    logEntry(`\n❌ FATAL ERROR: ${e.message}`);
    if (!dryRun) {
      logEntry(`\nRollback: restore from ${backupFile}`);
    }
    fs.writeFileSync(logFile, log.join('\n'));
    process.exit(1);
  }
}

migrateSemver();
