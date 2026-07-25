import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HermesRuntime } from './hermes';

const ORIGINAL_ENV = { ...process.env };

describe('HermesRuntime API authentication', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.HOME = '/tmp/org-studio-hermes-auth-empty-home';
    process.env.HERMES_URL = 'http://127.0.0.1:9864';
    process.env.HERMES_API_KEY = 'test-hermes-api-key';
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
  });

  it('authenticates discovery probes and model reads', async () => {
    const fetchMock = vi.fn(async (input: string | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/health')) return new Response('{}', { status: 200 });
      if (url.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'Gem' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const runtime = new HermesRuntime();
    const agents = await runtime.discover();

    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe('hermes-unknown');
    for (const [, init] of fetchMock.mock.calls) {
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-hermes-api-key');
    }
  });

  it('authenticates run creation', async () => {
    const fetchMock = vi.fn(async (input: string | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/health')) return new Response('{}', { status: 200 });
      if (url.endsWith('/v1/runs')) {
        return new Response(JSON.stringify({ run_id: 'run-auth-1' }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const runtime = new HermesRuntime();
    const result = await runtime.send('hermes-unknown', 'test dispatch');

    expect(result.runId).toBe('run-auth-1');
    const runCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/v1/runs'));
    expect(runCall).toBeDefined();
    expect((runCall?.[1]?.headers as Record<string, string>).Authorization).toBe('Bearer test-hermes-api-key');
  });

  it('does not report completion when run creation is rejected', async () => {
    const onComplete = vi.fn();
    const fetchMock = vi.fn(async (input: string | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/health')) return new Response('{}', { status: 200 });
      if (url.endsWith('/v1/runs')) return new Response('unauthorized', { status: 401 });
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const runtime = new HermesRuntime();
    await expect(runtime.send('hermes-unknown', 'test dispatch', { onComplete }))
      .rejects.toThrow('Hermes /v1/runs error 401');
    expect(onComplete).not.toHaveBeenCalled();
  });
});
