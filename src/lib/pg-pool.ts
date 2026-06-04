/**
 * Shared Postgres pool helpers.
 *
 * Creates one module-level pg.Pool per process instead of one Pool/Client per
 * request. This cuts connection churn and avoids bursty auth/token traffic
 * exhausting Postgres with needless connect/disconnect cycles.
 */

let _pool: any = undefined; // undefined = uninitialized, null = no DATABASE_URL

export async function getPgPool(options?: { max?: number }): Promise<any> {
  if (_pool !== undefined) return _pool;

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    _pool = null;
    return null;
  }

  try {
    const pg = await import('pg');
    const pgModule = pg as any;
    const Pool = pgModule.Pool || pgModule.default?.Pool;
    _pool = new Pool({
      connectionString: dbUrl,
      ...(options?.max ? { max: options.max } : {}),
    });
    return _pool;
  } catch (e: any) {
    console.error('[pg-pool] Failed to create pool:', e?.message || e);
    _pool = null;
    return null;
  }
}

export async function withPgClient<T>(
  fn: (client: any) => Promise<T>,
  options?: { max?: number },
): Promise<T> {
  const pool = await getPgPool(options);
  if (!pool) {
    throw new Error('DATABASE_URL not configured');
  }
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export function __resetPgPoolForTests(): void {
  _pool = undefined;
}
