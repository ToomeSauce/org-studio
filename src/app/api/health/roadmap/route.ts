/**
 * GET /api/health/roadmap
 *
 * Surfaces the periodic RoadmapReconcile cron's last-run summary and a
 * short history ring buffer. Reconcile itself is implemented in
 * `src/lib/roadmap-sync.ts` and invoked from `server.mjs` on startup
 * + every 15 minutes (#982).
 *
 * Returns:
 * {
 *   enabled: boolean,            // false if server.mjs hasn't initialized yet
 *   intervalMs: number,
 *   last: {
 *     trigger: 'startup'|'cron'|'manual',
 *     startedAt: number, finishedAt: number, durationMs: number,
 *     ok: boolean, httpStatus: number, error: string|null,
 *     summary: { scanned, flipped, shipped, advanced, skippedAdvance } | null
 *   } | null,
 *   history: [...same shape...]   // newest first, ~50 entries
 * }
 */
import { NextResponse } from 'next/server';

const INTERVAL_MS = 15 * 60_000;

export async function GET() {
  // server.mjs attaches a snapshot accessor to globalThis when it boots.
  const accessor = (globalThis as any).__orgStudioRoadmapReconcile as
    | { last: () => any; history: () => any[] }
    | undefined;

  if (!accessor) {
    return NextResponse.json({
      enabled: false,
      intervalMs: INTERVAL_MS,
      last: null,
      history: [],
      detail: 'Roadmap reconcile cron not initialized (server.mjs not running, file mode, or boot incomplete).',
    });
  }

  return NextResponse.json({
    enabled: true,
    intervalMs: INTERVAL_MS,
    last: accessor.last(),
    history: accessor.history(),
  });
}
