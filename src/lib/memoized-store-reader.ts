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

import type { StoreData, SlimStoreData } from './store-provider';
import { getStoreProviderAllWorkspaces, readSlimStoreAllWorkspaces } from './store-provider';

const TRACE_ENABLED = process.env.STORE_READ_TRACE === '1';

export interface MemoizedStoreReader {
  /**
   * Return the current cached snapshot, fetching fresh if none cached.
   *
   * @param label optional debug label for STORE_READ_TRACE logging.
   */
  read(label?: string): Promise<StoreData>;

  /**
   * #1529 — slim read variant for the scheduler hot path. Cached
   * independently of read(): a slim hit does NOT satisfy a subsequent
   * full read, and vice versa. Both shapes share the same dirty flag,
   * so a single .refresh() / .invalidate() / write-driven invalidation
   * drops both caches.
   *
   * Callers MUST NOT read prompt-construction text fields
   * (title/description/doneWhen/constraints/testPlan/devHandoff) off a
   * task returned by this method; use getStoreProvider().getTaskFull(id)
   * once you've picked the actual dispatch target.
   *
   * @param label optional debug label for STORE_READ_TRACE logging.
   */
  readSlim(label?: string): Promise<SlimStoreData>;

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
   *
   * `hits` / `misses` aggregate across both read() and readSlim() so the
   * pre-#1529 test surface is preserved; `slimHits` / `slimMisses` are
   * the slim-only counters.
   */
  stats(): {
    hits: number;
    misses: number;
    totalReadMs: number;
    slimHits?: number;
    slimMisses?: number;
    totalSlimReadMs?: number;
  };
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
  let cachedSlim: SlimStoreData | null = null;
  let dirty = true;
  let hits = 0;
  let misses = 0;
  let slimHits = 0;
  let slimMisses = 0;
  let totalReadMs = 0;
  let totalSlimReadMs = 0;

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

  async function readSlimFresh(label?: string): Promise<SlimStoreData> {
    const t0 = Date.now();
    const data = await readSlimStoreAllWorkspaces();
    const dt = Date.now() - t0;
    totalSlimReadMs += dt;
    if (TRACE_ENABLED) {
      console.log(
        `[store-read-trace] ${label || '(unlabeled)'} slim=true hit=false readMs=${dt}`,
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
    async readSlim(label?: string): Promise<SlimStoreData> {
      // Slim cache shares the dirty flag with full read, so any write that
      // invalidates one invalidates the other — callers don't have to
      // think about which shape was last cached when they call .refresh().
      if (!dirty && cachedSlim) {
        slimHits++;
        hits++;
        if (TRACE_ENABLED) {
          console.log(
            `[store-read-trace] ${label || '(unlabeled)'} slim=true hit=true readMs=0`,
          );
        }
        return cachedSlim;
      }
      slimMisses++;
      misses++;
      cachedSlim = await readSlimFresh(label);
      // Slim read does NOT populate cached (full) — a subsequent .read()
      // call still goes to the wire. That's intentional: the two shapes
      // have different field sets, so reusing a slim payload as a full
      // payload would silently strip prompt-construction text fields
      // exactly the way the #1520 follow-up bug did to overflow fields.
      dirty = false;
      return cachedSlim;
    },
    refresh() {
      dirty = true;
    },
    invalidate() {
      dirty = true;
    },
    stats() {
      return { hits, misses, totalReadMs, slimHits, slimMisses, totalSlimReadMs };
    },
  };
}
