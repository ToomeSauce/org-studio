/**
 * GitHub App auth for worker provisioning (#1660, W-5).
 *
 * Design-doc open question 2 resolved toward GitHub App (auditable,
 * revocable, org-scoped) over per-repo deploy keys. Two credential paths:
 *
 *   1. Same-repo dogfood (v1 default): the workflow's built-in
 *      `GITHUB_TOKEN` — which IS a GitHub App installation token (the
 *      "github-actions" app), ephemeral, auto-revoked when the job ends.
 *      Teardown is free; nothing for us to mint. This module isn't used.
 *
 *   2. Cross-repo / org-scoped (custom App): mint an App JWT (RS256,
 *      10-min expiry) from ORG_WORKER_APP_ID + private key, exchange it
 *      for an installation token scoped to the target repos. This module
 *      implements that flow with an injectable fetch so tests never
 *      touch the network. App REGISTRATION (creating the App, installing
 *      it on the org) is a one-time human browser step — see
 *      docs/design/execution-workers.md § provisioning setup.
 *
 * Pure crypto via node:crypto — no jsonwebtoken dependency needed for a
 * single RS256 sign.
 */
import { createSign } from 'crypto';

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Mint a GitHub App JWT (RS256). Valid ≤10 min; iat backdated 60s per
 * GitHub's clock-drift guidance.
 */
export function mintAppJwt(appId: string, privateKeyPem: string, nowMs: number = Date.now()): string {
  const iat = Math.floor(nowMs / 1000) - 60;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat, exp: iat + 600, iss: appId }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKeyPem);
  return `${header}.${payload}.${b64url(signature)}`;
}

export interface InstallationTokenResult {
  token: string;
  expiresAt: string;
}

export type FetchLike = (url: string, init?: any) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<any>;
}>;

/**
 * Exchange an App JWT for an installation access token, optionally scoped
 * down to specific repositories (principle of least privilege — pass the
 * target repo so a leaked token can't touch the rest of the org).
 */
export async function getInstallationToken(opts: {
  appJwt: string;
  installationId: string;
  repositories?: string[]; // bare repo names, e.g. ["org-studio"]
  fetchImpl?: FetchLike;
}): Promise<InstallationTokenResult> {
  const f: FetchLike = opts.fetchImpl || (fetch as any);
  const res = await f(
    `https://api.github.com/app/installations/${opts.installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.appJwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(opts.repositories?.length ? { repositories: opts.repositories } : {}),
    },
  );
  if (!res.ok) {
    // Deliberately no response-body echo: error bodies can carry request
    // context; the status code is enough to debug (doneWhen: no secrets in logs).
    throw new Error(`installation token exchange failed: HTTP ${res.status}`);
  }
  const data = await res.json();
  if (!data?.token) throw new Error('installation token exchange returned no token');
  return { token: data.token, expiresAt: data.expires_at || '' };
}

/** Redact anything token-shaped from a string destined for logs/comments. */
export function redactTokens(s: string): string {
  return s
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '[REDACTED-TOKEN]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED-JWT]')
    .replace(/-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g, '[REDACTED-KEY]')
    .replace(/x-access-token:[^@\s]+@/g, 'x-access-token:[REDACTED]@');
}
