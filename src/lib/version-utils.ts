/**
 * src/lib/version-utils.ts
 * 
 * Semantic version comparison utilities using npm semver package.
 * Replaces all parseFloat-based version comparisons.
 */

import { lt, lte, gt, gte, compare, valid, coerce } from 'semver';

/**
 * Normalize a version string to valid semver format.
 * Handles versions like "0.141" → "0.14.1"
 * 
 * Note: This assumes SEMVER_MAP was already applied during migration.
 * This is a safety net for any stray old versions.
 */
export function normalizeVersion(version: string | null | undefined): string | null {
  if (!version) return null;
  
  // Remove leading 'v' if present
  let v = version.startsWith('v') ? version.slice(1) : version;
  
  // Check if already valid semver
  if (valid(v)) return v;
  
  // Handle leading zeros in parts (e.g. "1.05.0" → "1.5.0") which are
  // invalid per semver spec. Split, strip leading zeros, rejoin.
  const parts = v.split('.');
  if (parts.length >= 2 && parts.length <= 3 && parts.every(p => /^\d+$/.test(p))) {
    const cleaned = parts
      .map(p => String(parseInt(p, 10))) // strips leading zeros, '0' stays '0'
      .join('.');
    const padded = parts.length === 2 ? `${cleaned}.0` : cleaned;
    if (valid(padded)) return padded;
  }
  
  // Try to coerce it (e.g., "0.14" → "0.14.0")
  const coerced = coerce(v);
  if (coerced) return coerced.version;
  
  // Could not normalize — return null so callers can handle gracefully.
  console.warn(`[version-utils] Could not normalize version: ${version}`);
  return null;
}

/**
 * Compare two versions: -1 if v1 < v2, 0 if equal, 1 if v1 > v2
 */
export function compareVersions(v1: string | null | undefined, v2: string | null | undefined): -1 | 0 | 1 {
  const normalized1 = normalizeVersion(v1);
  const normalized2 = normalizeVersion(v2);
  
  // Defensive: never throw from a comparator. A throwing comparator corrupts
  // Array.sort and can cascade into React render loops downstream.
  // Unknown/invalid versions sort as equal to each other, and greater than
  // known versions (push bad data to the end).
  if (!normalized1 && !normalized2) return 0;
  if (!normalized1) return 1;
  if (!normalized2) return -1;
  
  try {
    return compare(normalized1, normalized2);
  } catch (e) {
    console.error(`[version-utils] compareVersions error: ${v1} vs ${v2}`, e);
    return 0;
  }
}

/**
 * Check if version is less than horizon.
 * Used for approval horizon checks: is this version approved?
 */
export function isVersionInHorizon(version: string | null | undefined, horizon: string | null | undefined): boolean {
  if (!horizon) return false; // Nothing approved
  if (!version) return false;
  
  try {
    return lte(normalizeVersion(version)!, normalizeVersion(horizon)!);
  } catch (e) {
    console.error(`[version-utils] Error checking horizon: ${version} <= ${horizon}`, e);
    return false;
  }
}

/**
 * Check if version is less than another.
 */
export function isVersionLess(v1: string | null | undefined, v2: string | null | undefined): boolean {
  if (!v1 || !v2) return false;
  try {
    return lt(normalizeVersion(v1)!, normalizeVersion(v2)!);
  } catch (e) {
    console.error(`[version-utils] Error comparing: ${v1} < ${v2}`, e);
    return false;
  }
}

/**
 * Check if version is less than or equal to another.
 */
export function isVersionLessOrEqual(v1: string | null | undefined, v2: string | null | undefined): boolean {
  if (!v1 || !v2) return false;
  try {
    return lte(normalizeVersion(v1)!, normalizeVersion(v2)!);
  } catch (e) {
    console.error(`[version-utils] Error comparing: ${v1} <= ${v2}`, e);
    return false;
  }
}

/**
 * Check if version is greater than another.
 */
export function isVersionGreater(v1: string | null | undefined, v2: string | null | undefined): boolean {
  if (!v1 || !v2) return false;
  try {
    return gt(normalizeVersion(v1)!, normalizeVersion(v2)!);
  } catch (e) {
    console.error(`[version-utils] Error comparing: ${v1} > ${v2}`, e);
    return false;
  }
}

/**
 * Check if version is greater than or equal to another.
 */
export function isVersionGreaterOrEqual(v1: string | null | undefined, v2: string | null | undefined): boolean {
  if (!v1 || !v2) return false;
  try {
    return gte(normalizeVersion(v1)!, normalizeVersion(v2)!);
  } catch (e) {
    console.error(`[version-utils] Error comparing: ${v1} >= ${v2}`, e);
    return false;
  }
}

/**
 * Sort versions in ascending order.
 */
export function sortVersions(versions: (string | null | undefined)[]): string[] {
  const normalized = versions
    .map(normalizeVersion)
    .filter((v): v is string => v !== null);
  return normalized.sort(compare);
}

/**
 * Format version for display (remove v prefix, already removed by migration).
 */
export function formatVersion(version: string | null | undefined): string {
  if (!version) return '';
  // Should already be clean post-migration, but safety net
  return version.startsWith('v') ? version.slice(1) : version;
}

/**
 * Produce an integer sort key for a semver string. Packs major/minor/patch
 * into a single int so it fits the `sort_order` INTEGER column and sorts
 * correctly (e.g., 0.14.1 < 0.15.0 < 2.0.0).
 *
 * Formula: major*1_000_000_000 + minor*1_000_000 + patch*1_000
 * The trailing *1000 leaves headroom for future pre-release handling.
 */
export function versionSortKey(version: string | null | undefined): number {
  const n = normalizeVersion(version);
  if (!n) return 0;
  try {
    const [maj, min, pat] = n.split('.').map(x => parseInt(x, 10) || 0);
    return maj * 1_000_000_000 + min * 1_000_000 + pat * 1_000;
  } catch {
    return 0;
  }
}

/**
 * Bump the minor version (e.g., "0.14.1" -> "0.15.0"). Falls back to "0.2.0".
 */
export function nextMinorVersion(version: string | null | undefined): string {
  const n = normalizeVersion(version) || '0.1.0';
  try {
    const [maj, min] = n.split('.').map(x => parseInt(x, 10) || 0);
    return `${maj}.${min + 1}.0`;
  } catch {
    return '0.2.0';
  }
}
