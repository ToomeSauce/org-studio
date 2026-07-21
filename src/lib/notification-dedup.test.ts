import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetForTests,
  _setPoolForTests,
  acquireClaim,
  completeClaim,
  releaseClaim,
} from './notification-dedup';

const clientQuery = vi.fn();
const poolQuery = vi.fn();
const releaseClient = vi.fn();
const fakePool = {
  connect: vi.fn(async () => ({ query: clientQuery, release: releaseClient })),
  query: poolQuery,
};

describe('#1780 notification delivery leases', () => {
  beforeEach(() => {
    clientQuery.mockReset();
    poolQuery.mockReset();
    releaseClient.mockReset();
    fakePool.connect.mockClear();
    _setPoolForTests(fakePool);
  });

  afterEach(() => {
    _resetForTests();
  });

  it('acquires a pending lease with a random ownership token and crash expiry', async () => {
    clientQuery.mockResolvedValueOnce({ rowCount: 1 });

    const claim = await acquireClaim('notify-task-c1-mikey', 'mikey', 'c1', 'task');

    expect(claim.acquired).toBe(true);
    expect(claim.token).toMatch(/^[0-9a-f-]{36}$/i);
    const [sql, params] = clientQuery.mock.calls[0];
    expect(sql).toContain("claim_state, claim_token, claim_expires_at");
    expect(sql).toContain("claim_state = 'pending'");
    expect(sql).toContain('claim_expires_at < NOW()');
    expect(params.slice(0, 4)).toEqual(['notify-task-c1-mikey', 'mikey', 'c1', 'task']);
    expect(params[4]).toBe(claim.token);
    expect(params[5]).toBe(120_000);
    expect(releaseClient).toHaveBeenCalledOnce();
  });

  it('reports an existing delivered or live pending claim without exposing a token', async () => {
    clientQuery.mockResolvedValueOnce({ rowCount: 0 });

    const claim = await acquireClaim('notify-task-c1-mikey', 'mikey', 'c1', 'task');

    expect(claim).toEqual({ acquired: false, token: null });
  });

  it('records delivered_at only when the same lease token completes', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 1 });

    const completed = await completeClaim('notify-task-c1-mikey', 'lease-token');

    expect(completed).toBe(true);
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toContain("claim_state = 'delivered'");
    expect(sql).toContain('delivered_at = NOW()');
    expect(sql).toContain('claim_token = $2');
    expect(params).toEqual(['notify-task-c1-mikey', 'lease-token']);
  });

  it('releases only the caller-owned pending lease after delivery failure', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 1 });

    const released = await releaseClaim('notify-task-c1-mikey', 'lease-token');

    expect(released).toBe(true);
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toContain('DELETE FROM org_studio_notification_dedup');
    expect(sql).toContain("claim_state = 'pending'");
    expect(sql).toContain('claim_token = $2');
    expect(params).toEqual(['notify-task-c1-mikey', 'lease-token']);
  });
});
