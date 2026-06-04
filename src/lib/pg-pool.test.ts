import { beforeEach, describe, expect, test, vi } from 'vitest';

const ctorCalls: any[] = [];
const connectCalls: any[] = [];
const releaseCalls: any[] = [];

vi.mock('pg', () => {
  const Pool = class {
    options: any;
    constructor(options: any) {
      this.options = options;
      ctorCalls.push(options);
    }
    async connect() {
      connectCalls.push(this.options);
      return {
        release() {
          releaseCalls.push(true);
        },
      };
    }
  };
  return { Pool, default: { Pool } };
});

describe('pg-pool', () => {
  beforeEach(async () => {
    ctorCalls.length = 0;
    connectCalls.length = 0;
    releaseCalls.length = 0;
    process.env.DATABASE_URL = 'postgres://mock';
    const mod = await import('@/lib/pg-pool');
    mod.__resetPgPoolForTests();
  });

  test('reuses one module-level Pool across calls', async () => {
    const { getPgPool } = await import('@/lib/pg-pool');
    const a = await getPgPool({ max: 5 });
    const b = await getPgPool({ max: 99 });
    expect(a).toBe(b);
    expect(ctorCalls).toHaveLength(1);
    expect(ctorCalls[0]).toMatchObject({ connectionString: 'postgres://mock', max: 5 });
  });

  test('withPgClient connects/releases without rebuilding the pool', async () => {
    const { withPgClient } = await import('@/lib/pg-pool');
    const result1 = await withPgClient(async (client) => client != null ? 'ok-1' : 'bad', { max: 4 });
    const result2 = await withPgClient(async (client) => client != null ? 'ok-2' : 'bad', { max: 4 });
    expect(result1).toBe('ok-1');
    expect(result2).toBe('ok-2');
    expect(ctorCalls).toHaveLength(1);
    expect(connectCalls).toHaveLength(2);
    expect(releaseCalls).toHaveLength(2);
  });
});
