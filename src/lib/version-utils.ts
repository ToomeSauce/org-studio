/**
 * src/lib/version-utils.ts
 *
 * Version comparison and formatting utilities.
 *
 * Supports two formats:
 *   CalVer  — YYYY.MM.DD or YYYY.MM.DD.N  (e.g. 2026.04.22, 2026.04.22.1)
 *   SemVer  — MAJOR.MINOR.PATCH           (e.g. 0.15.0, 1.12.0)
 *
 * CalVer is the current standard for new Org Studio releases.
 * SemVer is accepted for backward compatibility (Garage and older roadmap entries).
 *
 * Comparison strategy: numeric part-by-part (works for both formats without
 * any third-party library). A CalVer string (first part ≥ 2000) will always
 * compare greater than a SemVer string (first part 0-9xx), which is correct —
 * CalVer versions are newer.
 */

// ── Patterns ─────────────────────────────────────────────────────────────────

/**
 * CalVer: YYYY.MM.DD or YYYY.MM.DD.N
 * Month 01-12, day 01-31, optional micro counter ≥ 0.
 */
export const CALVER_RE =
  /^\d{4}\.(0[1-9]|1[0-2])\.(0[1-9]|[12]\d|3[01])(\.\d+)?$/;

/**
 * SemVer (strict 3-part, no v prefix): MAJOR.MINOR.PATCH
 */
export const SEMVER_RE = /^\d+\.\d+\.\d+$/;

// ── Format detection ─────────────────────────────────────────────────────────

export function isCalver(version: string | null | undefined): boolean {
  if (!version) return false;
  return CALVER_RE.test(version);
}

export function isSemver(version: string | null | undefined): boolean {
  if (!version) return false;
  return SEMVER_RE.test(version);
}

export function isValidVersion(version: string | null | undefined): boolean {
  if (!version) return false;
  return CALVER_RE.test(version) || SEMVER_RE.test(version);
}

// ── Normalisation ─────────────────────────────────────────────────────────────

/**
 * Normalize a version string to a canonical form.
 *
 * - Strips leading `v` prefix.
 * - If already CalVer or SemVer → return as-is.
 * - Handles old 2-part shorthand (e.g. "0.14") → "0.14.0".
 * - Handles legacy compact form (e.g. "0.141") → "0.14.1" (safety net; DB
 *   was already migrated but this prevents crashes if stray old values appear).
 *
 * Returns null if the string can't be recognized.
 */
export function normalizeVersion(version: string | null | undefined): string | null {
  if (!version) return null;

  let v = version.startsWith('v') ? version.slice(1) : version;

  // Already canonical CalVer
  if (CALVER_RE.test(v)) return v;

  // Already canonical SemVer
  if (SEMVER_RE.test(v)) return v;

  // 2-part semver shorthand: "0.14" → "0.14.0"
  if (/^\d+\.\d+$/.test(v)) return `${v}.0`;

  // Legacy compact: "0.141" (2 digits in minor field) → "0.14.1"
  // Splits into major=0 minor=141 → interpret as minor=14 patch=1
  const compactMatch = v.match(/^(\d+)\.(\d{3,})$/);
  if (compactMatch) {
    const [, major, rest] = compactMatch;
    // Last digit is patch, preceding digits are minor
    const patch = rest.slice(-1);
    const minor = rest.slice(0, -1).replace(/^0+/, '') || '0';
    const candidate = `${major}.${minor}.${patch}`;
    if (SEMVER_RE.test(candidate)) return candidate;
  }

  console.warn(`[version-utils] Could not normalize version: ${version}`);
  return null;
}

// ── Comparison ────────────────────────────────────────────────────────────────

/**
 * Compare two version strings numerically, part by part.
 * Returns -1 | 0 | 1. Handles CalVer, SemVer, or mixed comparisons.
 *
 * Mixed (SemVer vs CalVer): CalVer years (≥ 2000) naturally sort higher
 * than any real-world SemVer major version, which is correct — CalVer
 * releases are always newer than the legacy SemVer history.
 */
export function compareVersions(
  v1: string | null | undefined,
  v2: string | null | undefined,
): -1 | 0 | 1 {
  const n1 = normalizeVersion(v1);
  const n2 = normalizeVersion(v2);

  if (!n1 && !n2) return 0;
  if (!n1) return 1;  // unknown sorts last (greater)
  if (!n2) return -1;

  try {
    const p1 = n1.split('.').map(Number);
    const p2 = n2.split('.').map(Number);
    const len = Math.max(p1.length, p2.length);

    for (let i = 0; i < len; i++) {
      const a = p1[i] ?? 0;
      const b = p2[i] ?? 0;
      if (a < b) return -1;
      if (a > b) return 1;
    }
    return 0;
  } catch (e) {
    console.error(`[version-utils] compareVersions error: ${v1} vs ${v2}`, e);
    return 0;
  }
}

// ── Horizon checks ────────────────────────────────────────────────────────────

/**
 * Is `version` ≤ `horizon`?  Used for approval horizon checks.
 */
export function isVersionInHorizon(
  version: string | null | undefined,
  horizon: string | null | undefined,
): boolean {
  if (!horizon || !version) return false;
  return compareVersions(version, horizon) <= 0;
}

/** Is v1 < v2? */
export function isVersionLess(
  v1: string | null | undefined,
  v2: string | null | undefined,
): boolean {
  if (!v1 || !v2) return false;
  return compareVersions(v1, v2) < 0;
}

/** Is v1 ≤ v2? */
export function isVersionLessOrEqual(
  v1: string | null | undefined,
  v2: string | null | undefined,
): boolean {
  if (!v1 || !v2) return false;
  return compareVersions(v1, v2) <= 0;
}

/** Is v1 > v2? */
export function isVersionGreater(
  v1: string | null | undefined,
  v2: string | null | undefined,
): boolean {
  if (!v1 || !v2) return false;
  return compareVersions(v1, v2) > 0;
}

/** Is v1 ≥ v2? */
export function isVersionGreaterOrEqual(
  v1: string | null | undefined,
  v2: string | null | undefined,
): boolean {
  if (!v1 || !v2) return false;
  return compareVersions(v1, v2) >= 0;
}

// ── Sort ──────────────────────────────────────────────────────────────────────

/** Sort an array of version strings ascending. */
export function sortVersions(versions: (string | null | undefined)[]): string[] {
  const normalized = versions
    .map(normalizeVersion)
    .filter((v): v is string => v !== null);
  return normalized.sort(compareVersions);
}

// ── Display ───────────────────────────────────────────────────────────────────

/** Format a version for display (strips leading `v`, already absent post-migration). */
export function formatVersion(version: string | null | undefined): string {
  if (!version) return '';
  return version.startsWith('v') ? version.slice(1) : version;
}

// ── Sort key ──────────────────────────────────────────────────────────────────

/**
 * Produce an INTEGER sort key that fits a Postgres `INTEGER` column (< 2.1B).
 *
 * CalVer  YYYY.MM.DD[.N] → (year - 2020) * 10_000_000 + month * 100_000 + day * 1_000 + micro
 *   e.g. 2026.04.22   → (6)*10_000_000 + 4*100_000 + 22*1_000 = 60_422_000
 *   e.g. 2026.04.22.1 → 60_422_001
 *
 * SemVer  MAJ.MIN.PAT   → maj * 1_000_000_000 + min * 1_000_000 + pat * 1_000
 *   e.g. 0.16.0 → 16_000_000
 *   e.g. 1.12.0 → 1_012_000_000
 *
 * CalVer keys (≥ 50_000_000 for year 2025+) are always larger than plausible
 * SemVer keys, so mixed roadmaps sort CalVer after SemVer — correct.
 */
export function versionSortKey(version: string | null | undefined): number {
  const n = normalizeVersion(version);
  if (!n) return 0;

  try {
    const parts = n.split('.').map(x => parseInt(x, 10) || 0);

    if (CALVER_RE.test(n)) {
      // CalVer: [YYYY, MM, DD] or [YYYY, MM, DD, micro]
      const [year, month, day, micro = 0] = parts;
      return (year - 2020) * 10_000_000 + month * 100_000 + day * 1_000 + micro;
    } else {
      // SemVer: [MAJOR, MINOR, PATCH]
      const [maj, min, pat] = parts;
      return maj * 1_000_000_000 + min * 1_000_000 + pat * 1_000;
    }
  } catch {
    return 0;
  }
}

// ── Next version helpers ──────────────────────────────────────────────────────

/**
 * Return today's CalVer string: YYYY.MM.DD
 * Pass a Date to override (useful in tests).
 */
export function todayCalver(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}.${m}.${d}`;
}

/**
 * Given an existing CalVer string for today, return the next micro version.
 * e.g. "2026.04.22" → "2026.04.22.1"
 *      "2026.04.22.1" → "2026.04.22.2"
 * If the version is not today's or is SemVer, just return todayCalver().
 */
export function nextCalver(current: string | null | undefined, date: Date = new Date()): string {
  const today = todayCalver(date);
  if (!current) return today;

  const n = normalizeVersion(current);
  if (!n || !isCalver(n)) return today;

  const parts = n.split('.');
  const versionDate = parts.slice(0, 3).join('.');
  if (versionDate !== today) return today;

  // Same day — bump micro
  const micro = parts.length === 4 ? parseInt(parts[3], 10) + 1 : 1;
  return `${today}.${micro}`;
}

/**
 * @deprecated Use nextCalver() for new CalVer projects.
 * Kept for backward compat with any callers on legacy SemVer projects.
 * Bumps the minor version: "0.14.1" → "0.15.0". Falls back to "0.2.0".
 */
export function nextMinorVersion(version: string | null | undefined): string {
  const n = normalizeVersion(version) || '0.1.0';
  if (isCalver(n)) return nextCalver(n);
  try {
    const [maj, min] = n.split('.').map(x => parseInt(x, 10) || 0);
    return `${maj}.${min + 1}.0`;
  } catch {
    return '0.2.0';
  }
}
