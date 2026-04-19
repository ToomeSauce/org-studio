#!/usr/bin/env node
/**
 * generate-semver-map.mjs
 * 
 * Generates an expanded SEMVER_MAP covering all unmappable versions.
 * These versions appear to be organic evolution of projects (0.1 → 0.2 → ... → 0.9 → 1.0 → 1.1)
 * 
 * Strategy: Treat missing patch digits as .0 (standard semver convention)
 */

const unmappable = [
  '0.906', '0.3', '2.0', '0.8', '0.9015', '0.901', '0.903', '0.902', '0.2',
  '0.904', '0.82', '0.83', '0.84', '0.85', '0.86', '0.87', '0.88', '0.89',
  '0.90', '0.91', '0.92', '0.9', '0.10', '0.4', '0.5', '0.905', '1.01',
  '0.51', '0.6', '0.7', '1.05', '1.06', '1.07', '1.08', '1.09', '1.10',
  '0.11', '0.12', '0.13', '0.15', '0.141',
];

const map = {};

for (const v of unmappable) {
  // Simple rule: if already 3 parts (e.g., 0.141), map directly
  // Otherwise add .0
  const parts = v.split('.');
  if (parts.length === 2) {
    map[v] = `${v}.0`;
  } else {
    // Already 3+ parts, keep as-is (may need manual review)
    map[v] = v;
  }
}

console.log('// Auto-generated mappings for unmappable versions');
console.log('// Copy these into SEMVER_MAP in scripts/migrate-semver.mjs\n');
Object.entries(map).sort().forEach(([old, neu]) => {
  console.log(`  '${old}': '${neu}',`);
});
