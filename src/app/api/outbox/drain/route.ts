/**
 * Internal outbox drain endpoint.
 *
 * Called by the outbox worker (lib/outbox.mjs) to perform the actual sendToAgent call
 * within the Next.js TS runtime where all imports are available.
 *
 * POST /api/outbox/drain
 * Body: { outboxId, agentId, idempotencyKey, payload }
 *
 * The worker handles status transitions (sending → sent / failed / dead_letter).
 * This endpoint only needs to call sendToAgent and return success or throw.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sendToAgent } from '@/lib/runtimes/registry';
import { authenticateRequestWithContext, requireWriteScope } from '@/lib/auth';
import { getStoreProviderAllWorkspaces, type StoreData } from '@/lib/store-provider'; // TODO(#1387 A.3): outbox drain should iterate per-workspace
import { clearInFlightAgent } from '@/app/api/scheduler/route';
import { completeDispatch, recordInternalCallFailure, captureSessionUsageDelta } from '@/lib/dispatch-ledger';
import { rpc } from '@/lib/gateway-rpc';

interface DrainRequest {
  outboxId: string;
  agentId: string;
  idempotencyKey: string;
  payload: {
    message: string;
    sessionKey: string;
    onCompleteKind?: string;
  };
}

async function readStore(): Promise<StoreData> {
  return await getStoreProviderAllWorkspaces().read();
}

export async function POST(request: NextRequest) {
  const authCtx = await authenticateRequestWithContext(request);
  if (authCtx.error) return authCtx.error;
  const scopeFail = requireWriteScope(authCtx.context);
  if (scopeFail) return scopeFail;

  try {
    const body: DrainRequest = await request.json();
    const { outboxId, agentId, idempotencyKey, payload } = body;

    if (!agentId || !idempotencyKey || !payload?.message || !payload?.sessionKey) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Build onComplete callback if the payload requests redispatch
    let onComplete: ((completedAgentId: string) => void) | undefined;
    if (payload.onCompleteKind === 'redispatch') {
      onComplete = async (completedAgentId: string) => {
        clearInFlightAgent(completedAgentId);
        // #1641 — close out the ledger row (sets completed_at + duration_ms).
        completeDispatch(completedAgentId);
        // #1641 token capture — snapshot the session's cumulative usage from
        // the gateway and record the delta as this dispatch's model call.
        // Capability-gated: only the OpenClaw runtime reports usage; a
        // failed/timed-out rpc just skips capture (never blocks completion).
        try {
          const sessionsResult = await Promise.race([
            rpc('sessions.list', { limit: 100 }),
            new Promise((resolve) => setTimeout(() => resolve(undefined), 1500)),
          ]);
          const sessions = Array.isArray(sessionsResult)
            ? sessionsResult
            : ((sessionsResult as any)?.sessions || []);
          const sess = sessions.find((s: any) => s.key === payload.sessionKey);
          if (sess && (sess.inputTokens != null || sess.outputTokens != null)) {
            captureSessionUsageDelta({
              sessionKey: payload.sessionKey,
              agentId: completedAgentId,
              dispatchId: idempotencyKey,
              current: {
                tokensIn: sess.inputTokens ?? null,
                tokensOut: sess.outputTokens ?? null,
                totalTokens: sess.totalTokens ?? null,
                costUsd: sess.estimatedCostUsd ?? null,
                model: sess.model ?? null,
                provider: sess.modelProvider ?? null,
              },
            });
          }
        } catch {
          // best-effort — usage capture must never break completion
        }
        console.log(`[Outbox drain] ${agentId} completed, cleared in-flight (onComplete/redispatch)`);
        // Re-trigger via scheduler for next work
        try {
          const apiKey = process.env.ORG_STUDIO_API_KEY || '';
          const baseUrl = `http://127.0.0.1:${process.env.PORT || '4501'}`;
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
          const res = await fetch(`${baseUrl}/api/scheduler`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ action: 'trigger', agentId: completedAgentId }),
          });
          // #1641 — count non-ok internal responses, not just throws (the
          // #1640 failure class: swallowed non-ok status, surface fine).
          if (!res.ok) {
            recordInternalCallFailure('outbox-drain:redispatch', '/api/scheduler', res.status, 'http-status');
          }
        } catch (e: any) {
          recordInternalCallFailure('outbox-drain:redispatch', '/api/scheduler', null, 'fetch-throw');
          console.warn(`[Outbox drain] Auto-redispatch trigger failed for ${agentId}:`, e.message);
        }
      };
    }

    // Call sendToAgent — this is the actual gateway send
    await sendToAgent(agentId, payload.message, {
      sessionKey: payload.sessionKey,
      idempotencyKey,
      onComplete,
    });

    return NextResponse.json({ ok: true, outboxId });
  } catch (e: any) {
    console.error(`[Outbox drain] sendToAgent failed:`, e?.message || e);
    return NextResponse.json(
      { error: e?.message || 'sendToAgent failed' },
      { status: 502 }
    );
  }
}
