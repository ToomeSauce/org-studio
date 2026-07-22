import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendToAgent = vi.fn();
const clearInFlightAgent = vi.fn();

vi.mock('@/lib/runtimes/registry', () => ({ sendToAgent }));
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithContext: async () => ({ context: { userId: 'test', method: 'apikey' } }),
  requireWriteScope: () => null,
}));
vi.mock('@/lib/store-provider', () => ({
  getStoreProviderAllWorkspaces: () => ({ read: async () => ({}) }),
}));
vi.mock('@/app/api/scheduler/route', () => ({ clearInFlightAgent }));
vi.mock('@/lib/dispatch-ledger', () => ({
  completeDispatch: vi.fn(),
  recordInternalCallFailure: vi.fn(),
  captureSessionUsageDelta: vi.fn(),
}));
vi.mock('@/lib/gateway-rpc', () => ({ rpc: vi.fn() }));

describe('outbox drain terminal delivery failure', () => {
  beforeEach(() => {
    sendToAgent.mockReset();
    clearInFlightAgent.mockReset();
    sendToAgent.mockRejectedValue(new Error('runtime unavailable'));
  });

  async function post(finalAttempt: boolean) {
    const { POST } = await import('./route');
    return POST({
      json: async () => ({
        outboxId: 'outbox-1',
        agentId: 'hermes-gem',
        idempotencyKey: 'dispatch-hermes-gem-1',
        finalAttempt,
        payload: {
          message: 'work',
          sessionKey: 'agent:hermes-gem:main',
          onCompleteKind: 'redispatch',
        },
      }),
    } as any);
  }

  it('keeps in-flight while the durable row still has retries', async () => {
    const response = await post(false);
    expect(response.status).toBe(502);
    expect(clearInFlightAgent).not.toHaveBeenCalled();
  });

  it('clears in-flight immediately when the final attempt fails', async () => {
    const response = await post(true);
    expect(response.status).toBe(502);
    expect(clearInFlightAgent).toHaveBeenCalledWith('hermes-gem');
  });
});
