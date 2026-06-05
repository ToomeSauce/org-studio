import { createHmac } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const originalEnv = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

function makeBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    agentId: 'mikey',
    metric: 'latency_p99',
    value: 120,
    threshold: 100,
    status: 'warning',
    ...overrides,
  });
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function makeReq(body: string, headers: Record<string, string> = {}): NextRequest {
  return {
    headers: new Headers(headers),
    text: async () => body,
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.resetModules();
  process.env.TELEGRAM_HEALTH_ALERTS_WEBHOOK_SECRET = 'test-health-secret';
  delete process.env.HEALTH_ALERTS_WEBHOOK_SECRET;
  delete process.env.TELEGRAM_HEALTH_ALERTS_WEBHOOK_URL;
  delete process.env.TELEGRAM_HEALTH_BOT_TOKEN;
  delete process.env.TELEGRAM_HEALTH_CHAT_ID;
});

afterEach(() => {
  restoreEnv();
});

describe('#1621 health webhook auth', () => {
  test('rejects unsigned POST (401)', async () => {
    const { POST } = await import('@/app/api/webhooks/health-alerts/route');
    const body = makeBody();

    const res = await POST(makeReq(body));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Unauthorized webhook request');
  });

  test('accepts valid HMAC signature header', async () => {
    const { POST } = await import('@/app/api/webhooks/health-alerts/route');
    const body = makeBody({ metric: 'error_rate' });
    const signature = sign(body, 'test-health-secret');

    const res = await POST(
      makeReq(body, { 'x-health-signature': `sha256=${signature}` })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
  });

  test('accepts valid shared-secret header', async () => {
    const { POST } = await import('@/app/api/webhooks/health-alerts/route');
    const body = makeBody({ metric: 'cpu_usage' });

    const res = await POST(
      makeReq(body, { 'x-health-secret': 'test-health-secret' })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
  });

  test('rejects bad signature (401)', async () => {
    const { POST } = await import('@/app/api/webhooks/health-alerts/route');
    const body = makeBody({ metric: 'memory_usage' });

    const res = await POST(
      makeReq(body, { 'x-health-signature': 'sha256=deadbeef' })
    );
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Unauthorized webhook request');
  });
});
