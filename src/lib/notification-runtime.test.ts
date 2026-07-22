import { describe, expect, it } from 'vitest';
import {
  hasConfiguredAgentRuntime,
  shouldRouteCommentNotificationsInline,
} from './notification-runtime';

describe('hasConfiguredAgentRuntime', () => {
  it('rejects store-only processes so they cannot steal durable notification claims', () => {
    expect(hasConfiguredAgentRuntime({ GATEWAY_URL: undefined, HERMES_URL: undefined })).toBe(false);
    expect(hasConfiguredAgentRuntime({ GATEWAY_URL: '  ', HERMES_URL: '' })).toBe(false);
  });

  it('allows either supported runtime bridge', () => {
    expect(hasConfiguredAgentRuntime({ GATEWAY_URL: 'ws://127.0.0.1:18789', HERMES_URL: undefined })).toBe(true);
    expect(hasConfiguredAgentRuntime({ GATEWAY_URL: undefined, HERMES_URL: 'http://127.0.0.1:8642' })).toBe(true);
  });
});

describe('shouldRouteCommentNotificationsInline', () => {
  it('defers Postgres-backed comments to the single LISTEN bridge', () => {
    expect(shouldRouteCommentNotificationsInline({
      DATABASE_URL: 'postgres://db/org_studio',
      GATEWAY_URL: 'ws://127.0.0.1:18789',
    })).toBe(false);
  });

  it('rejects explicitly store-only/worker-disabled processes', () => {
    expect(shouldRouteCommentNotificationsInline({
      GATEWAY_URL: 'ws://127.0.0.1:18789',
      OUTBOX_WORKER_DISABLED: 'true',
    })).toBe(false);
  });

  it('keeps file-mode runtime delivery for installs without LISTEN', () => {
    expect(shouldRouteCommentNotificationsInline({
      GATEWAY_URL: 'ws://127.0.0.1:18789',
    })).toBe(true);
  });
});
