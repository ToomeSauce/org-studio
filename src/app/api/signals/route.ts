'use server';

import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequestWithContext, requireWriteScope } from '@/lib/auth';
import { join } from 'path';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { detectSignals, DetectedSignal } from '@/lib/signal-detector';
import { getStoreProvider } from '@/lib/store-provider';
import { resolveWorkspaceIdForRequest } from '@/lib/workspace-auth';
// #1645: internal self-fetches must authenticate (store GET + kudos POST are
// gated in cloud mode — unauthenticated calls silently 401'd, #1640 class).
import { internalAuthHeaders } from '@/lib/read-gate';
import { recordInternalCallFailure } from '@/lib/dispatch-ledger';

/**
 * Signals API — Auto-detected cultural signals
 * 
 * GET /api/signals
 *   - Runs detector and returns suggested signals
 *   - Also returns pending (unconfirmed) signals
 * 
 * POST /api/signals
 *   { action: "confirm", signalId }
 *   { action: "dismiss", signalId }
 */

const DISMISSED_SIGNALS_FILE = join(process.cwd(), 'data', 'dismissed-signals.json');

/**
 * Load dismissed signal IDs from file
 */
function loadDismissedSignals(): string[] {
  try {
    if (!existsSync(DISMISSED_SIGNALS_FILE)) return [];
    const content = readFileSync(DISMISSED_SIGNALS_FILE, 'utf-8');
    return JSON.parse(content) || [];
  } catch {
    return [];
  }
}

/**
 * Save dismissed signal IDs to file
 */
function saveDismissedSignals(ids: string[]): void {
  const dir = join(process.cwd(), 'data');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(DISMISSED_SIGNALS_FILE, JSON.stringify(ids, null, 2), 'utf-8');
}

/**
 * Load store data for signal detection
 */
async function loadStore() {
  try {
    const response = await fetch('http://localhost:4501/api/store', {
      headers: internalAuthHeaders(),
    });
    if (!response.ok) {
      recordInternalCallFailure('signals:load-store', '/api/store', response.status, 'http-status');
      throw new Error('Failed to load store');
    }
    return response.json();
  } catch (err) {
    console.error('[Signals API] Failed to load store:', err);
    return { tasks: [], projects: [], teammates: [] };
  }
}

/**
 * #1524 — bulk-fetch comments for every task in the store snapshot in one
 * query, so signal detectors don't have to read the soon-to-be-removed
 * inline `task.comments[]` blob. Best-effort — on any error we return an
 * empty Map and detectors fall back to inline reads (which will degrade
 * gracefully once the column is dropped in Phase 3).
 */
async function fetchCommentsForStore(req: NextRequest, store: any): Promise<Map<string, any[]>> {
  try {
    const workspaceId = await resolveWorkspaceIdForRequest(req);
    const provider = getStoreProvider(workspaceId) as any;
    if (typeof provider.listCommentsForTasks !== 'function') return new Map();
    const taskIds = (store?.tasks || [])
      .map((t: any) => t?.id)
      .filter((id: any): id is string => typeof id === 'string' && id.length > 0);
    if (taskIds.length === 0) return new Map();
    return await provider.listCommentsForTasks(taskIds);
  } catch (err) {
    console.warn('[Signals API] Bulk comments fetch failed; detectors will fall back to inline blob:', err);
    return new Map();
  }
}

/**
 * Load recently-created kudos to avoid duplicate detections
 */
async function loadRecentKudos(maxAge = 7 * 24 * 60 * 60 * 1000) {
  try {
    const response = await fetch('http://localhost:4501/api/kudos?limit=100', {
      headers: internalAuthHeaders(),
    });
    if (!response.ok) {
      recordInternalCallFailure('signals:load-kudos', '/api/kudos', response.status, 'http-status');
      return [];
    }
    const data = await response.json();
    const now = Date.now();
    return (data.kudos || []).filter((k: any) => now - k.createdAt < maxAge);
  } catch (err) {
    console.error('[Signals API] Failed to load kudos:', err);
    return [];
  }
}

/**
 * Deduplicate signals:
 * - Remove if dismissed
 * - Remove if similar kudos exists in last 7 days
 */
async function deduplicateSignals(signals: DetectedSignal[]): Promise<DetectedSignal[]> {
  const dismissed = loadDismissedSignals();
  const recentKudos = await loadRecentKudos();

  return signals.filter(signal => {
    // Filter out dismissed signals
    if (dismissed.includes(signal.id)) return false;

    // Filter out signals with similar kudos (same agent + same type)
    const similar = recentKudos.find(
      (k: any) => k.agentId === signal.agentId && k.type === signal.type
    );
    if (similar) return false;

    return true;
  });
}

/**
 * GET /api/signals
 */
async function handleGET(req: NextRequest) {
  try {
    const store = await loadStore();
    const commentsByTask = await fetchCommentsForStore(req, store);
    let signals = await detectSignals(store, commentsByTask);
    
    // Deduplicate
    signals = await deduplicateSignals(signals);

    // Auto-confirm mode: immediately create kudos/flags, return empty suggestions
    const autoConfirm = store?.settings?.autoConfirmSignals !== false; // default: true
    if (autoConfirm && signals.length > 0) {
      for (const signal of signals) {
        try {
          const kudosRes = await fetch('http://localhost:4501/api/kudos', {
            method: 'POST',
            headers: internalAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
              agentId: signal.agentId,
              givenBy: 'system',
              values: signal.values,
              note: signal.note,
              type: signal.type,
              taskId: signal.taskId,
              projectId: signal.projectId,
              autoDetected: true,
              confirmed: true,
            }),
          });
          if (!kudosRes.ok) {
            recordInternalCallFailure('signals:auto-confirm-kudos', '/api/kudos', kudosRes.status, 'http-status');
            console.error(`[Signals] Auto-confirm kudos POST returned ${kudosRes.status} for ${signal.id}`);
          }
          // Mark as dismissed so it doesn't re-fire
          const dismissed = loadDismissedSignals();
          if (!dismissed.includes(signal.id)) {
            dismissed.push(signal.id);
            saveDismissedSignals(dismissed);
          }
        } catch (err) {
          console.error(`[Signals] Auto-confirm failed for ${signal.id}:`, err);
        }
      }
      // Return empty — all auto-confirmed
      return NextResponse.json({ signals: [], autoConfirmed: signals.length });
    }

    // Sort by type (flags first), then by recency
    signals.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'flag' ? -1 : 1;
      return b.detectedAt - a.detectedAt;
    });

    return NextResponse.json({ signals });
  } catch (err) {
    console.error('[Signals API] GET error:', err);
    return NextResponse.json({ signals: [], error: (err as any).message }, { status: 500 });
  }
}

/**
 * POST /api/signals
 * Body: { action: "confirm" | "dismiss", signalId }
 */
async function handlePOST(req: NextRequest) {
  // #1386 Phase 2: require auth + write-scope.
  const authCtx = await authenticateRequestWithContext(req);
  if (authCtx.error) return authCtx.error;
  const scopeFail = requireWriteScope(authCtx.context);
  if (scopeFail) return scopeFail;

  try {
    const body = await req.json();
    const { action, signalId } = body;

    if (!action || !signalId) {
      return NextResponse.json({ error: 'Missing action or signalId' }, { status: 400 });
    }

    if (action === 'dismiss') {
      const dismissed = loadDismissedSignals();
      if (!dismissed.includes(signalId)) {
        dismissed.push(signalId);
        saveDismissedSignals(dismissed);
      }
      return NextResponse.json({ ok: true, action: 'dismiss' });
    }

    if (action === 'confirm') {
      // Load the store to find the signal
      const store = await loadStore();
      const commentsByTask = await fetchCommentsForStore(req, store);
      let signals = await detectSignals(store, commentsByTask);
      signals = await deduplicateSignals(signals);

      const signal = signals.find(s => s.id === signalId);
      if (!signal) {
        return NextResponse.json({ error: 'Signal not found' }, { status: 404 });
      }

      // Create a kudos/flag entry from the signal
      const response = await fetch('http://localhost:4501/api/kudos', {
        method: 'POST',
        headers: internalAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          agentId: signal.agentId,
          givenBy: 'system',
          values: signal.values,
          note: signal.note,
          type: signal.type,
          taskId: signal.taskId,
          projectId: signal.projectId,
          autoDetected: true,
          confirmed: true,
        }),
      });

      if (!response.ok) {
        recordInternalCallFailure('signals:confirm-kudos', '/api/kudos', response.status, 'http-status');
        throw new Error('Failed to create kudos entry');
      }

      // Also add to dismissed so it doesn't resurface
      const dismissed = loadDismissedSignals();
      if (!dismissed.includes(signalId)) {
        dismissed.push(signalId);
        saveDismissedSignals(dismissed);
      }

      return NextResponse.json({ ok: true, action: 'confirm' });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (err) {
    console.error('[Signals API] POST error:', err);
    return NextResponse.json({ error: (err as any).message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handleGET(req);
}

export async function POST(req: NextRequest) {
  return handlePOST(req);
}
