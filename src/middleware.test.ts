/**
 * #1386 Phase 2 — Tests for the CORS allowlist middleware.
 *
 * Verifies:
 *  1. Allowed origin → response has Access-Control-Allow-Origin: <origin>.
 *  2. Disallowed origin → no Access-Control-Allow-Origin header set.
 *  3. OPTIONS preflight from allowed origin → 204 with full CORS headers.
 *  4. OPTIONS preflight from disallowed origin → 204 with NO CORS headers.
 *  5. ALLOWED_ORIGINS env override works.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { handleCors, allowedOrigins } from '../middleware';

const origEnv = process.env.ALLOWED_ORIGINS;

function makeReq(method: string, url: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(url, { method, headers });
}

describe('#1386 CORS middleware', () => {
  beforeEach(() => {
    delete process.env.ALLOWED_ORIGINS;
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = origEnv;
  });

  test('default allowlist contains expected origins', () => {
    const list = allowedOrigins();
    expect(list).toContain('https://app.orgstudio.dev');
    expect(list).toContain('http://localhost:4501');
    expect(list).toContain('http://localhost:3000');
  });

  test('ALLOWED_ORIGINS env overrides default', () => {
    process.env.ALLOWED_ORIGINS = 'https://example.com, https://other.dev';
    const list = allowedOrigins();
    expect(list).toEqual(['https://example.com', 'https://other.dev']);
  });

  test('allowed origin gets Access-Control-Allow-Origin header on GET', () => {
    const req = makeReq('GET', 'http://localhost:4501/api/store', {
      origin: 'http://localhost:3000',
    });
    const res = handleCors(req);
    expect(res).not.toBeNull();
    expect(res!.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3000');
    expect(res!.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(res!.headers.get('Vary')).toBe('Origin');
  });

  test('disallowed origin gets NO CORS headers', () => {
    const req = makeReq('GET', 'http://localhost:4501/api/store', {
      origin: 'https://evil.example.com',
    });
    const res = handleCors(req);
    expect(res).not.toBeNull();
    expect(res!.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  test('OPTIONS preflight from allowed origin → 204 with full CORS headers', () => {
    const req = makeReq('OPTIONS', 'http://localhost:4501/api/store', {
      origin: 'https://app.orgstudio.dev',
      'access-control-request-method': 'POST',
    });
    const res = handleCors(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(204);
    expect(res!.headers.get('Access-Control-Allow-Origin')).toBe('https://app.orgstudio.dev');
    expect(res!.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res!.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  test('OPTIONS preflight from disallowed origin → 204 with NO CORS headers', () => {
    const req = makeReq('OPTIONS', 'http://localhost:4501/api/store', {
      origin: 'https://evil.example.com',
      'access-control-request-method': 'POST',
    });
    const res = handleCors(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(204);
    expect(res!.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  test('non-/api paths return null (handler skips)', () => {
    const req = makeReq('GET', 'http://localhost:4501/dashboard', {
      origin: 'http://localhost:3000',
    });
    const res = handleCors(req);
    expect(res).toBeNull();
  });

  test('request without Origin header is allowed but gets no CORS headers (same-origin)', () => {
    const req = makeReq('POST', 'http://localhost:4501/api/store');
    const res = handleCors(req);
    expect(res).not.toBeNull();
    expect(res!.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
