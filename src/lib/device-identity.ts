/**
 * Device identity for Gateway handshake
 * Ed25519 keypair — matches OpenClaw's deriveDeviceIdFromPublicKey:
 *   deviceId = SHA-256(raw 32-byte public key) as hex
 *   publicKey = base64url(raw 32-byte public key)
 *   signature = base64url(Ed25519 sign(nonce:signedAt))
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const IDENTITY_PATH = path.join(
  process.env.HOME || '/tmp',
  '.mc-device-identity.json'
);

interface StoredIdentity {
  deviceId: string;
  publicKeyBase64Url: string;
  privateKeyPem: string;
  publicKeyPem: string;
}

let cached: StoredIdentity | null = null;

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function loadOrGenerate(): StoredIdentity {
  // Try loading from disk
  try {
    if (fs.existsSync(IDENTITY_PATH)) {
      const stored: StoredIdentity = JSON.parse(fs.readFileSync(IDENTITY_PATH, 'utf-8'));
      if (stored.deviceId && stored.publicKeyBase64Url && stored.privateKeyPem) {
        return stored;
      }
    }
  } catch {}

  // Generate Ed25519 keypair
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // Extract raw 32-byte public key from SPKI DER
  const spkiDer = crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
  // Ed25519 SPKI = 12 byte prefix + 32 byte key
  const rawPub = spkiDer.subarray(spkiDer.length - 32);

  const deviceId = crypto.createHash('sha256').update(rawPub).digest('hex');
  const publicKeyBase64Url = base64UrlEncode(rawPub);

  const identity: StoredIdentity = {
    deviceId,
    publicKeyBase64Url,
    privateKeyPem: privateKey,
    publicKeyPem: publicKey,
  };

  // Persist
  try {
    fs.writeFileSync(IDENTITY_PATH, JSON.stringify(identity, null, 2), { mode: 0o600 });
  } catch (e) {
    console.warn('[device-identity] Failed to persist:', e);
  }

  return identity;
}

export function getDeviceIdentity() {
  if (!cached) cached = loadOrGenerate();
  return cached;
}

/**
 * Sign challenge using Gateway's v2 payload format:
 * v2|deviceId|clientId|clientMode|role|scopes|signedAt|token|nonce
 */
export function signChallenge(
  nonce: string,
  opts: {
    clientId: string;
    clientMode: string;
    role: string;
    scopes: string[];
    token: string;
  }
): { signature: string; signedAt: number } {
  const identity = getDeviceIdentity();
  const signedAt = Date.now();

  const payload = [
    'v2',
    identity.deviceId,
    opts.clientId,
    opts.clientMode,
    opts.role,
    opts.scopes.join(','),
    String(signedAt),
    opts.token,
    nonce,
  ].join('|');

  const sig = crypto.sign(null, Buffer.from(payload, 'utf-8'), identity.privateKeyPem);
  const signature = base64UrlEncode(sig);

  return { signature, signedAt };
}
