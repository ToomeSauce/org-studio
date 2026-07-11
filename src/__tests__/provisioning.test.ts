/**
 * Tests for W-5 provisioning (#1660): GitHub App auth + ProvisioningAdapter.
 *
 * The JWT test generates a REAL RSA keypair and VERIFIES the signature +
 * claims (not string-matching) — same executed-proof principle as the W-4
 * deny-guard tests. Adapter tests drive GhActionsAdapter through fake
 * fetch implementations covering dispatch → run-discovery → poll → outcome.
 */
import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, createVerify } from 'crypto';
import {
  mintAppJwt,
  getInstallationToken,
  redactTokens,
} from '@/lib/workers/github-app-auth';
import {
  LocalProcessAdapter,
  GhActionsAdapter,
  adapterForMode,
} from '@/lib/workers/provisioning';
import type { WorkerRunResult } from '@/lib/workers/engine-codex';

// ---------------------------------------------------------------------------
// GitHub App JWT
// ---------------------------------------------------------------------------

describe('#1660: GitHub App JWT', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  it('mints an RS256 JWT with verifiable signature and correct claims', () => {
    const now = 1_700_000_000_000;
    const jwt = mintAppJwt('12345', privateKey, now);
    const [h, p, s] = jwt.split('.');
    expect(h && p && s).toBeTruthy();

    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });

    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(payload.iss).toBe('12345');
    expect(payload.iat).toBe(Math.floor(now / 1000) - 60); // clock-drift backdate
    expect(payload.exp).toBe(payload.iat + 600); // 10-min validity

    // EXECUTED proof: verify the signature against the public key.
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${h}.${p}`);
    expect(verifier.verify(publicKey, Buffer.from(s, 'base64url'))).toBe(true);
  });

  it('tampered payload fails verification', () => {
    const jwt = mintAppJwt('12345', privateKey);
    const [h, , s] = jwt.split('.');
    const evil = Buffer.from(JSON.stringify({ iss: '99999', iat: 0, exp: 9999999999 })).toString('base64url');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${h}.${evil}`);
    expect(verifier.verify(publicKey, Buffer.from(s, 'base64url'))).toBe(false);
  });
});

describe('#1660: installation token exchange', () => {
  it('scopes down to requested repositories and returns the token', async () => {
    let captured: any = null;
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      captured = { url, init };
      return {
        ok: true,
        status: 201,
        json: async () => ({ token: 'ghs_abc123installation', expires_at: '2026-07-07T22:00:00Z' }),
      };
    });
    const r = await getInstallationToken({
      appJwt: 'jwt.here.sig',
      installationId: '777',
      repositories: ['org-studio'],
      fetchImpl,
    });
    expect(r.token).toBe('ghs_abc123installation');
    expect(captured.url).toContain('/app/installations/777/access_tokens');
    expect(JSON.parse(captured.init.body)).toEqual({ repositories: ['org-studio'] });
    expect(captured.init.headers.Authorization).toBe('Bearer jwt.here.sig');
  });

  it('failure surfaces status code but never echoes a response body', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ message: 'secret-laden error body' }),
    }));
    await expect(
      getInstallationToken({ appJwt: 'j', installationId: '1', fetchImpl }),
    ).rejects.toThrow(/HTTP 401/);
  });
});

describe('#1660: token redaction (no secrets in logs)', () => {
  it('redacts PATs, JWTs, private keys, and embedded basic-auth tokens', () => {
    const dirty = [
      'pushed with ghp_' + 'A'.repeat(36),
      'jwt eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ',
      '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----',
      'https://x-access-token:ghs_secret@github.com/o/r.git',
    ].join('\n');
    const clean = redactTokens(dirty);
    expect(clean).not.toContain('ghp_');
    expect(clean).not.toContain('eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxIn0');
    expect(clean).not.toContain('BEGIN PRIVATE KEY');
    expect(clean).not.toContain('ghs_secret');
    expect(clean).toContain('[REDACTED-TOKEN]');
    expect(clean).toContain('[REDACTED-JWT]');
    expect(clean).toContain('[REDACTED-KEY]');
    expect(clean).toContain('x-access-token:[REDACTED]@');
  });
});

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

const OK_ENGINE: WorkerRunResult = {
  ok: true, exitCode: 0, durationMs: 500, commands: [], fileChanges: [],
  messages: ['done'], errors: [], usage: null, rawEventCount: 1,
};

describe('#1660: LocalProcessAdapter', () => {
  it('wraps the W-2 engine path and threads engineOpts', async () => {
    let captured: any = null;
    const adapter = new LocalProcessAdapter(vi.fn(async (o: any) => {
      captured = o;
      return OK_ENGINE;
    }));
    const r = await adapter.provision({
      repo: 'o/r', ticketNumber: 1, title: 'T', brief: 'B', model: 'm',
      timeoutMs: 1000, localRepoPath: '/tmp',
      engineOpts: { sandboxMode: 'workspace-write', argvPrefix: ['systemd-run'] },
    });
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('local-process');
    expect(r.engineResult).toBe(OK_ENGINE);
    expect(captured.sandboxMode).toBe('workspace-write');
    expect(captured.argvPrefix).toEqual(['systemd-run']);
  });

  it('fails cleanly without a localRepoPath', async () => {
    const adapter = new LocalProcessAdapter(vi.fn());
    const r = await adapter.provision({
      repo: 'o/r', ticketNumber: 1, title: 'T', brief: 'B', model: 'm', timeoutMs: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('localRepoPath');
  });
});

describe('#1660: GhActionsAdapter', () => {
  function makeFetch(script: Array<(url: string, init: any) => any>) {
    let i = 0;
    const calls: Array<{ url: string; init: any }> = [];
    const impl = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      const handler = script[Math.min(i, script.length - 1)];
      i++;
      return handler(url, init);
    });
    return { impl, calls };
  }

  const noSleep = async () => undefined;

  it('dispatches with inputs, finds the run by marker, polls to success', async () => {
    const { impl, calls } = makeFetch([
      // 1: workflow_dispatch → 204
      () => ({ ok: true, status: 204, json: async () => ({}) }),
      // 2: list runs → our marker present
      (url: string) => ({
        ok: true, status: 200,
        json: async () => ({
          workflow_runs: [
            { id: 42, name: `worker-job wrk-9-x — #9 on o/r`, html_url: 'https://gh/run/42' },
          ],
        }),
      }),
      // 3: poll run → completed success
      () => ({
        ok: true, status: 200,
        json: async () => ({ id: 42, status: 'completed', conclusion: 'success' }),
      }),
    ]);
    // Force the marker to be discoverable: adapter embeds ticket in it.
    const adapter = new GhActionsAdapter({
      workflowRepo: 'ToomeSauce/org-studio', token: 't', fetchImpl: impl,
      pollIntervalMs: 1, maxPolls: 3, sleep: noSleep,
    });
    // Patch: the run name must include the generated marker. Intercept the
    // dispatch call to grab the marker, then serve it back in the list.
    let marker = '';
    (impl as any).mockImplementation(async (url: string, init: any) => {
      calls.push({ url, init });
      if (url.includes('/dispatches')) {
        marker = JSON.parse(init.body).inputs.marker;
        return { ok: true, status: 204, json: async () => ({}) };
      }
      if (url.includes('/runs?')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            workflow_runs: [{ id: 42, name: `worker-job ${marker} — #9`, html_url: 'https://gh/run/42' }],
          }),
        };
      }
      return {
        ok: true, status: 200,
        json: async () => ({ id: 42, status: 'completed', conclusion: 'success' }),
      };
    });

    const r = await adapter.provision({
      repo: 'o/r', ticketNumber: 9, title: 'T', brief: 'B', model: 'm', timeoutMs: 1,
      smoke: true,
    });
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('success');
    const dispatchCall = calls.find((c) => c.url.includes('/dispatches'))!;
    const body = JSON.parse(dispatchCall.init.body);
    expect(body.inputs.target_repo).toBe('o/r');
    expect(body.inputs.ticket).toBe('9');
    expect(body.inputs.engine).toBe('codex');
    expect(body.inputs.model).toBe('m');
    expect(body.inputs.base_url).toBe('');
    expect(body.inputs.api_key_env).toBe('');
    expect(body.inputs.verification_commands).toBe('[]');
    expect(body.inputs.smoke).toBe('true');
    expect(body.inputs.marker).toBe(marker);
  });

  it('reports failure conclusion as not-ok', async () => {
    let marker = '';
    const impl = vi.fn(async (url: string, init: any) => {
      if (url.includes('/dispatches')) {
        marker = JSON.parse(init.body).inputs.marker;
        return { ok: true, status: 204, json: async () => ({}) };
      }
      if (url.includes('/runs?')) {
        return {
          ok: true, status: 200,
          json: async () => ({ workflow_runs: [{ id: 7, name: `x ${marker}`, html_url: 'u' }] }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ id: 7, status: 'completed', conclusion: 'failure' }) };
    });
    const adapter = new GhActionsAdapter({
      workflowRepo: 'o/r', token: 't', fetchImpl: impl, pollIntervalMs: 1, maxPolls: 2, sleep: async () => undefined,
    });
    const r = await adapter.provision({ repo: 'o/r', ticketNumber: 1, title: 'T', brief: 'B', model: 'm', timeoutMs: 1 });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('failure');
  });

  it('#1693: forwards openai-compat dispatch inputs (engine/baseUrl/apiKeyEnv/verification)', async () => {
    let dispatchBody: any = null;
    let marker = '';
    const impl = vi.fn(async (url: string, init: any) => {
      if (url.includes('/dispatches')) {
        dispatchBody = JSON.parse(init.body);
        marker = dispatchBody.inputs.marker;
        return { ok: true, status: 204, json: async () => ({}) };
      }
      if (url.includes('/runs?')) {
        return {
          ok: true, status: 200,
          json: async () => ({ workflow_runs: [{ id: 71, name: `x ${marker}`, html_url: 'u' }] }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ id: 71, status: 'completed', conclusion: 'failure' }) };
    });
    const adapter = new GhActionsAdapter({
      workflowRepo: 'o/r', token: 't', fetchImpl: impl, pollIntervalMs: 1, maxPolls: 2, sleep: async () => undefined,
    });

    await adapter.provision({
      repo: 'o/r',
      ticketNumber: 1,
      title: 'T',
      brief: 'B',
      engine: 'openai-compat',
      model: 'qwen2.5-coder',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKeyEnv: 'LOCAL_KEY',
      verificationCommands: ['npm run test -- src/x.test.ts'],
      timeoutMs: 1,
    });

    expect(dispatchBody.inputs.engine).toBe('openai-compat');
    expect(dispatchBody.inputs.model).toBe('qwen2.5-coder');
    expect(dispatchBody.inputs.base_url).toBe('http://127.0.0.1:11434/v1');
    expect(dispatchBody.inputs.api_key_env).toBe('LOCAL_KEY');
    expect(dispatchBody.inputs.verification_commands).toBe('["npm run test -- src/x.test.ts"]');
  });

  it('dispatch HTTP failure short-circuits without polling', async () => {
    const impl = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }));
    const adapter = new GhActionsAdapter({
      workflowRepo: 'o/r', token: 't', fetchImpl: impl, sleep: async () => undefined,
    });
    const r = await adapter.provision({ repo: 'o/r', ticketNumber: 1, title: 'T', brief: 'B', model: 'm', timeoutMs: 1 });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('403');
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('run never found by marker → honest failure', async () => {
    const impl = vi.fn(async (url: string) => {
      if (url.includes('/dispatches')) return { ok: true, status: 204, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ workflow_runs: [] }) };
    });
    const adapter = new GhActionsAdapter({
      workflowRepo: 'o/r', token: 't', fetchImpl: impl, sleep: async () => undefined,
    });
    const r = await adapter.provision({ repo: 'o/r', ticketNumber: 1, title: 'T', brief: 'B', model: 'm', timeoutMs: 1 });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('not found by marker');
  });
});

describe('#1660: GhActionsAdapter artifact result parsing', () => {
  it('maps normalized engine_result + pr_url into ProvisionResult', async () => {
    let marker = '';
    const extractZipEntry = vi.fn(() =>
      JSON.stringify({
        pr_url: 'https://github.com/x/y/pull/123',
        engine_result: {
          ok: true,
          exitCode: 0,
          durationMs: 1234,
          commands: [{ command: 'npm test', exitCode: 0 }],
          fileChanges: [{ path: 'src/a.ts', kind: 'update' }],
          messages: ['done'],
          errors: [],
          usage: {
            inputTokens: 100,
            cachedInputTokens: 25,
            outputTokens: 50,
            reasoningOutputTokens: 10,
          },
          rawEventCount: 1,
        },
      }),
    );

    const fetchImpl = vi.fn(async (url: string, init: any) => {
      if (url.includes('/dispatches')) {
        marker = JSON.parse(init.body).inputs.marker;
        return { ok: true, status: 204, json: async () => ({}) };
      }
      if (url.includes('/runs?')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ workflow_runs: [{ id: 88, name: `worker-job ${marker} — #1`, html_url: 'https://gh/run/88' }] }),
        };
      }
      if (url.endsWith('/actions/runs/88')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 88, status: 'completed', conclusion: 'success' }),
        };
      }
      if (url.endsWith('/actions/runs/88/artifacts')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ artifacts: [{ name: 'worker-result', archive_download_url: 'https://gh/artifacts/worker-result.zip' }] }),
        };
      }
      if (url === 'https://gh/artifacts/worker-result.zip') {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => new Uint8Array([80, 75, 3, 4]).buffer,
          json: async () => ({}),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const adapter = new GhActionsAdapter({
      workflowRepo: 'o/r',
      token: 't',
      fetchImpl,
      pollIntervalMs: 1,
      maxPolls: 2,
      sleep: async () => undefined,
      extractZipEntry,
    });

    const r = await adapter.provision({
      repo: 'o/r',
      ticketNumber: 1,
      title: 'T',
      brief: 'B',
      model: 'm',
      timeoutMs: 1000,
    });

    expect(r.ok).toBe(true);
    expect(r.prUrl).toBe('https://github.com/x/y/pull/123');
    expect(r.usage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 25,
      outputTokens: 50,
      reasoningOutputTokens: 10,
    });
    expect(r.messages).toEqual(['done']);
    expect(r.engineResult).toMatchObject({
      ok: true,
      exitCode: 0,
      fileChanges: [{ path: 'src/a.ts', kind: 'update' }],
    });
    expect(extractZipEntry).toHaveBeenCalledWith(expect.any(Buffer), 'result.json');
  });

  it('artifact lookup failure does not fail a successful run', async () => {
    let marker = '';
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      if (url.includes('/dispatches')) {
        marker = JSON.parse(init.body).inputs.marker;
        return { ok: true, status: 204, json: async () => ({}) };
      }
      if (url.includes('/runs?')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ workflow_runs: [{ id: 99, name: `worker-job ${marker} — #1`, html_url: 'https://gh/run/99' }] }),
        };
      }
      if (url.endsWith('/actions/runs/99')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 99, status: 'completed', conclusion: 'success' }),
        };
      }
      if (url.endsWith('/actions/runs/99/artifacts')) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const adapter = new GhActionsAdapter({
      workflowRepo: 'o/r',
      token: 't',
      fetchImpl,
      pollIntervalMs: 1,
      maxPolls: 2,
      sleep: async () => undefined,
    });

    const r = await adapter.provision({
      repo: 'o/r',
      ticketNumber: 1,
      title: 'T',
      brief: 'B',
      model: 'm',
      timeoutMs: 1000,
    });

    expect(r.ok).toBe(true);
    expect(r.usage).toBeUndefined();
    expect(r.prUrl).toBeUndefined();
  });
});

describe('#1660: adapterForMode', () => {
  it('resolves local-process and gh-actions; unknown/unconfigured → null', () => {
    expect(adapterForMode('local-process')?.mode).toBe('local-process');
    expect(adapterForMode('gh-actions', { workflowRepo: 'o/r', token: 't' })?.mode).toBe('gh-actions');
    expect(adapterForMode('gh-actions')).toBeNull(); // no opts = unconfigured
    expect(adapterForMode('vm')).toBeNull();
    expect(adapterForMode('nope')).toBeNull();
  });
});
