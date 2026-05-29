/**
 * version-guard.ts — #1561
 *
 * Enforces the two-scheme version contract (decision: docs/decisions/2026-05-29-two-version-schemes.md):
 *   - Repo / published artifact (package.json) → SemVer (MAJOR.MINOR.PATCH)
 *   - Product roadmap + autonomy horizon (store: project.currentVersion,
 *     section.approvedVersions[], task.version) → CalVer (YYYY.MM.DD[.N])
 *
 * This module ONLY validates. It never rewrites data (constraint of #1561).
 * Behavior-preserving: it reuses CALVER_RE / SEMVER_RE from version-utils so
 * the guard and the runtime comparison logic can never disagree on what "valid"
 * means.
 *
 * Consumed by:
 *   - src/lib/version-guard.test.ts (runs in the gating CI `test` job)
 *   - scripts/check-version-schemes.mjs (manual / pre-commit invocation)
 */

import { CALVER_RE, SEMVER_RE } from './version-utils';

export interface VersionViolation {
  surface: string; // where it was found, e.g. "package.json" or "task #1234 (proj-org-studio)"
  value: string; // the offending version string
  expected: 'semver' | 'calver';
  reason: string;
}

/** A bare two-part "vX.Y" / "X.Y" label (the retired git-prose scheme). */
export const BARE_VLABEL_RE = /^v?\d+\.\d+$/;
/** Sentinel junk that probe/smoke tests used to inject (99.99.x). */
export const SENTINEL_RE = /^99\.99\./;

function classify(value: string, expected: 'semver' | 'calver'): string | null {
  if (SENTINEL_RE.test(value)) return 'sentinel/junk version (99.99.x)';
  if (value.startsWith('v')) return 'leading "v" prefix is not allowed in either scheme';
  if (expected === 'semver') {
    if (SEMVER_RE.test(value)) return null;
    if (BARE_VLABEL_RE.test(value)) return 'bare 2-part label; semver requires MAJOR.MINOR.PATCH';
    return 'not valid semver (expected MAJOR.MINOR.PATCH)';
  }
  // calver
  if (CALVER_RE.test(value)) return null;
  if (BARE_VLABEL_RE.test(value)) return 'bare 2-part label; roadmap/horizon requires CalVer YYYY.MM.DD';
  if (SEMVER_RE.test(value)) return 'looks like semver; roadmap/horizon must be CalVer YYYY.MM.DD';
  return 'not valid calver (expected YYYY.MM.DD or YYYY.MM.DD.N)';
}

/** Validate the package.json version field (semver surface). */
export function checkPackageVersion(version: unknown): VersionViolation[] {
  if (typeof version !== 'string' || version.length === 0) {
    return [{ surface: 'package.json', value: String(version), expected: 'semver', reason: 'missing or non-string version' }];
  }
  const reason = classify(version, 'semver');
  return reason ? [{ surface: 'package.json', value: version, expected: 'semver', reason }] : [];
}

/** Minimal shapes — kept loose so this works against the live store JSON. */
interface StoreSection { id?: string; name?: string; currentVersion?: unknown; approvedVersions?: unknown[] }
interface StoreProject { id?: string; currentVersion?: unknown; sections?: StoreSection[] }
interface StoreTask { id?: string; ticketNumber?: number; projectId?: string; version?: unknown }
export interface StoreShape { projects?: StoreProject[]; tasks?: StoreTask[] }

/**
 * Classify a single store version by FORMAT only (no expected-scheme — we don't
 * know the project's scheme yet). Returns 'semver' | 'calver' | null (junk).
 * CalVer is checked first because its shape is a strict subset of the semver
 * shape (YYYY.MM.DD parses as semver too); a valid CalVer date is calver.
 */
function detectScheme(value: string): 'semver' | 'calver' | null {
  if (CALVER_RE.test(value)) return 'calver';
  if (SEMVER_RE.test(value)) return 'semver';
  return null;
}

/**
 * Validate store roadmap/horizon versions.
 *
 * SCOPE (corrected #1561 — see docs/decisions/2026-05-29-two-version-schemes.md):
 * calver is NOT a product-wide rule — it is Org Studio's per-project choice.
 * Other projects (Thrivor, Garage, Podcast API, …) deliberately use semver
 * roadmaps. So this guard enforces PER-PROJECT CONSISTENCY, not a single scheme:
 *   - Each project picks ONE roadmap scheme (semver OR calver) from its data.
 *   - Versions that don't match the project's own scheme are flagged.
 *   - Junk (sentinels, malformed hybrids like "2026.06-platform-hardening") is
 *     always flagged.
 * It never flags a project merely for choosing semver over calver.
 */
export function checkStoreVersions(store: StoreShape): VersionViolation[] {
  const out: VersionViolation[] = [];

  for (const p of store.projects ?? []) {
    // Gather this project's version strings (project + sections + tasks).
    const entries: { val: unknown; surface: string }[] = [];
    entries.push({ val: p.currentVersion, surface: `project ${p.id}.currentVersion` });
    for (const s of p.sections ?? []) {
      entries.push({ val: s.currentVersion, surface: `project ${p.id} / section ${s.id ?? s.name}.currentVersion` });
      for (const v of s.approvedVersions ?? []) entries.push({ val: v, surface: `project ${p.id} / section ${s.id ?? s.name}.approvedVersions[]` });
    }
    for (const t of store.tasks ?? []) {
      if (t.projectId === p.id) entries.push({ val: t.version, surface: `task ${t.ticketNumber ? '#' + t.ticketNumber : t.id} (${p.id})` });
    }

    // First pass: split into well-formed (semver/calver) vs junk; flag junk now.
    const wellFormed: { scheme: 'semver' | 'calver'; surface: string; value: string }[] = [];
    for (const { val, surface } of entries) {
      if (val == null || val === '') continue; // unset allowed
      if (typeof val !== 'string') { out.push({ surface, value: String(val), expected: 'calver', reason: 'non-string version' }); continue; }
      if (SENTINEL_RE.test(val)) { out.push({ surface, value: val, expected: 'calver', reason: 'sentinel/junk version (99.99.x)' }); continue; }
      const scheme = detectScheme(val);
      if (!scheme) { out.push({ surface, value: val, expected: 'calver', reason: 'malformed version (neither valid semver nor calver)' }); continue; }
      wellFormed.push({ scheme, surface, value: val });
    }

    // Determine the project's majority scheme; flag the minority as inconsistent.
    if (wellFormed.length === 0) continue;
    const calCount = wellFormed.filter((e) => e.scheme === 'calver').length;
    const semCount = wellFormed.length - calCount;
    const projScheme: 'semver' | 'calver' = calCount >= semCount ? 'calver' : 'semver';
    for (const e of wellFormed) {
      if (e.scheme !== projScheme) {
        out.push({ surface: e.surface, value: e.value, expected: projScheme, reason: `mixed scheme — project ${p.id} roadmap uses ${projScheme}; this entry is ${e.scheme}` });
      }
    }
  }

  // Tasks whose projectId matches no project in the store: format-only junk check.
  const projIds = new Set((store.projects ?? []).map((p) => p.id));
  for (const t of store.tasks ?? []) {
    if (projIds.has(t.projectId)) continue;
    const val = t.version;
    if (val == null || val === '') continue;
    if (typeof val !== 'string') { out.push({ surface: `task ${t.id} (${t.projectId})`, value: String(val), expected: 'calver', reason: 'non-string version' }); continue; }
    if (SENTINEL_RE.test(val)) out.push({ surface: `task ${t.id} (${t.projectId})`, value: val, expected: 'calver', reason: 'sentinel/junk version (99.99.x)' });
    else if (!detectScheme(val)) out.push({ surface: `task ${t.id} (${t.projectId})`, value: val, expected: 'calver', reason: 'malformed version' });
  }
  return out;
}

/** Full guard: package.json + store. Returns all violations (empty = pass). */
export function runVersionGuard(opts: { packageVersion: unknown; store: StoreShape }): VersionViolation[] {
  return [...checkPackageVersion(opts.packageVersion), ...checkStoreVersions(opts.store)];
}

export function formatViolations(violations: VersionViolation[]): string {
  if (violations.length === 0) return 'Version guard: PASS — all versions conform to the two-scheme contract.';
  const lines = violations.map(
    (v) => `  ✗ [${v.expected}] ${v.surface}: "${v.value}" — ${v.reason}`
  );
  return `Version guard: FAIL — ${violations.length} violation(s):\n${lines.join('\n')}`;
}
