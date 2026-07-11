import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const state = vi.hoisted(() => ({
  denied: null as NextResponse | null,
  workspaceId: 'ws-test',
  receipt: null as Record<string, unknown> | null,
}));

const cloudReadGateMock = vi.hoisted(() => vi.fn(async () => state.denied));
const resolveWorkspaceIdForRequestMock = vi.hoisted(() => vi.fn(async () => state.workspaceId));
const getWorkerPipelineReceiptMock = vi.hoisted(() => vi.fn(async () => state.receipt));

vi.mock('@/lib/read-gate', () => ({
  cloudReadGate: cloudReadGateMock,
}));

vi.mock('@/lib/workspace-auth', () => ({
  resolveWorkspaceIdForRequest: resolveWorkspaceIdForRequestMock,
}));

vi.mock('@/lib/worker-pipeline-receipt', () => ({
  getWorkerPipelineReceipt: getWorkerPipelineReceiptMock,
}));

function makeReq(): NextRequest {
  return new NextRequest('http://localhost/api/observability/worker-receipts/1706');
}

describe('GET /api/observability/worker-receipts/[ticketNumber] (#1706)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.denied = null;
    state.workspaceId = 'ws-test';
    state.receipt = null;
  });

  it('returns cloudReadGate denial unchanged', async () => {
    state.denied = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const { GET } = await import('@/app/api/observability/worker-receipts/[ticketNumber]/route');

    const res = await GET(makeReq(), { params: Promise.resolve({ ticketNumber: '1706' }) });

    expect(res.status).toBe(401);
    expect(resolveWorkspaceIdForRequestMock).not.toHaveBeenCalled();
    expect(getWorkerPipelineReceiptMock).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid/non-numeric ticketNumber', async () => {
    const { GET } = await import('@/app/api/observability/worker-receipts/[ticketNumber]/route');

    const res = await GET(makeReq(), { params: Promise.resolve({ ticketNumber: '17a6' }) });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid ticketNumber (must be numeric)' });
    expect(resolveWorkspaceIdForRequestMock).toHaveBeenCalledOnce();
    expect(getWorkerPipelineReceiptMock).not.toHaveBeenCalled();
  });

  it('returns 404 when helper has no receipt for the ticket', async () => {
    state.workspaceId = 'ws-1706';
    state.receipt = null;
    const { GET } = await import('@/app/api/observability/worker-receipts/[ticketNumber]/route');

    const res = await GET(makeReq(), { params: Promise.resolve({ ticketNumber: '1706' }) });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Worker receipt not found' });
    expect(resolveWorkspaceIdForRequestMock).toHaveBeenCalledOnce();
    expect(getWorkerPipelineReceiptMock).toHaveBeenCalledWith('ws-1706', 1706);
  });

  it('returns 200 with deterministic helper receipt JSON for known ticket', async () => {
    state.workspaceId = 'ws-1706';
    state.receipt = {
      ticketNumber: 1706,
      taskId: 'task-1706',
      statusPath: ['backlog', 'in-progress', 'done'],
      modelHistory: ['gpt-5.3-codex'],
      attribution: {
        tokensIn: 12,
        tokensOut: 4,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.0012,
        modelHistory: ['gpt-5.3-codex'],
      },
    };
    const { GET } = await import('@/app/api/observability/worker-receipts/[ticketNumber]/route');

    const res = await GET(makeReq(), { params: Promise.resolve({ ticketNumber: '1706' }) });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(state.receipt);
    expect(resolveWorkspaceIdForRequestMock).toHaveBeenCalledOnce();
    expect(getWorkerPipelineReceiptMock).toHaveBeenCalledWith('ws-1706', 1706);
  });
});
