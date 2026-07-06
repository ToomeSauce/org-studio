/**
 * host-sampler.mjs — #1643 host-signal ingestion (local side).
 *
 * Samples load average, event-loop delay, and memory every SAMPLE_MS and
 * writes rows to org_studio_host_samples via a DIRECT pg connection —
 * deliberately NOT an internal HTTP self-fetch (the #1640/#1645 class).
 * The gateway (or any external host) can push its own samples through
 * POST /api/observability/host instead.
 *
 * These rows are joinable to org_studio_dispatch_ledger rows by time
 * window, so a thermal-adjacent CPU spike can be correlated to the
 * dispatches that caused it. (#1633 was found by fan noise; this makes
 * the fan redundant.)
 *
 * Postgres-only; silently no-ops in file mode. Table DDL is owned by
 * src/lib/dispatch-breaker.ts (CREATE IF NOT EXISTS on first use there);
 * we also ensure it here so sampler startup order doesn't matter.
 */

import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const TAG = '[HostSampler]';
const SAMPLE_MS = 30_000;

let _pool = undefined;

async function pool() {
  if (_pool !== undefined) return _pool;
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    _pool = null;
    return null;
  }
  try {
    const { default: pg } = await import('pg');
    _pool = new pg.Pool({ connectionString: dbUrl, max: 1 });
    return _pool;
  } catch (e) {
    console.error(`${TAG} pool create failed:`, e.message);
    _pool = null;
    return null;
  }
}

const ENSURE_SQL = `
  CREATE TABLE IF NOT EXISTS org_studio_host_samples (
    id BIGSERIAL PRIMARY KEY,
    host TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'local',
    sampled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    load1 REAL,
    cpu_pct REAL,
    event_loop_delay_ms REAL,
    mem_used_mb REAL,
    mem_total_mb REAL
  );
  CREATE INDEX IF NOT EXISTS idx_host_samples_time
    ON org_studio_host_samples (sampled_at DESC);
`;

/**
 * Start the sampler. Returns { stop } or null when disabled (no DB).
 */
export function startHostSampler({ sampleMs = SAMPLE_MS } = {}) {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const hostname = os.hostname();
  let handle = null;
  let ensured = false;
  let errorLogged = false;

  async function sample() {
    const p = await pool();
    if (!p) return;
    try {
      if (!ensured) {
        await p.query(ENSURE_SQL);
        ensured = true;
      }
      // p95 event-loop delay since last sample, in ms (histogram is ns).
      const delayP95Ms = histogram.percentile(95) / 1e6;
      histogram.reset();
      const load1 = os.loadavg()[0];
      const memTotalMb = os.totalmem() / (1024 * 1024);
      const memUsedMb = (os.totalmem() - os.freemem()) / (1024 * 1024);
      // cpu_pct: normalize load1 by core count — cheap proxy, good enough
      // for "was the host hot when those dispatches fired" correlation.
      const cpuPct = Math.min(100, (load1 / os.cpus().length) * 100);
      await p.query(
        `INSERT INTO org_studio_host_samples
           (host, source, load1, cpu_pct, event_loop_delay_ms, mem_used_mb, mem_total_mb)
         VALUES ($1,'local',$2,$3,$4,$5,$6)`,
        [
          hostname,
          Math.round(load1 * 100) / 100,
          Math.round(cpuPct * 10) / 10,
          Math.round(delayP95Ms * 100) / 100,
          Math.round(memUsedMb),
          Math.round(memTotalMb),
        ],
      );
      errorLogged = false;
    } catch (e) {
      if (!errorLogged) {
        errorLogged = true;
        console.error(`${TAG} sample failed (will log once until recovery):`, e.message);
      }
    }
  }

  pool().then((p) => {
    if (!p) {
      console.log(`${TAG} Disabled (file mode — Postgres required)`);
      histogram.disable();
      return;
    }
    handle = setInterval(sample, sampleMs);
    handle.unref?.();
    console.log(`${TAG} Started (host=${hostname}, every ${sampleMs / 1000}s)`);
  });

  return {
    stop: () => {
      if (handle) clearInterval(handle);
      histogram.disable();
    },
  };
}
