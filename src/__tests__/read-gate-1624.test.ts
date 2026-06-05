/**
 * #1624 (T-F) — read-cluster auth gate tests (from #1610 audit F-P4/F-P5).
 *
 * Verifies the shared gates that protect the previously-unauthenticated read
 * endpoints, across all relevant env modes:
 *
 *   cloudReadGate      — CONDITIONAL (F-P5 cluster): gates only in cloud mode
 *                        (DATABASE_URL set AND ALLOW_ANONYMOUS_READS !== 'true').
 *   sensitiveReadGate  — UNCONDITIONAL (F-P4 memory/docs): gates whenever
 *                        DATABASE_URL is set, IGNORING ALLOW_ANONYMOUS_READS.
 *   internalAuthHeaders — attaches the API-key bearer for internal service
 *                        fetches so gating doesn't 401 our own calls.
 *
 * Strategy: mock `authenticateRequest` so we can assert *whether the gate calls
 * it* (i.e. whether it enforces) in each mode, without a live auth backend.
 * A fake "denied" response stands in for the 401 it returns.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextResponse } from 'next/server';

// Mock the auth check. authImpl decides what authenticateRequest returns.
const state = vi.hoisted(() => ({ authImpl: (_req: any) => null as any, calls: 0 }));
vi.mock('@/lib/auth', () => ({
  authenticateRequest: vi.fn(async (req: any) => {
    state.calls++;
    return state.authImpl(req);
  }),
}));

import { cloudReadGate, sensitiveReadGate, internalAuthHeaders, isCloudMode } from '@/lib/read-gate';

const DENIED = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
function fakeReq(): any {
  return { headers: { get: () => null }, url: 'http://localhost/api/x' };
}

const ORIG = { ...process.env };
beforeEach(() => {
  state.calls = 0;
  state.authImpl = () => null; // default: authenticated/allowed
  delete process.env.DATABASE_URL;
  delete process.env.ALLOW_ANONYMOUS_READS;
  delete process.env.ORG_STUDIO_API_KEY;
});
afterEach(() => {
  process.env = { ...ORIG };
});

describe('isCloudMode', () => {
  it('false when no DATABASE_URL (OSS/file mode)', () => {
    expect(isCloudMode()).toBe(false);
  });
  it('true when DATABASE_URL set and anon-reads not opted in', () => {
    process.env.DATABASE_URL = 'postgres://x';
    expect(isCloudMode()).toBe(true);
  });
  it('false when DATABASE_URL set but ALLOW_ANONYMOUS_READS=true (escape hatch)', () => {
    process.env.DATABASE_URL = 'postgres://x';
    process.env.ALLOW_ANONYMOUS_READS = 'true';
    expect(isCloudMode()).toBe(false);
  });
});

describe('cloudReadGate (F-P5 conditional)', () => {
  it('OSS/file mode (no DB): does NOT enforce, returns null', async () => {
    const res = await cloudReadGate(fakeReq());
    expect(res).toBeNull();
    expect(state.calls).toBe(0); // auth never even consulted
  });

  it('anon-reads opt-in: does NOT enforce even with DB set', async () => {
    process.env.DATABASE_URL = 'postgres://x';
    process.env.ALLOW_ANONYMOUS_READS = 'true';
    const res = await cloudReadGate(fakeReq());
    expect(res).toBeNull();
    expect(state.calls).toBe(0);
  });

  it('cloud mode + unauthenticated: returns the 401 from authenticateRequest', async () => {
    process.env.DATABASE_URL = 'postgres://x';
    state.authImpl = () => DENIED;
    const res = await cloudReadGate(fakeReq());
    expect(res).toBe(DENIED);
    expect(state.calls).toBe(1);
  });

  it('cloud mode + authenticated: returns null (allowed)', async () => {
    process.env.DATABASE_URL = 'postgres://x';
    state.authImpl = () => null;
    const res = await cloudReadGate(fakeReq());
    expect(res).toBeNull();
    expect(state.calls).toBe(1);
  });
});

describe('sensitiveReadGate (F-P4 unconditional w.r.t. anon-reads)', () => {
  it('OSS/file mode (no DB): does NOT enforce, returns null', async () => {
    const res = await sensitiveReadGate(fakeReq());
    expect(res).toBeNull();
    expect(state.calls).toBe(0);
  });

  it('DB set: enforces even when ALLOW_ANONYMOUS_READS=true (the key difference vs cloudReadGate)', async () => {
    process.env.DATABASE_URL = 'postgres://x';
    process.env.ALLOW_ANONYMOUS_READS = 'true';
    state.authImpl = () => DENIED;
    const res = await sensitiveReadGate(fakeReq());
    expect(res).toBe(DENIED); // anon-reads escape hatch must NOT open memory/docs
    expect(state.calls).toBe(1);
  });

  it('DB set + authenticated: returns null (allowed)', async () => {
    process.env.DATABASE_URL = 'postgres://x';
    state.authImpl = () => null;
    const res = await sensitiveReadGate(fakeReq());
    expect(res).toBeNull();
    expect(state.calls).toBe(1);
  });

  it('contrast: same env (DB + anon-reads) — cloudReadGate opens, sensitiveReadGate locks', async () => {
    process.env.DATABASE_URL = 'postgres://x';
    process.env.ALLOW_ANONYMOUS_READS = 'true';
    state.authImpl = () => DENIED;
    expect(await cloudReadGate(fakeReq())).toBeNull();        // F-P5 open
    expect(await sensitiveReadGate(fakeReq())).toBe(DENIED);  // F-P4 locked
  });
});

describe('internalAuthHeaders', () => {
  it('no API key configured: just the internal marker (OSS mode)', () => {
    const h = internalAuthHeaders();
    expect(h['X-Internal-Request']).toBe('true');
    expect(h['Authorization']).toBeUndefined();
  });

  it('API key set: attaches bearer so internal calls pass the gate', () => {
    process.env.ORG_STUDIO_API_KEY = 'secret-key';
    const h = internalAuthHeaders();
    expect(h['Authorization']).toBe('Bearer secret-key');
    expect(h['X-Internal-Request']).toBe('true');
  });

  it('merges extra headers', () => {
    process.env.ORG_STUDIO_API_KEY = 'k';
    const h = internalAuthHeaders({ 'Content-Type': 'application/json' });
    expect(h['Content-Type']).toBe('application/json');
    expect(h['Authorization']).toBe('Bearer k');
  });
});
