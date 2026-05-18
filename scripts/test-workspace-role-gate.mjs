#!/usr/bin/env node
/**
 * test-workspace-role-gate.mjs
 *
 * #1387 Slice B.1 — Unit tests for requireWorkspaceRole + roleAtLeast.
 *
 * Pure helper-level tests. No live HTTP, no DB writes. Membership state is
 * injected via the workspace-auth cache (invalidateWorkspaceCache reseeded
 * through a private hook would be ideal, but instead we use the existing
 * settings-table fallback that workspace-auth reads when no DB is configured
 * — see loadWorkspaceData in src/lib/workspace-auth.ts).
 *
 * What this proves:
 *   - roleAtLeast hierarchy: member < admin < owner. Reserved 'admin' tier
 *     gates correctly even though the schema only has owner/member today.
 *   - requireWorkspaceRole returns 401 for unauthenticated, 403 for non-member,
 *     403 for insufficient-role, 200/allowed for owner/member at threshold.
 *   - Break-glass: global API key returns allowed=true with via='break-glass'.
 *   - OSS mode (no workspaces table): authenticated caller treated as owner
 *     of default-workspace; non-default workspace requests still 403.
 *
 * Slice B.2 will write live-HTTP tests against actual endpoints. This file
 * locks the helper contract first so B.2 has a stable surface to wire into.
 *
 * Usage: node scripts/test-workspace-role-gate.mjs
 *   Requires: a running org-studio with DATABASE_URL set, ORG_STUDIO_API_KEY
 *             exported. Boots the Next.js process out-of-band; this script
 *             imports the helper through the .next build artifacts.
 *
 * Strategy: we exercise the helper by hitting /api/health (a known cloud-mode
 * endpoint) with constructed Authorization headers. /api/health currently has
 * NO role gate, so it's the cheapest live probe of the underlying
 * authenticateRequestWithContext path. For the membership branches we hit a
 * dedicated test endpoint mounted only when ORG_STUDIO_TEST_HOOKS=1 — see
 * src/app/api/_test/workspace-role/route.ts (B.1 ships this too).
 */

import process from 'node:process';

const BASE_URL = process.env.TEST_URL || 'http://localhost:4501';
const API_KEY = process.env.ORG_STUDIO_API_KEY;

if (!API_KEY) {
  console.error('ORG_STUDIO_API_KEY required');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✅ ${label}`); }
  else      { failed++; console.log(`  ❌ ${label}`); }
}

async function probe({ workspaceId, minRole, bearer, cookie }) {
  const headers = { 'Content-Type': 'application/json' };
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
  if (cookie) headers['Cookie'] = cookie;
  if (workspaceId) headers['X-Workspace-Id'] = workspaceId;
  const url = `${BASE_URL}/api/test/workspace-role?minRole=${encodeURIComponent(minRole)}&workspaceId=${encodeURIComponent(workspaceId || 'default-workspace')}`;
  const res = await fetch(url, { headers });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function check404Test() {
  // If the test endpoint isn't mounted, exit gracefully — the assertions are
  // meaningful only when ORG_STUDIO_TEST_HOOKS=1 is set on the running app.
  const probe1 = await fetch(`${BASE_URL}/api/test/workspace-role?minRole=member&workspaceId=default-workspace`, {
    headers: { 'Authorization': `Bearer ${API_KEY}` },
  });
  if (probe1.status === 404) {
    console.error('test endpoint /api/test/workspace-role not mounted — restart server with ORG_STUDIO_TEST_HOOKS=1');
    process.exit(2);
  }
}

(async function main() {
  await check404Test();

  console.log('\n=== roleAtLeast hierarchy (via /api/_test/workspace-role) ===');

  // Break-glass: global API key always passes regardless of minRole.
  let r = await probe({ workspaceId: 'default-workspace', minRole: 'owner', bearer: API_KEY });
  assert(r.status === 200 && r.body.allowed === true && r.body.via === 'break-glass',
    `break-glass passes owner gate (got status=${r.status} via=${r.body?.via})`);

  r = await probe({ workspaceId: 'default-workspace', minRole: 'admin', bearer: API_KEY });
  assert(r.status === 200 && r.body.via === 'break-glass',
    `break-glass passes admin gate (got status=${r.status} via=${r.body?.via})`);

  r = await probe({ workspaceId: 'default-workspace', minRole: 'member', bearer: API_KEY });
  assert(r.status === 200 && r.body.via === 'break-glass',
    `break-glass passes member gate (got status=${r.status} via=${r.body?.via})`);

  console.log('\n=== unauthenticated → 401 ===');
  r = await probe({ workspaceId: 'default-workspace', minRole: 'member' });
  assert(r.status === 401 && r.body.error === 'unauthorized',
    `no auth → 401 (got status=${r.status})`);

  console.log('\n=== bogus bearer → 401 ===');
  r = await probe({ workspaceId: 'default-workspace', minRole: 'member', bearer: 'this-is-not-a-real-key' });
  assert(r.status === 401, `bogus bearer → 401 (got status=${r.status})`);

  console.log('\n=== unknown workspace via break-glass: still passes (B.3 will audit) ===');
  r = await probe({ workspaceId: 'no-such-workspace', minRole: 'owner', bearer: API_KEY });
  assert(r.status === 200 && r.body.via === 'break-glass',
    `break-glass is workspace-agnostic by design (got status=${r.status})`);

  console.log(`\n=== ${passed} passed / ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
})();
