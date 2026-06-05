/**
 * #1623 (T-E) — agent-control / state-mutation hardening (from #1610 audit
 * F-P1, F-P3).
 *
 *   F-P1: POST /api/ping let ANY caller drive ANY agent via runtime RPC. It must
 *         require auth in cloud mode (same conditional gate as the read cluster).
 *   F-P3: GET /api/runtimes performed store MUTATIONS (auto-scaffold
 *         teammates/loops, clear loopDisabledAt) while unauthenticated. A
 *         state-changing GET is wrong regardless of auth. The mutations moved to
 *         an authenticated POST /api/runtimes; GET is now read-only.
 *
 * Strategy: mock the cloud gate + auth so we can assert WHETHER each handler
 * enforces in cloud mode, and mock the registry + the scaffold helper so we can
 * assert the GET never triggers scaffolding and the POST does.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NextResponse } from 'next/server';

const state = vi.hoisted(() => ({
  cloud: false,
  authImpl: (_req: any) => ({ error: null as any, context: { scopes: ['write'] } as any } as { error: any; context?: any }),
  writeDenied: null as any,
  scaffoldCalls: 0,
}));

vi.mock('@/lib/read-gate', () => ({
  isCloudMode: () => state.cloud,
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithContext: vi.fn(async (req: any) => state.authImpl(req)),
  requireWriteScope: vi.fn((_ctx: any) => state.writeDenied),
}));

// Registry: minimal stub so the handlers run without a live gateway.
vi.mock('@/lib/runtimes/registry', () => ({
  getRuntimeRegistry: vi.fn(async () => ({
    discoverAll: async () => [],
    healthAll: async () => ({}),
    getRuntimeName: (id: string) => id,
    getRuntimes: () => [],
  })),
}));

// Scaffold helper: spy so we can assert GET never calls it and POST does.
vi.mock('@/lib/runtimes/scaffold', () => ({
  scaffoldDiscoveredAgents: vi.fn(async () => {
    state.scaffoldCalls++;
    return { newAgents: [], loopsCreated: 0, loopReenabled: [] };
  }),
}));

// Store provider: read() returns empty settings; updateSettings spy detects writes.
const storeWrites = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/lib/store-provider', () => ({
  getStoreProvider: vi.fn(() => ({
    read: async () => ({ settings: { teammates: [], loops: [] } }),
    updateSettings: async () => {
      storeWrites.count++;
      return {};
    },
  })),
}));

// Workspace resolver: deterministic.
vi.mock('@/lib/workspace-auth', () => ({
  resolveWorkspaceIdForRequest: async () => 'default-workspace',
}));

// Audit: no-op (it's best-effort and not under test here).
vi.mock('@/lib/runtimes/audit', () => ({
  auditRuntimeMetadata: async () => [],
  logMismatches: () => {},
}));

// gateway-rpc (used by ping fallback) — stub.
vi.mock('@/lib/gateway-rpc', () => ({
  rpc: vi.fn(async () => ({ ok: true })),
}));

function makeReq(body?: any): any {
  return {
    headers: new Headers(),
    url: 'http://localhost/api/x',
    json: async () => body ?? {},
  };
}

const ORIG = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
  state.cloud = false;
  state.authImpl = () => ({ error: null, context: { scopes: ['write'] } });
  state.writeDenied = null;
  state.scaffoldCalls = 0;
  storeWrites.count = 0;
});
afterEach(() => {
  process.env = { ...ORIG };
});

describe('#1623 F-P1 — POST /api/ping auth gate', () => {
  test('cloud mode + unauthenticated → rejected, never reaches agent', async () => {
    state.cloud = true;
    state.authImpl = () => ({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
    const { POST } = await import('@/app/api/ping/route');
    const res = await POST(makeReq({ agentId: 'mikey', message: 'hi' }));
    expect(res.status).toBe(401);
  });

  test('cloud mode + authed but no write scope → rejected', async () => {
    state.cloud = true;
    state.writeDenied = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const { POST } = await import('@/app/api/ping/route');
    const res = await POST(makeReq({ agentId: 'mikey', message: 'hi' }));
    expect(res.status).toBe(403);
  });

  test('non-cloud (OSS/dev) → gate skipped, request proceeds to validation', async () => {
    state.cloud = false;
    const { POST } = await import('@/app/api/ping/route');
    // Missing message → 400 from the handler body proves it got PAST the gate.
    const res = await POST(makeReq({ agentId: 'mikey' }));
    expect(res.status).toBe(400);
  });
});

describe('#1623 F-P3 — GET /api/runtimes is read-only', () => {
  test('GET never scaffolds and never writes the store', async () => {
    const { GET } = await import('@/app/api/runtimes/route');
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    expect(state.scaffoldCalls).toBe(0);
    expect(storeWrites.count).toBe(0);
  });
});

describe('#1623 F-P3 — POST /api/runtimes scaffolds, gated', () => {
  test('cloud mode + unauthenticated → rejected, no scaffolding', async () => {
    state.cloud = true;
    state.authImpl = () => ({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
    const { POST } = await import('@/app/api/runtimes/route');
    const res = await POST(makeReq());
    expect(res.status).toBe(401);
    expect(state.scaffoldCalls).toBe(0);
  });

  test('authed (or OSS mode) → scaffolds via the helper', async () => {
    state.cloud = false; // OSS/dev: gate skipped
    const { POST } = await import('@/app/api/runtimes/route');
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(state.scaffoldCalls).toBe(1);
  });
});
