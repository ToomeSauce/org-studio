/**
 * webhook-auth.mjs — shared signature/secret verification for inbound webhooks.
 *
 * Canonical (single-source) implementation, authored as runtime ESM so the
 * custom server (server.mjs) can import it directly with no build step. The
 * Next.js route handler and the vitest suite import THIS same module, so there
 * is exactly one implementation of the check (no TS/JS twin drift).
 *
 * #1621 (T-C), from the #1610 audit (F-P2): POST /api/webhooks/health-alerts
 * was unauthenticated while its comment falsely claimed signature verification.
 *
 * Verification model (a webhook sender must satisfy ONE of):
 *   1. HMAC-SHA256 over the EXACT raw request body, keyed by the shared secret,
 *      sent as `X-Signature: sha256=<hex>` (GitHub-style; `x-health-signature`
 *      and `x-hub-signature-256` also accepted). Preferred.
 *   2. The shared secret presented directly as `X-Webhook-Secret: <secret>`
 *      (`x-health-secret` also accepted); constant-time compared.
 *
 * Secret source: `TELEGRAM_HEALTH_ALERTS_WEBHOOK_SECRET` or, as an alias,
 * `HEALTH_ALERTS_WEBHOOK_SECRET` (see resolveWebhookSecret).
 *
 * Fail-open ONLY when no secret is configured (neither env var set/non-empty)
 * — this preserves existing OSS/localhost/dev behavior where the
 * endpoint was open, mirroring the read-gate's "configured = enforced, else
 * open" philosophy. Anywhere the secret IS set (i.e. cloud/prod), unsigned or
 * incorrectly-signed requests are rejected.
 */
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Resolve the configured webhook secret from env, accepting both the
 * Telegram-family name and the generic name (either works; first non-empty wins).
 */
export function resolveWebhookSecret(env = process.env) {
  return (
    env.TELEGRAM_HEALTH_ALERTS_WEBHOOK_SECRET ||
    env.HEALTH_ALERTS_WEBHOOK_SECRET ||
    ''
  ).trim();
}

/** Header names accepted for the HMAC signature (first non-empty wins). */
export const SIGNATURE_HEADERS = ['x-signature', 'x-hub-signature-256', 'x-health-signature', 'x-health-alerts-signature'];
/** Header names accepted for the raw shared secret (first non-empty wins). */
export const SHARED_SECRET_HEADERS = ['x-webhook-secret', 'x-health-secret', 'x-health-alerts-secret'];

/** Constant-time string compare that won't throw on unequal lengths. */
export function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) {
    // Still do a compare against self to keep timing roughly constant, then fail.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** HMAC-SHA256(rawBody, secret) as lowercase hex. */
export function computeHmacHex(rawBody, secret) {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/**
 * @param {string} rawBody  EXACT raw request body bytes as received (pre-parse).
 * @param {(name:string)=>(string|null|undefined)} getHeader  case-insensitive header getter.
 * @param {string|undefined} secret  the shared secret (HEALTH_ALERTS_WEBHOOK_SECRET).
 * @returns {{ ok: boolean, reason: string, enforced: boolean }}
 *   ok       — whether the request is authorized to proceed
 *   reason   — short machine-ish reason ('no-secret-configured' | 'valid-hmac' |
 *              'valid-secret' | 'missing-signature' | 'bad-signature')
 *   enforced — whether a secret was configured (i.e. whether auth was actually checked)
 */
export function verifyWebhookSignature(rawBody, getHeader, secret) {
  const s = (secret ?? '').trim();
  if (!s) {
    // No secret configured → preserve legacy open behavior (OSS/dev parity).
    return { ok: true, reason: 'no-secret-configured', enforced: false };
  }

  const h = (name) => {
    const v = getHeader(name);
    return typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim());
  };
  const firstHeader = (names) => {
    for (const n of names) {
      const v = h(n);
      if (v) return v;
    }
    return '';
  };

  // Path 1: HMAC signature header (preferred).
  const sigHeaderRaw = firstHeader(SIGNATURE_HEADERS);
  if (sigHeaderRaw) {
    // Accept both "sha256=<hex>" and bare "<hex>".
    const provided = sigHeaderRaw.replace(/^sha256=/i, '').trim().toLowerCase();
    const expected = computeHmacHex(rawBody ?? '', s);
    if (timingSafeEqualStr(provided, expected)) {
      return { ok: true, reason: 'valid-hmac', enforced: true };
    }
    return { ok: false, reason: 'bad-signature', enforced: true };
  }

  // Path 2: direct shared-secret header.
  const secretHeader = firstHeader(SHARED_SECRET_HEADERS);
  if (secretHeader) {
    if (timingSafeEqualStr(secretHeader, s)) {
      return { ok: true, reason: 'valid-secret', enforced: true };
    }
    return { ok: false, reason: 'bad-signature', enforced: true };
  }

  // Secret configured but caller sent neither proof.
  return { ok: false, reason: 'missing-signature', enforced: true };
}
