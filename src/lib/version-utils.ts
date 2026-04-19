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
  
  // Remove leading 'v' if present (shouldn't happen post-migration, but safe)
  let v = version.startsWith('v') ? version.slice(1) : version;
  
  // Check if already valid semver
  if (valid(v)) return v;
  
  // Try to coerce it (e.g., "0.14" → "0.14.0")
  const coerced = coerce(v);
  if (coerced) return coerced.version;
  
  // Fallback: return as-is (will fail on comparison, at least we'll know)
  console.warn(`[version-utils] Could not normalize version: ${version}`);
  return v;
}

/**
 * Compare two versions: -1 if v1 < v2, 0 if equal, 1 if v1 > v2
 */
export function compareVersions(v1: string | null | undefined, v2: string | null | undefined): -1 | 0 | 1 {
  const normalized1 = normalizeVersion(v1);
  const normalized2 = normalizeVersion(v2);
  
  if (!normalized1 || !normalized2) {
    throw new Error(`Invalid versions for comparison: ${v1} vs ${v2}`);
  }
  
  return compare(normalized1, normalized2);
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
