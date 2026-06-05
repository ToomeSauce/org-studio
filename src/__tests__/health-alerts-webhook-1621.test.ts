/**
 * #1621 (T-C) — health-alerts webhook signature verification (audit F-P2).
 *
 * Tests the canonical verifier in lib/webhook-auth.mjs that both the live
 * server.mjs handler and the Next.js fallback route use. Covers: fail-open when
 * unconfigured (OSS/dev parity), valid/invalid HMAC, valid/invalid shared
 * secret, missing proof when a secret is set, and the critical tamper case
 * (valid HMAC over a different body must be rejected).
 */
import { describe, it, expect } from 'vitest';
// Import the SAME runtime module the handlers use (single source, no twin).
import {
  verifyWebhookSignature,
  computeHmacHex,
  timingSafeEqualStr,
} from '../../lib/webhook-auth.mjs';

const SECRET = 'topsecret-shared-key';
const BODY = JSON.stringify({ agentId: 'mikey', metric: 'error_rate', value: 15.2, threshold: 10, status: 'warning' });

/** case-insensitive header getter from a plain map */
function hdr(map: Record<string, string>) {
  const lower: Record<string, string> = {};
  for (const k of Object.keys(map)) lower[k.toLowerCase()] = map[k];
  return (name: string) => lower[name.toLowerCase()] ?? '';
}

describe('verifyWebhookSignature — fail-open when unconfigured', () => {
  it('no secret (undefined) → open, not enforced', () => {
    const r = verifyWebhookSignature(BODY, hdr({}), undefined);
    expect(r.ok).toBe(true);
    expect(r.enforced).toBe(false);
    expect(r.reason).toBe('no-secret-configured');
  });
  it('empty/whitespace secret → open', () => {
    expect(verifyWebhookSignature(BODY, hdr({}), '').ok).toBe(true);
    expect(verifyWebhookSignature(BODY, hdr({}), '   ').ok).toBe(true);
  });
});

describe('verifyWebhookSignature — HMAC path (secret configured)', () => {
  it('valid HMAC as "sha256=<hex>" → ok', () => {
    const sig = 'sha256=' + computeHmacHex(BODY, SECRET);
    const r = verifyWebhookSignature(BODY, hdr({ 'X-Signature': sig }), SECRET);
    expect(r.ok).toBe(true);
    expect(r.enforced).toBe(true);
    expect(r.reason).toBe('valid-hmac');
  });
  it('valid HMAC as bare hex (no prefix) → ok', () => {
    const r = verifyWebhookSignature(BODY, hdr({ 'X-Signature': computeHmacHex(BODY, SECRET) }), SECRET);
    expect(r.ok).toBe(true);
  });
  it('accepts X-Hub-Signature-256 header alias', () => {
    const sig = 'sha256=' + computeHmacHex(BODY, SECRET);
    const r = verifyWebhookSignature(BODY, hdr({ 'X-Hub-Signature-256': sig }), SECRET);
    expect(r.ok).toBe(true);
  });
  it('wrong HMAC value → rejected', () => {
    const r = verifyWebhookSignature(BODY, hdr({ 'X-Signature': 'sha256=deadbeef' }), SECRET);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad-signature');
  });
  it('TAMPER: valid HMAC over a DIFFERENT body → rejected (signature binds to payload)', () => {
    const sigForOther = 'sha256=' + computeHmacHex('{"agentId":"evil","metric":"x"}', SECRET);
    const r = verifyWebhookSignature(BODY, hdr({ 'X-Signature': sigForOther }), SECRET);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad-signature');
  });
  it('HMAC computed with WRONG secret → rejected', () => {
    const sig = 'sha256=' + computeHmacHex(BODY, 'not-the-secret');
    const r = verifyWebhookSignature(BODY, hdr({ 'X-Signature': sig }), SECRET);
    expect(r.ok).toBe(false);
  });
});

describe('verifyWebhookSignature — direct shared-secret path', () => {
  it('correct X-Webhook-Secret → ok', () => {
    const r = verifyWebhookSignature(BODY, hdr({ 'X-Webhook-Secret': SECRET }), SECRET);
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('valid-secret');
  });
  it('wrong X-Webhook-Secret → rejected', () => {
    const r = verifyWebhookSignature(BODY, hdr({ 'X-Webhook-Secret': 'nope' }), SECRET);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad-signature');
  });
});

describe('verifyWebhookSignature — missing proof when secret set', () => {
  it('no signature headers at all → rejected (missing-signature)', () => {
    const r = verifyWebhookSignature(BODY, hdr({}), SECRET);
    expect(r.ok).toBe(false);
    expect(r.enforced).toBe(true);
    expect(r.reason).toBe('missing-signature');
  });
  it('empty signature header value → treated as missing/rejected', () => {
    const r = verifyWebhookSignature(BODY, hdr({ 'X-Signature': '' }), SECRET);
    expect(r.ok).toBe(false);
  });
});

describe('timingSafeEqualStr', () => {
  it('equal strings → true', () => {
    expect(timingSafeEqualStr('abcdef', 'abcdef')).toBe(true);
  });
  it('different but same length → false', () => {
    expect(timingSafeEqualStr('abcdef', 'abcdeX')).toBe(false);
  });
  it('different lengths → false (no throw)', () => {
    expect(timingSafeEqualStr('short', 'a-much-longer-value')).toBe(false);
  });
  it('null/undefined safe → false vs non-empty', () => {
    expect(timingSafeEqualStr(undefined as any, 'x')).toBe(false);
    expect(timingSafeEqualStr(null as any, '')).toBe(true); // both empty
  });
});
