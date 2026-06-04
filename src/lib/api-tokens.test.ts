/**
 * #1383 — Tests for src/lib/api-tokens.ts pure helpers.
 *
 * We test the parts that don't need Postgres:
 *   - hashToken: deterministic SHA-256
 *   - perAgentTokensEnabled: env flag parsing
 *   - mintApiToken / verifyApiToken / listApiTokens / revokeApiToken:
 *     happy-path against a mocked pg client (no real DB)
 *
 * The point isn't 100% coverage; it's to prove that:
 *   1. Plaintext tokens are returned only at mint time and NEVER stored
 *      anywhere except as SHA-256 hashes.
 *   2. verify hits the correct WHERE clause (revoked_at IS NULL).
 *   3. revoke is soft (UPDATE, not DELETE) and idempotent.
 *   4. Scope must be 'read' or 'write'.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

// ── pg mock ─────────────────────────────────────────────────────────────
type Row = Record<string, any>;
interface PgState {
  rows: Row[];                 // simulated table
  queryLog: Array<{ sql: string; params: any[] }>;
}
const pgState: PgState = { rows: [], queryLog: [] };

vi.mock('pg', () => {
  const Pool = class {
      constructor(_: any) {}
      async connect() {
        return {
          query: async (sql: string, params: any[] = []) => {
            pgState.queryLog.push({ sql, params });

            if (/INSERT INTO org_studio_api_tokens/i.test(sql)) {
              const [id, token_hash, user_id, label, scope, created_at, created_by, workspace_id] = params;
              const row = {
                id, token_hash, user_id, label, scope, created_at,
                created_by, last_used_at: null, revoked_at: null, workspace_id,
              };
              pgState.rows.push(row);
              return { rows: [row], rowCount: 1 };
            }

            if (/UPDATE org_studio_api_tokens\s+SET last_used_at/i.test(sql)) {
              const [last_used_at, id] = params;
              const r = pgState.rows.find((x) => x.id === id);
              if (r) r.last_used_at = last_used_at;
              return { rows: [], rowCount: r ? 1 : 0 };
            }

            if (/UPDATE org_studio_api_tokens\s+SET revoked_at/i.test(sql)) {
              const [revoked_at, id, workspace_id] = params;
              const r = pgState.rows.find(
                (x) => x.id === id && x.workspace_id === workspace_id && x.revoked_at == null,
              );
              if (r) {
                r.revoked_at = revoked_at;
                return { rows: [{ id }], rowCount: 1 };
              }
              return { rows: [], rowCount: 0 };
            }

            if (/SELECT \* FROM org_studio_api_tokens\s+WHERE token_hash/i.test(sql)) {
              const [tokenHash, workspaceId] = params;
              const r = pgState.rows.find(
                (x) => x.token_hash === tokenHash && x.workspace_id === workspaceId && x.revoked_at == null,
              );
              return { rows: r ? [r] : [], rowCount: r ? 1 : 0 };
            }

            if (/SELECT \* FROM org_studio_api_tokens\s+WHERE/i.test(sql)) {
              // List query — filter by params (workspace_id, optional user_id)
              const workspaceId = params[0];
              const userId = params[1];
              const includesRevoked = !/revoked_at IS NULL/i.test(sql);
              let rows = pgState.rows.filter((x) => x.workspace_id === workspaceId);
              if (userId) rows = rows.filter((x) => x.user_id === userId);
              if (!includesRevoked) rows = rows.filter((x) => x.revoked_at == null);
              return { rows, rowCount: rows.length };
            }

            return { rows: [], rowCount: 0 };
          },
          release: () => {},
        };
      }
      async end() {}
    };
  return {
    Pool,
    default: { Pool },
  };
});

// Set DATABASE_URL so api-tokens doesn't bail with "file mode" error.
beforeEach(() => {
  pgState.rows = [];
  pgState.queryLog = [];
  process.env.DATABASE_URL = 'postgres://mock';
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('hashToken', () => {
  test('is deterministic SHA-256 hex', async () => {
    const { hashToken } = await import('@/lib/api-tokens');
    const a = hashToken('osk_test123');
    const b = hashToken('osk_test123');
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  test('different inputs produce different hashes', async () => {
    const { hashToken } = await import('@/lib/api-tokens');
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });
});

describe('perAgentTokensEnabled', () => {
  test('default (unset) is false', async () => {
    const { perAgentTokensEnabled } = await import('@/lib/api-tokens');
    delete process.env.ENABLE_PER_AGENT_TOKENS;
    expect(perAgentTokensEnabled()).toBe(false);
  });

  test('"true" enables', async () => {
    const { perAgentTokensEnabled } = await import('@/lib/api-tokens');
    process.env.ENABLE_PER_AGENT_TOKENS = 'true';
    expect(perAgentTokensEnabled()).toBe(true);
  });

  test('"1" enables', async () => {
    const { perAgentTokensEnabled } = await import('@/lib/api-tokens');
    process.env.ENABLE_PER_AGENT_TOKENS = '1';
    expect(perAgentTokensEnabled()).toBe(true);
  });

  test('"false" disables', async () => {
    const { perAgentTokensEnabled } = await import('@/lib/api-tokens');
    process.env.ENABLE_PER_AGENT_TOKENS = 'false';
    expect(perAgentTokensEnabled()).toBe(false);
  });
});

describe('mintApiToken', () => {
  test('returns plaintext token + hashed record; plaintext starts with osk_', async () => {
    const { mintApiToken } = await import('@/lib/api-tokens');
    const res = await mintApiToken({ userId: 'mikey', label: 'mikey laptop', scope: 'write' });
    expect(res.token).toMatch(/^osk_[a-f0-9]{64}$/);
    expect(res.record.userId).toBe('mikey');
    expect(res.record.label).toBe('mikey laptop');
    expect(res.record.scope).toBe('write');
    expect(res.record.revokedAt).toBeNull();
  });

  test('stores SHA-256 hash, NOT plaintext', async () => {
    const { mintApiToken, hashToken } = await import('@/lib/api-tokens');
    const res = await mintApiToken({ userId: 'mikey', label: 'l', scope: 'read' });
    const stored = pgState.rows[0];
    expect(stored.token_hash).toBe(hashToken(res.token));
    // SANITY: plaintext token must not appear anywhere in the stored row
    expect(JSON.stringify(stored)).not.toContain(res.token);
  });

  test('rejects invalid scope', async () => {
    const { mintApiToken } = await import('@/lib/api-tokens');
    await expect(mintApiToken({ userId: 'x', label: 'l', scope: 'admin' as any })).rejects.toThrow(/scope/);
  });

  test('requires userId and label', async () => {
    const { mintApiToken } = await import('@/lib/api-tokens');
    await expect(mintApiToken({ userId: '', label: 'l', scope: 'read' })).rejects.toThrow(/userId/);
    await expect(mintApiToken({ userId: 'x', label: '', scope: 'read' })).rejects.toThrow(/label/);
  });
});

describe('verifyApiToken', () => {
  test('returns record for valid plaintext token', async () => {
    const { mintApiToken, verifyApiToken } = await import('@/lib/api-tokens');
    const minted = await mintApiToken({ userId: 'ana', label: 'ana ci', scope: 'write' });
    const r = await verifyApiToken(minted.token);
    expect(r).not.toBeNull();
    expect(r!.userId).toBe('ana');
    expect(r!.scope).toBe('write');
  });

  test('returns null for unknown token', async () => {
    const { verifyApiToken } = await import('@/lib/api-tokens');
    const r = await verifyApiToken('osk_' + 'a'.repeat(64));
    expect(r).toBeNull();
  });

  test('returns null for revoked token', async () => {
    const { mintApiToken, verifyApiToken, revokeApiToken } = await import('@/lib/api-tokens');
    const minted = await mintApiToken({ userId: 'sam', label: 'old', scope: 'read' });
    await revokeApiToken(minted.record.id);
    const r = await verifyApiToken(minted.token);
    expect(r).toBeNull();
  });

  test('bumps last_used_at', async () => {
    const { mintApiToken, verifyApiToken } = await import('@/lib/api-tokens');
    const minted = await mintApiToken({ userId: 'mikey', label: 'l', scope: 'read' });
    await verifyApiToken(minted.token);
    expect(pgState.rows[0].last_used_at).toBeTypeOf('number');
  });
});

describe('revokeApiToken', () => {
  test('is soft — sets revoked_at, does not DELETE the row', async () => {
    const { mintApiToken, revokeApiToken } = await import('@/lib/api-tokens');
    const minted = await mintApiToken({ userId: 'henry', label: 'l', scope: 'read' });
    const ok = await revokeApiToken(minted.record.id);
    expect(ok).toBe(true);
    expect(pgState.rows.length).toBe(1); // row not deleted
    expect(pgState.rows[0].revoked_at).toBeTypeOf('number');
  });

  test('is idempotent — revoking twice returns false the second time', async () => {
    const { mintApiToken, revokeApiToken } = await import('@/lib/api-tokens');
    const minted = await mintApiToken({ userId: 'henry', label: 'l', scope: 'read' });
    expect(await revokeApiToken(minted.record.id)).toBe(true);
    expect(await revokeApiToken(minted.record.id)).toBe(false);
  });

  test('returns false for unknown id', async () => {
    const { revokeApiToken } = await import('@/lib/api-tokens');
    expect(await revokeApiToken('tok-does-not-exist')).toBe(false);
  });
});

describe('listApiTokens', () => {
  test('excludes revoked by default', async () => {
    const { mintApiToken, revokeApiToken, listApiTokens } = await import('@/lib/api-tokens');
    const a = await mintApiToken({ userId: 'mikey', label: 'a', scope: 'read' });
    await mintApiToken({ userId: 'mikey', label: 'b', scope: 'write' });
    await revokeApiToken(a.record.id);
    const tokens = await listApiTokens();
    expect(tokens.length).toBe(1);
    expect(tokens[0].label).toBe('b');
  });

  test('includes revoked when asked', async () => {
    const { mintApiToken, revokeApiToken, listApiTokens } = await import('@/lib/api-tokens');
    const a = await mintApiToken({ userId: 'mikey', label: 'a', scope: 'read' });
    await revokeApiToken(a.record.id);
    const tokens = await listApiTokens({ includeRevoked: true });
    expect(tokens.length).toBe(1);
    expect(tokens[0].revokedAt).toBeTypeOf('number');
  });

  test('filters by userId', async () => {
    const { mintApiToken, listApiTokens } = await import('@/lib/api-tokens');
    await mintApiToken({ userId: 'mikey', label: 'a', scope: 'read' });
    await mintApiToken({ userId: 'ana', label: 'b', scope: 'read' });
    const tokens = await listApiTokens({ userId: 'ana' });
    expect(tokens.length).toBe(1);
    expect(tokens[0].userId).toBe('ana');
  });
});
