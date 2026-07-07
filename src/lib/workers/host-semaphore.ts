/**
 * Per-host job semaphore (#1659, W-4 layer 3 — dispatcher enforcement).
 *
 * HOST.md prose cannot stop two workers from building concurrently; a
 * semaphore can. Keyed by hostId, capacity = HostProfile.maxConcurrentJobs.
 *
 * SCOPE GUARANTEE (ticket constraint): this gate is consulted ONLY by
 * WorkerRuntime.send() for worker jobs. Per-agent dispatch behavior for
 * OpenClaw/Hermes runtimes is untouched — agents don't pass through here.
 *
 * In-process state is correct for v1: local-process workers run inside the
 * same Next.js server process as the dispatcher. Remote provisioning (W-5)
 * moves this to a shared store if multi-process dispatch ever ships.
 */

const counts = new Map<string, number>();

export type HostSlotResult = { ok: true; release: () => void } | { ok: false; reason: string };

/** Try to take a job slot on `hostId`. Release exactly once when done. */
export function tryAcquireHostSlot(hostId: string, maxConcurrentJobs: number): HostSlotResult {
  const current = counts.get(hostId) || 0;
  if (current >= maxConcurrentJobs) {
    return {
      ok: false,
      reason:
        `Host ${hostId} is at its job cap (${current}/${maxConcurrentJobs} running). ` +
        `Dispatch will retry when a slot frees.`,
    };
  }
  counts.set(hostId, current + 1);
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return; // idempotent — double-release must not corrupt the count
      released = true;
      const c = counts.get(hostId) || 0;
      if (c <= 1) counts.delete(hostId);
      else counts.set(hostId, c - 1);
    },
  };
}

/** Current running-job count for a host (introspection/health). */
export function hostSlotCount(hostId: string): number {
  return counts.get(hostId) || 0;
}

/** Test hook — reset all counts. */
export function __resetHostSlotsForTest(): void {
  counts.clear();
}
