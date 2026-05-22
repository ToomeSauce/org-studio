/**
 * #1526 — Request-scoped store-read memoization.
 *
 * Background: src/app/api/scheduler/route.ts has 20+ `readStore()` /
 * `provider.read()` call sites across 8 switch-cases. Most cases do 1
 * read at the top; the heavy paths (`trigger`, `sync`, `runNow`, `disable`)
 * do 2-5 reads. The #1515 fix surfaced the staleness cost of re-using a
 * stale outer snapshot after a mutation, so several sites legitimately
 * MUST be fresh. But the read-only sites between those fresh-read sites
 * can share one cached payload.
 *
 * Contract (matches doneWhen #4 on Org Studio #1526):
 *   1. `.read()` returns the cached payload if `.refresh()` hasn't been
 *      called and `.invalidate()` hasn't been called since the previous
 *      .read(). Otherwise, fetches a fresh snapshot.
 *   2. `.refresh()` forces a fresh fetch on the next .read(). Use after
 *      any provider write that changes data this request will re-read.
 *   3. `.invalidate()` is an alias for `.refresh()` — clearer at the
 *      call site when the intent is "drop cache because a write just
 *      happened" rather than "I need the next read fresh".
 *   4. Each MemoizedStoreReader instance is scoped to ONE HTTP request
 *      handler invocation. Never share across requests. Never store on
 *      module scope.
 *   5. Cache hits and misses are observable via the `STORE_READ_TRACE=1`
 *      env flag — logs `[store-read-trace] <label> hit=<bool> readMs=<n>`.
 *
 * Why not AsyncLocalStorage? — Could work, but the call sites are all
 * within one route handler today (server.mjs has 0 readStore calls), so
 * an explicit-reader pattern is simpler and easier to audit. Revisit if
 * memoization sprawls across modules.
 *
 * Why not just refactor the 5 reads in `case 'trigger'` to share a
 * variable? — Because the freshness semantics are interleaved with
 * mutations. A typed reader makes the freshness contract self-documenting:
 * every `.refresh()` is a tag the next reviewer can grep for.
 */

import type { StoreData } from './store-provider';
import { getStoreProviderAllWorkspaces } from './store-provider';

const TRACE_ENABLED = process.env.STORE_READ_TRACE === '1';

export interface MemoizedStoreReader {
  /**
   * Return the current cached snapshot, fetching fresh if none cached.
   *
   * @param label optional debug label for STORE_READ_TRACE logging.
   */
  read(label?: string): Promise<StoreData>;

  /**
   * Force the next `.read()` to fetch a fresh snapshot. Call after any
   * provider write that mutates state this request will re-read.
   */
  refresh(): void;

  /** Alias for `.refresh()`. Clearer when called from a write site. */
  invalidate(): void;

  /**
   * Returns the number of cache hits and misses since construction.
   * Used by integration tests; not part of the hot-path contract.
   */
  stats(): { hits: number; misses: number; totalReadMs: number };
}

/**
 * Construct a memoized reader scoped to a single request handler.
 *
 * Typical usage:
 *
 *   const reader = createMemoizedStoreReader();
 *   const store = await reader.read('trigger-top');
 *   // ... read-only work ...
 *   const store2 = await reader.read('trigger-precheck'); // cache hit
 *   await provider.updateTask(...);
 *   reader.invalidate();
 *   const fresh = await reader.read('trigger-post-write'); // fresh
 */
export function createMemoizedStoreReader(): MemoizedStoreReader {
  let cached: StoreData | null = null;
  let dirty = true;
  let hits = 0;
  let misses = 0;
  let totalReadMs = 0;

  async function readFresh(label?: string): Promise<StoreData> {
    const t0 = Date.now();
    const data = await getStoreProviderAllWorkspaces().read();
    const dt = Date.now() - t0;
    totalReadMs += dt;
    if (TRACE_ENABLED) {
      console.log(
        `[store-read-trace] ${label || '(unlabeled)'} hit=false readMs=${dt}`,
      );
    }
    return data;
  }

  return {
    async read(label?: string): Promise<StoreData> {
      if (!dirty && cached) {
        hits++;
        if (TRACE_ENABLED) {
          console.log(
            `[store-read-trace] ${label || '(unlabeled)'} hit=true readMs=0`,
          );
        }
        return cached;
      }
      misses++;
      cached = await readFresh(label);
      dirty = false;
      return cached;
    },
    refresh() {
      dirty = true;
    },
    invalidate() {
      dirty = true;
    },
    stats() {
      return { hits, misses, totalReadMs };
    },
  };
}
