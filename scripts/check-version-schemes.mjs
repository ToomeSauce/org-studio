#!/usr/bin/env node
/**
 * check-version-schemes.mjs — #1561
 *
 * Manual / pre-commit runner for the two-scheme version guard.
 * Validates package.json (semver) + the live store (calver). Read-only.
 *
 * Usage:
 *   node scripts/check-version-schemes.mjs              # checks package.json + live store (if reachable)
 *   node scripts/check-version-schemes.mjs --no-store   # package.json only (offline / pre-commit fast path)
 *
 * Exit code 1 on any violation so it can gate a pre-commit hook or CI step.
 *
 * NOTE: the authoritative logic lives in src/lib/version-guard.ts and is unit-
 * tested in the gating CI `test` job. This script is a thin runtime wrapper so
 * the same rules can be run by hand or in a hook. The regexes are duplicated
 * here ONLY because this .mjs can't import the TS module without a build step;
 * they are kept byte-identical to version-utils.ts CALVER_RE / SEMVER_RE.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// Kept byte-identical to src/lib/version-utils.ts
const CALVER_RE = /^\d{4}\.(0[1-9]|1[0-2])\.(0[1-9]|[12]\d|3[01])(\.\d+)?$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const SENTINEL_RE = /^99\.99\./;
const BARE_VLABEL_RE = /^v?\d+\.\d+$/;

function classify(value, expected) {
  if (SENTINEL_RE.test(value)) return 'sentinel/junk version (99.99.x)';
  if (value.startsWith('v')) return 'leading "v" prefix not allowed';
  if (expected === 'semver') {
    if (SEMVER_RE.test(value)) return null;
    if (BARE_VLABEL_RE.test(value)) return 'bare 2-part label; semver requires MAJOR.MINOR.PATCH';
    return 'not valid semver';
  }
  if (CALVER_RE.test(value)) return null;
  if (BARE_VLABEL_RE.test(value)) return 'bare 2-part label; needs CalVer YYYY.MM.DD';
  if (SEMVER_RE.test(value)) return 'looks like semver; roadmap/horizon must be CalVer';
  return 'not valid calver';
}

const violations = [];
const push = (surface, value, expected, reason, hint) => violations.push({ surface, value, expected, reason, hint });

// 1) package.json → semver
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const pkgReason = typeof pkg.version === 'string' ? classify(pkg.version, 'semver') : 'missing version';
if (pkgReason) push('package.json', String(pkg.version), 'semver', pkgReason);

function detectScheme(value) {
  if (CALVER_RE.test(value)) return 'calver';
  if (SEMVER_RE.test(value)) return 'semver';
  return null;
}

function isUmbrella(vo) {
  const kind = typeof vo.kind === 'string' ? vo.kind.toLowerCase() : '';
  const scheme = typeof vo.scheme === 'string' ? vo.scheme.toLowerCase() : '';
  return vo.isUmbrella === true || kind === 'umbrella' || kind === 'container' || scheme === 'named';
}

// Ana's cardinality signal: hint (never auto-exempt) when an unmarked
// non-parseable version smells like a named umbrella. Mirrors umbrellaHint() in
// src/lib/version-guard.ts.
function umbrellaHint(vo) {
  const items = Array.isArray(vo.items) ? vo.items : [];
  const owners = new Set(items.map((it) => (it && typeof it === 'object' ? it.owner : undefined)).filter((o) => typeof o === 'string' && o.length > 0));
  const state = typeof vo.state === 'string' ? vo.state : vo.status;
  const shippedAt = vo.shipped_at ?? vo.shippedAt;
  if (items.length >= 10 && owners.size >= 3 && state === 'current' && shippedAt == null) {
    return `looks like a named umbrella (${items.length} items across ${owners.size} owners, status:current, not shipped) — if intentional, mark it kind:"umbrella"`;
  }
  return undefined;
}

// 2) live store → PER-PROJECT scheme consistency (calver is org-studio's choice,
//    NOT a product-wide rule — other projects use semver roadmaps deliberately).
//    Scans currentVersion, approvedVersions[], section.versions[].version, and
//    task.version. Explicitly-marked named umbrellas are exempt.
const skipStore = process.argv.includes('--no-store');
if (!skipStore) {
  const port = process.env.PORT || 4501;
  const apiKey = process.env.ORG_STUDIO_API_KEY || '';
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  try {
    const res = await fetch(`http://localhost:${port}/api/store`, { headers });
    const store = await res.json();
    for (const p of store.projects ?? []) {
      const entries = [];
      entries.push({ val: p.currentVersion, surface: `project ${p.id}.currentVersion` });
      for (const s of p.sections ?? []) {
        entries.push({ val: s.currentVersion, surface: `${p.id}/section ${s.id ?? s.name}.currentVersion` });
        for (const v of s.approvedVersions ?? []) entries.push({ val: v, surface: `${p.id}/section ${s.id ?? s.name}.approvedVersions[]` });
        for (const vo of s.versions ?? []) {
          if (isUmbrella(vo)) continue;
          entries.push({ val: vo.version, surface: `${p.id}/section ${s.id ?? s.name}.versions[].version`, vo });
        }
      }
      for (const t of store.tasks ?? []) if (t.projectId === p.id) entries.push({ val: t.version, surface: `task ${t.ticketNumber ? '#' + t.ticketNumber : t.id} (${p.id})` });

      const wellFormed = [];
      for (const { val, surface, vo } of entries) {
        if (val == null || val === '') continue;
        if (typeof val !== 'string') { push(surface, String(val), 'calver', 'non-string'); continue; }
        if (SENTINEL_RE.test(val)) { push(surface, val, 'calver', 'sentinel/junk (99.99.x)'); continue; }
        const scheme = detectScheme(val);
        if (!scheme) { push(surface, val, 'calver', 'malformed (neither semver nor calver; mark kind:"umbrella" if intentional container)', vo ? umbrellaHint(vo) : undefined); continue; }
        wellFormed.push({ scheme, surface, value: val });
      }
      if (!wellFormed.length) continue;
      const cal = wellFormed.filter((e) => e.scheme === 'calver').length;
      const projScheme = cal >= wellFormed.length - cal ? 'calver' : 'semver';
      for (const e of wellFormed) if (e.scheme !== projScheme) push(e.surface, e.value, projScheme, `mixed scheme — ${p.id} uses ${projScheme}, this is ${e.scheme}`);
    }
  } catch (e) {
    console.warn(`[version-guard] store unreachable, skipping store check: ${e.message}`);
  }
}

if (violations.length === 0) {
  console.log('✅ Version guard: PASS — all versions conform to the two-scheme contract.');
  process.exit(0);
}
console.error(`❌ Version guard: FAIL — ${violations.length} violation(s):`);
for (const v of violations) {
  console.error(`  ✗ [${v.expected}] ${v.surface}: "${v.value}" — ${v.reason}`);
  if (v.hint) console.error(`      ↳ hint: ${v.hint}`);
}
process.exit(1);
