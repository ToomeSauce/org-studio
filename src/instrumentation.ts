/**
 * Next.js instrumentation hook — runs once at server start.
 *
 * #1528: pre-warm the Postgres connection pool so the first inbound request
 * doesn't pay the ~500ms TLS+auth handshake cost. The cold-connection tail
 * was the dominant contributor to read-latency p99 (see ticket #1528 for
 * the trace data).
 *
 * Safe to no-op when running file-mode (DATABASE_URL unset): the warmup
 * call is a no-op on FileStoreProvider.
 */
export async function register() {
  // Only run server-side. Next calls register() on the server-side runtime;
  // the `process.env.NEXT_RUNTIME` guard makes the intent explicit and
  // avoids any future client-bundle inclusion.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  try {
    // Lazy-import to keep this file dependency-free at module-load.
    const mod = await import('./lib/store-provider');
    const provider = mod.getStoreProviderAllWorkspaces();
    if (provider && typeof (provider as any).prewarm === 'function') {
      const t0 = Date.now();
      await (provider as any).prewarm();
      console.log(`[boot] store-provider prewarm complete in ${Date.now() - t0}ms`);
    }
  } catch (e: any) {
    // Never block app start on warmup failure.
    console.warn('[boot] store-provider prewarm failed (non-fatal):', e?.message || e);
  }

  // M-2 (#1663) / M-3 (#1664): start native messaging adapters. No tokens =
  // no adapters = registry stays empty and every notify() is a no-op. Never
  // blocks boot.
  try {
    const { getMessagingRegistry } = await import('./lib/messaging/registry');
    const registry = getMessagingRegistry();
    const started: string[] = [];

    const { telegramAdapterFromEnv } = await import('./lib/messaging/telegram');
    const tg = telegramAdapterFromEnv();
    if (tg) {
      registry.register(tg);
      started.push('telegram');
    }

    const { slackAdapterFromEnv } = await import('./lib/messaging/slack');
    const slack = slackAdapterFromEnv();
    if (slack) {
      registry.register(slack);
      started.push('slack');
    }

    if (started.length > 0) {
      await registry.start();
      console.log(`[boot] native messaging started (${started.join(', ')})`);
    }
  } catch (e: any) {
    console.warn('[boot] native messaging start failed (non-fatal):', e?.message || e);
  }
}
