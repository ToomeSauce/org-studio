/**
 * api-tokens.ts (#1383, Phase 1)
 *
 * Per-agent / per-service-account API token storage. Tokens are stored as
 * SHA-256 hashes; plaintext is surfaced ONLY at mint time and never logged.
 *
 * This module is dormant until ENABLE_PER_AGENT_TOKENS=true. With the flag
 * off, none of the verify/mint functions affect request auth — the existing
 * global ORG_STUDIO_API_KEY remains the sole programmatic auth path. See
 * #1383 and #1290 for the cutover plan.
 *
 * Token shape on the wire: `osk_<32-byte-hex>` — 'osk' = OrgStudio Key. The
 * prefix is a hint to humans and log scrubbers; it is NOT used as a secret.
 */

import { createHash, randomBytes } from 'crypto';
import { withPgClient } from '@/lib/pg-pool';

export type ApiTokenScope = 'read' | 'write';

export interface ApiTokenRecord {
  id: string;
  userId: string;
  label: string;
  scope: ApiTokenScope;
  createdAt: number;
  createdBy: string | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
  workspaceId: string;
}

export interface ApiTokenMintResult {
  /** Plaintext token. Surfaced exactly once. NEVER persist or log this. */
  token: string;
  record: ApiTokenRecord;
}

const WORKSPACE_ID = 'default-workspace';
const TOKEN_PREFIX = 'osk_';

// ── Feature flag (read at request time so flips don't require redeploy) ──
export function perAgentTokensEnabled(): boolean {
  const v = (process.env.ENABLE_PER_AGENT_TOKENS || 'false').toLowerCase().trim();
  return v === 'true' || v === '1' || v === 'yes';
}

// ── Hashing ──
export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

function mintPlaintextToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString('hex');
}

function newRecordId(): string {
  return 'tok-' + randomBytes(6).toString('hex');
}

// ── Postgres helper ──
async function withClient<T>(fn: (client: any) => Promise<T>): Promise<T> {
  if (!process.env.DATABASE_URL) {
    throw new Error('api-tokens requires DATABASE_URL (file-mode is offline/dev-only, #1265)');
  }
  return withPgClient(fn, { max: 5 });
}

function rowToRecord(row: any): ApiTokenRecord {
  return {
    id: row.id,
    userId: row.user_id,
    label: row.label,
    scope: row.scope as ApiTokenScope,
    createdAt: typeof row.created_at === 'string' ? parseInt(row.created_at, 10) : row.created_at,
    createdBy: row.created_by ?? null,
    lastUsedAt: row.last_used_at == null ? null : (typeof row.last_used_at === 'string' ? parseInt(row.last_used_at, 10) : row.last_used_at),
    revokedAt: row.revoked_at == null ? null : (typeof row.revoked_at === 'string' ? parseInt(row.revoked_at, 10) : row.revoked_at),
    workspaceId: row.workspace_id,
  };
}

// ── Mint ──
export async function mintApiToken(input: {
  userId: string;
  label: string;
  scope: ApiTokenScope;
  createdBy?: string | null;
}): Promise<ApiTokenMintResult> {
  if (!input.userId || typeof input.userId !== 'string') {
    throw new Error('userId required');
  }
  if (!input.label || typeof input.label !== 'string') {
    throw new Error('label required (short human-readable description)');
  }
  if (input.scope !== 'read' && input.scope !== 'write') {
    throw new Error("scope must be 'read' or 'write'");
  }

  const plaintext = mintPlaintextToken();
  const tokenHash = hashToken(plaintext);
  const id = newRecordId();
  const createdAt = Date.now();

  const record = await withClient(async (client) => {
    const res = await client.query(
      `INSERT INTO org_studio_api_tokens
        (id, token_hash, user_id, label, scope, created_at, created_by, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [id, tokenHash, input.userId, input.label, input.scope, createdAt, input.createdBy ?? null, WORKSPACE_ID],
    );
    return rowToRecord(res.rows[0]);
  });

  return { token: plaintext, record };
}

// ── Verify ──
/**
 * Look up an active (non-revoked) token by plaintext. Bumps last_used_at.
 * Returns null on miss or revoked. Logs nothing about the token itself.
 *
 * Safe to call when the feature flag is off — caller should gate the call
 * with perAgentTokensEnabled() to avoid an unnecessary DB roundtrip.
 */
export async function verifyApiToken(plaintext: string): Promise<ApiTokenRecord | null> {
  if (typeof plaintext !== 'string' || plaintext.length === 0) return null;
  // Cheap shape check — bail fast on obvious non-tokens so we don't bother PG.
  if (!plaintext.startsWith(TOKEN_PREFIX) && plaintext.length < 32) return null;

  const tokenHash = hashToken(plaintext);

  return withClient(async (client) => {
    const res = await client.query(
      `SELECT * FROM org_studio_api_tokens
        WHERE token_hash = $1 AND workspace_id = $2 AND revoked_at IS NULL
        LIMIT 1`,
      [tokenHash, WORKSPACE_ID],
    );
    if (res.rows.length === 0) return null;
    const record = rowToRecord(res.rows[0]);

    // Bump last_used_at (best-effort; failures don't block auth).
    try {
      await client.query(
        `UPDATE org_studio_api_tokens SET last_used_at = $1 WHERE id = $2`,
        [Date.now(), record.id],
      );
    } catch (e) {
      console.warn('[api-tokens] last_used_at bump failed (non-fatal)');
    }
    return record;
  });
}

// ── List (admin) ──
/** Returns metadata only — token_hash never leaves Postgres. */
export async function listApiTokens(filter?: { userId?: string; includeRevoked?: boolean }): Promise<ApiTokenRecord[]> {
  return withClient(async (client) => {
    const where: string[] = ['workspace_id = $1'];
    const params: any[] = [WORKSPACE_ID];
    if (filter?.userId) {
      params.push(filter.userId);
      where.push(`user_id = $${params.length}`);
    }
    if (!filter?.includeRevoked) {
      where.push('revoked_at IS NULL');
    }
    const res = await client.query(
      `SELECT * FROM org_studio_api_tokens
         WHERE ${where.join(' AND ')}
         ORDER BY created_at DESC`,
      params,
    );
    return res.rows.map(rowToRecord);
  });
}

// ── Revoke ──
/** Soft-revoke. Returns true if a row was updated, false if id missing or already revoked. */
export async function revokeApiToken(id: string): Promise<boolean> {
  if (!id || typeof id !== 'string') return false;
  return withClient(async (client) => {
    const res = await client.query(
      `UPDATE org_studio_api_tokens
          SET revoked_at = $1
        WHERE id = $2 AND workspace_id = $3 AND revoked_at IS NULL
       RETURNING id`,
      [Date.now(), id, WORKSPACE_ID],
    );
    return res.rowCount > 0;
  });
}
