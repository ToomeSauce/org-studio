/**
 * GET /api/health — Aggregated system health endpoint for the Health dashboard.
 *
 * Returns runtimes, Postgres LISTEN status, stuck agents, stuck tasks,
 * and recent incidents. Gateway WS status is handled client-side via
 * useWSConnected() since the server-side gateway-rpc module doesn't
 * expose a clean "am I connected?" check without side-effecting connect().
 *
 * If DATABASE_URL is unset (file mode), DB-backed fields return empty
 * arrays and degradedMode is set to "file".
 */
import { NextResponse } from 'next/server';
import { getRuntimeRegistry } from '@/lib/runtimes/registry';
import { getStoreProvider } from '@/lib/store-provider';

const STUCK_TASK_THRESHOLD_MS = parseInt(process.env.STUCK_TASK_THRESHOLD_MIN || '30', 10) * 60 * 1000;

// ---------- helpers ----------

let _pool: any = undefined; // undefined = not init, null = no DB

async function getPool(): Promise<any> {
  if (_pool !== undefined) return _pool;
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { _pool = null; return null; }
  try {
    const pg = await import('pg');
    const Pool = pg.default?.Pool || pg.Pool;
    _pool = new Pool({ connectionString: dbUrl, max: 3 });
    return _pool;
  } catch {
    _pool = null;
    return null;
  }
}

async function queryStuckAgents(pool: any) {
  const { rows } = await pool.query(
    `SELECT agent_id, loop_id, last_heartbeat,
            EXTRACT(EPOCH FROM (NOW() - last_heartbeat)) / 60 AS minutes_stale
     FROM org_studio_heartbeats
     WHERE last_heartbeat < NOW() - INTERVAL '5 minutes'
     ORDER BY last_heartbeat ASC`
  );
  return rows.map((r: any) => ({
    agentId: r.agent_id,
    loopId: r.loop_id,
    lastHeartbeat: r.last_heartbeat,
    minutesStale: Math.round(Number(r.minutes_stale)),
  }));
}

async function queryIncidents(pool: any) {
  const { rows } = await pool.query(
    `SELECT id, timestamp, type, agent_id, message, context
     FROM org_studio_incidents
     ORDER BY timestamp DESC
     LIMIT 50`
  );
  return rows.map((r: any) => ({
    id: r.id,
    timestamp: r.timestamp,
    type: r.type,
    agentId: r.agent_id,
    message: r.message,
    context: r.context,
  }));
}

async function queryListenHealth(pool: any): Promise<{ healthy: boolean; detail?: string }> {
  try {
    // Lightweight check: if we can query, Postgres is reachable.
    // The PubSub singleton may not be initialised in this process,
    // so we do a simple connectivity check instead.
    await pool.query('SELECT 1');
    return { healthy: true };
  } catch (e: any) {
    return { healthy: false, detail: e?.message || 'Query failed' };
  }
}

function computeStuckTasks(tasks: any[], projects: any[]): any[] {
  const now = Date.now();
  const stuck: any[] = [];

  for (const task of tasks) {
    if (task.status !== 'in-progress' || task.isArchived) continue;

    // Find how long the task has been in-progress:
    // Check statusHistory for the most recent in-progress entry, else fall back to updatedAt.
    let inProgressSince = task.updatedAt || task.createdAt || now;
    const history = task.statusHistory || [];
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].status === 'in-progress') {
        inProgressSince = history[i].timestamp;
        break;
      }
    }

    const elapsed = now - new Date(inProgressSince).getTime();
    if (elapsed > STUCK_TASK_THRESHOLD_MS) {
      const proj = projects.find((p: any) => p.id === task.projectId);
      stuck.push({
        id: task.id,
        title: task.title || '(untitled)',
        assignee: task.assignee || null,
        status: task.status,
        minutesInStatus: Math.round(elapsed / 60000),
        projectId: task.projectId || null,
        projectName: proj?.name || null,
      });
    }
  }

  // Sort: longest stuck first
  stuck.sort((a, b) => b.minutesInStatus - a.minutesInStatus);
  return stuck;
}

// ---------- route ----------

export async function GET() {
  try {
    const pool = await getPool();
    const isDegraded = !pool;

    // --- Runtimes (always available) ---
    let runtimes: any[] = [];
    try {
      const registry = await getRuntimeRegistry();
      const health = await registry.healthAll();
      runtimes = Object.entries(health).map(([id, status]) => ({
        id,
        name: registry.getRuntimeName(id) || id,
        connected: status.connected,
        detail: status.detail || null,
      }));
    } catch {
      // If registry fails, return empty
    }

    // --- DB-backed fields ---
    let listen: { healthy: boolean; detail?: string } = { healthy: false, detail: 'DATABASE_URL not set' };
    let stuckAgents: any[] = [];
    let incidents: any[] = [];

    if (pool) {
      const [listenResult, stuckAgentsResult, incidentsResult] = await Promise.allSettled([
        queryListenHealth(pool),
        queryStuckAgents(pool),
        queryIncidents(pool),
      ]);

      if (listenResult.status === 'fulfilled') listen = listenResult.value;
      if (stuckAgentsResult.status === 'fulfilled') stuckAgents = stuckAgentsResult.value;
      if (incidentsResult.status === 'fulfilled') incidents = incidentsResult.value;
    }

    // --- Stuck tasks (from store — works in both file and DB mode) ---
    let stuckTasks: any[] = [];
    try {
      const store = await getStoreProvider().read();
      stuckTasks = computeStuckTasks(store.tasks || [], store.projects || []);
    } catch {
      // Swallow
    }

    const body: any = {
      runtimes,
      gateway: null, // Handled client-side via useWSConnected()
      listen,
      stuckAgents,
      stuckTasks,
      incidents,
      now: Date.now(),
    };

    if (isDegraded) {
      body.degradedMode = 'file';
    }

    return NextResponse.json(body);
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || 'Health check failed' },
      { status: 500 },
    );
  }
}
