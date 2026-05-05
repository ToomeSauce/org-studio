#!/usr/bin/env node
/**
 * Migrate test fixtures: replace `approvedThrough: 'X.Y.Z'` with
 * `approvedVersions: [<v ≤ X.Y.Z>]` derived from the surrounding
 * `versions: [...]` array in the same component fixture.
 *
 * Strategy: regex-walk each component literal, find approvedThrough +
 * versions in the same object, compute the list, rewrite.
 */

const fs = require('fs');
const path = require('path');

function semverLE(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db;
  }
  return true;
}

function migrateFile(filePath) {
  let src = fs.readFileSync(filePath, 'utf8');
  let changes = 0;

  // Match each `approvedThrough: 'X.Y.Z'` and find the matching
  // `versions: [ ... ]` within the same enclosing object literal.
  // Heuristic: scan forward from each approvedThrough hit for a versions: [
  // until we hit a closing brace at the same depth.

  const lines = src.split('\n');
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^(\s*)approvedThrough:\s*['"]([^'"]+)['"],?\s*$/);
    if (!m) {
      out.push(line);
      continue;
    }

    const indent = m[1];
    const horizon = m[2];

    // Find versions: [ ... ] in next ~30 lines (within same brace depth, but
    // these test fixtures are flat enough that we just scan forward).
    let versionsStart = -1;
    for (let j = i + 1; j < Math.min(lines.length, i + 40); j++) {
      if (/^\s*versions:\s*\[/.test(lines[j])) {
        versionsStart = j;
        break;
      }
      // bail if we exit the component's brace
      if (/^\s*\},?\s*$/.test(lines[j]) && lines[j].length <= indent.length + 2) break;
    }

    if (versionsStart === -1) {
      // No versions[] in scope — synthesize a list with just the horizon
      // as a single approved version. This preserves intent for fixtures
      // that approve a version not enumerated in a versions[] (rare).
      out.push(`${indent}approvedVersions: ['${horizon}'],`);
      changes++;
      continue;
    }

    // Collect version strings from the versions: [ ... ] block until ']'.
    const versionStrs = [];
    for (let j = versionsStart; j < lines.length; j++) {
      const vm = lines[j].match(/version:\s*['"]([^'"]+)['"]/);
      if (vm) versionStrs.push(vm[1]);
      if (/\]/.test(lines[j]) && j > versionsStart) break;
    }

    const approved = versionStrs.filter(v => semverLE(v, horizon));
    const rendered = `[${approved.map(v => `'${v}'`).join(', ')}]`;
    out.push(`${indent}approvedVersions: ${rendered},`);
    changes++;
  }

  if (changes > 0) {
    fs.writeFileSync(filePath, out.join('\n'));
    console.log(`✓ ${path.basename(filePath)}: ${changes} fixture(s) migrated`);
  } else {
    console.log(`  ${path.basename(filePath)}: nothing to migrate`);
  }
}

const files = [
  'src/__tests__/dispatch-gate.test.ts',
  'src/__tests__/start-button-gate.test.ts',
  'src/__tests__/dispatch-attempts.test.ts',
  'src/__tests__/sequential-gate.test.ts',
];

for (const f of files) {
  migrateFile(path.resolve(f));
}
