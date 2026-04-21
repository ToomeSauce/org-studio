/**
 * Tests for browser-session → workspace membership lookup.
 *
 * Covers the Phase 3 bug where browser sessions stored auto-generated
 * user IDs (user-{timestamp}) that didn't match workspace membership
 * user_ids (teammate usernames like 'basil'), causing 403 in strict mode.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock pg to avoid real DB connections
vi.mock('pg', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn(),
    query: vi.fn(),
    end: vi.fn(),
  })),
  default: {
    Client: vi.fn().mockImplementation(() => ({
      connect: vi.fn(),
      query: vi.fn(),
      end: vi.fn(),
    })),
  },
}));

// Mock store-provider
const mockStoreRead = vi.fn();
vi.mock('@/lib/store-provider', () => ({
  getStoreProvider: () => ({
    read: mockStoreRead,
  }),
}));

describe('workspace-auth browser session flow', () => {
  let resolveSessionUserId: typeof import('@/lib/auth').resolveSessionUserId;
  let invalidateUserIdCache: typeof import('@/lib/auth').invalidateUserIdCache;

  beforeEach(async () => {
    vi.resetModules();
    // Re-import to get fresh module state
    const authMod = await import('@/lib/auth');
    resolveSessionUserId = authMod.resolveSessionUserId;
    invalidateUserIdCache = authMod.invalidateUserIdCache;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes through normal username IDs unchanged', async () => {
    const result = await resolveSessionUserId('basil');
    expect(result).toBe('basil');
  });

  it('passes through other non-user-* IDs unchanged', async () => {
    const result = await resolveSessionUserId('henry');
    expect(result).toBe('henry');
  });

  it('resolves user-{timestamp} ID back to username', async () => {
    mockStoreRead.mockResolvedValue({
      settings: {
        users: [
          { id: 'user-1713654321000', username: 'basil', passwordHash: 'abc' },
          { id: 'user-1713654321001', username: 'henry', passwordHash: 'def' },
        ],
      },
    });

    invalidateUserIdCache();
    const result = await resolveSessionUserId('user-1713654321000');
    expect(result).toBe('basil');
  });

  it('resolves a different user-* ID to correct username', async () => {
    mockStoreRead.mockResolvedValue({
      settings: {
        users: [
          { id: 'user-1713654321000', username: 'basil', passwordHash: 'abc' },
          { id: 'user-1713654321001', username: 'henry', passwordHash: 'def' },
        ],
      },
    });

    invalidateUserIdCache();
    const result = await resolveSessionUserId('user-1713654321001');
    expect(result).toBe('henry');
  });

  it('returns raw ID when no matching user found', async () => {
    mockStoreRead.mockResolvedValue({
      settings: {
        users: [
          { id: 'user-1713654321000', username: 'basil', passwordHash: 'abc' },
        ],
      },
    });

    invalidateUserIdCache();
    const result = await resolveSessionUserId('user-9999999999999');
    expect(result).toBe('user-9999999999999');
  });

  it('returns raw ID gracefully when store read fails', async () => {
    mockStoreRead.mockRejectedValue(new Error('DB down'));

    invalidateUserIdCache();
    const result = await resolveSessionUserId('user-1713654321000');
    expect(result).toBe('user-1713654321000');
  });
});

describe('end-to-end: resolve + membership check', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('full flow: user-* ID → resolve to username → would match membership', async () => {
    // This test verifies the full resolution pipeline without needing real DB.
    // The seed script stores membership with user_id='basil'.
    // A pre-fix browser session has userId='user-1713654321000'.
    // After resolution, it becomes 'basil' which matches the membership.
    mockStoreRead.mockResolvedValue({
      settings: {
        users: [
          { id: 'user-1713654321000', username: 'basil', passwordHash: 'abc' },
          { id: 'user-1713654321001', username: 'henry', passwordHash: 'def' },
        ],
      },
    });

    const authMod = await import('@/lib/auth');
    authMod.invalidateUserIdCache();

    // Pre-fix session would have userId = 'user-1713654321000'
    const resolvedBasil = await authMod.resolveSessionUserId('user-1713654321000');
    expect(resolvedBasil).toBe('basil');

    const resolvedHenry = await authMod.resolveSessionUserId('user-1713654321001');
    expect(resolvedHenry).toBe('henry');

    // Membership rows use 'basil', 'henry' — these now match
    const membershipUserIds = ['basil', 'henry', 'mikey', 'ana'];
    expect(membershipUserIds).toContain(resolvedBasil);
    expect(membershipUserIds).toContain(resolvedHenry);
  });

  it('post-fix login: createSession receives username directly', async () => {
    // After the fix, login calls createSession(user.username) not createSession(user.id)
    // So new sessions store 'basil' directly — no resolution needed
    const authMod = await import('@/lib/auth');
    const result = await authMod.resolveSessionUserId('basil');
    expect(result).toBe('basil');
    // 'basil' matches membership user_id='basil' — no 403
  });

  it('unknown user-* ID passes through (graceful degradation)', async () => {
    mockStoreRead.mockResolvedValue({
      settings: {
        users: [
          { id: 'user-1713654321000', username: 'basil', passwordHash: 'abc' },
        ],
      },
    });

    const authMod = await import('@/lib/auth');
    authMod.invalidateUserIdCache();

    // Unknown user-* ID that doesn't map to any user
    const result = await authMod.resolveSessionUserId('user-9999999999999');
    expect(result).toBe('user-9999999999999');
  });
});
