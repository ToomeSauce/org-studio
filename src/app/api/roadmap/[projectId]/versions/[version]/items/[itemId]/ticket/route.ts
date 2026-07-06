// #1380 — one-call create-and-link endpoint for roadmap planning tickets.
//
// Background: creating a planning ticket against a roadmap item used to be
// a 4-step dance for API callers:
//   1. POST /api/roadmap/{projectId} upsert version with item id
//   2. POST /api/store addTask with version + roadmapItemId
//   3. Read back ticketNumber from response
//   4. Re-upsert version with items[i].taskId stamped + (#NNN) appended
//
// #1379 already fixed step 1+4 by echoing items[] on upsert, but the four-step
// flow was still cumbersome. This endpoint collapses it to one call where the
// parent context (projectId, version, itemId) is in the URL.
//
// Internally we delegate to the addTask endpoint so all its machinery
// (ticketNumber allocation, sectionId resolution, currentVersion auto-promote,
// effective-owner snapshot, kudos counters, dispatch triggers, etc.) is
// preserved. The only thing this endpoint does that's different from raw
// addTask is:
//   - URL params provide projectId, version, roadmapItemId — caller doesn't
//     repeat them.
//   - We validate the item exists BEFORE creating the task (cheap pre-check,
//     avoids creating a ticket against a non-existent item).
//   - We await the back-link write synchronously (addTask fires it
//     async/fire-and-forget — for one-call semantics we want both writes to
//     succeed or surface partial state explicitly).
//
// On partial-link state (task created, back-link failed), we return
// 207-multi-status-ish JSON with the task id so the caller can either retry
// the link or delete the task. We do NOT auto-delete the task — addTask
// allocates a ticketNumber that we don't want to silently consume.

import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { authenticateRequestWithContext, requireWriteScope } from '@/lib/auth';
import { recordInternalCallFailure } from '@/lib/dispatch-ledger';

const ALLOWED_PRIORITY = new Set(['low', 'medium', 'high', 'critical']);

// Resolve port at request time so this works whether we're on 4501 or a
// different port in CI/dev.
function internalBase(): string {
  return `http://localhost:${process.env.PORT || 4501}`;
}

function requireBearer(authHeader: string | null): boolean {
  if (!process.env.ORG_STUDIO_API_KEY) return true; // dev mode, no key set
  const expected = `Bearer ${process.env.ORG_STUDIO_API_KEY}`;
  return authHeader === expected;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; version: string; itemId: string }> }
) {
  const { projectId, version, itemId } = await params;
  // #1386 Phase 2: scope check first (cheap, no headers() dependency).
  const authCtx = await authenticateRequestWithContext(req);
  if (!authCtx.error) {
    const scopeFail = requireWriteScope(authCtx.context);
    if (scopeFail) return scopeFail;
  }
  const authHeader = (await headers()).get('authorization');
  if (!requireBearer(authHeader)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // Body shape: { title?, assignee, doneWhen?, constraints?, context?, priority?, taskType?, description? }
  // We do NOT accept version, projectId, or roadmapItemId in the body —
  // those come from the URL. If the caller sends them anyway, we ignore
  // and use URL values (single source of truth).
  if (typeof body !== 'object' || body == null) {
    return NextResponse.json({ error: 'body must be a JSON object' }, { status: 400 });
  }
  if (typeof body.assignee !== 'string' || body.assignee.trim().length === 0) {
    return NextResponse.json({ error: 'assignee is required' }, { status: 400 });
  }
  if (body.priority !== undefined && !ALLOWED_PRIORITY.has(body.priority)) {
    return NextResponse.json(
      { error: `priority must be one of ${[...ALLOWED_PRIORITY].join(', ')}` },
      { status: 400 }
    );
  }

  // Step 1 — pre-check: version + item exist. Cheap GET against our own roadmap
  // API. Avoids creating a ticket-with-allocated-ticketNumber against a
  // non-existent item (which would then 403 inside addTask anyway, but we
  // can surface a clearer error here).
  let roadmapItem: any = null;
  let versionRow: any = null;
  try {
    const roadmapRes = await fetch(`${internalBase()}/api/roadmap/${encodeURIComponent(projectId)}`, {
      cache: 'no-store',
    });
    if (!roadmapRes.ok) {
      // #1641 — count internal-call failures even when surfaced (trend signal).
      recordInternalCallFailure('ticket-route:precheck', '/api/roadmap', roadmapRes.status, 'http-status');
      return NextResponse.json(
        { error: 'roadmap_lookup_failed', status: roadmapRes.status },
        { status: 502 }
      );
    }
    const roadmapData = await roadmapRes.json();
    versionRow = (roadmapData.versions || []).find((v: any) => v.version === version);
    if (!versionRow) {
      return NextResponse.json(
        { error: 'version_not_found', message: `Version "${version}" not found in project ${projectId}.` },
        { status: 404 }
      );
    }
    roadmapItem = (versionRow.items || []).find((i: any) => i.id === itemId);
    if (!roadmapItem) {
      return NextResponse.json(
        { error: 'item_not_found', message: `Item "${itemId}" not found in version ${version}.` },
        { status: 404 }
      );
    }
  } catch (e: any) {
    return NextResponse.json(
      { error: 'roadmap_lookup_failed', message: e?.message },
      { status: 502 }
    );
  }

  // Step 2 — addTask. Title defaults to the item's title if caller didn't
  // supply one (most common case: planning ticket title === item title).
  const title: string = (typeof body.title === 'string' && body.title.trim().length > 0)
    ? body.title
    : (roadmapItem.title || `Planning ticket for ${itemId}`);

  const taskPayload: any = {
    title,
    projectId,
    version,
    roadmapItemId: itemId,
    status: 'planning',
    assignee: body.assignee,
    priority: body.priority || 'medium',
  };
  if (typeof body.doneWhen === 'string') taskPayload.doneWhen = body.doneWhen;
  if (typeof body.constraints === 'string') taskPayload.constraints = body.constraints;
  if (typeof body.context === 'string') taskPayload.context = body.context;
  if (typeof body.description === 'string') taskPayload.description = body.description;
  if (typeof body.taskType === 'string') taskPayload.taskType = body.taskType;
  if (typeof body.sectionId === 'string') taskPayload.sectionId = body.sectionId;
  if (typeof body.testPlan === 'string') taskPayload.testPlan = body.testPlan;
  if (typeof body.requiresTestPlan === 'boolean') taskPayload.requiresTestPlan = body.requiresTestPlan;

  let addTaskRes: Response;
  let addTaskData: any;
  try {
    addTaskRes = await fetch(`${internalBase()}/api/store`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.ORG_STUDIO_API_KEY ? { Authorization: `Bearer ${process.env.ORG_STUDIO_API_KEY}` } : {}),
      },
      body: JSON.stringify({ action: 'addTask', task: taskPayload }),
    });
    addTaskData = await addTaskRes.json();
  } catch (e: any) {
    return NextResponse.json(
      { error: 'addTask_failed', message: e?.message },
      { status: 502 }
    );
  }
  if (!addTaskRes.ok) {
    return NextResponse.json(
      { error: 'addTask_rejected', status: addTaskRes.status, detail: addTaskData },
      { status: addTaskRes.status }
    );
  }

  const createdTask = addTaskData.task || addTaskData;
  const taskId = createdTask.id;
  if (!taskId) {
    return NextResponse.json(
      { error: 'addTask_no_id', detail: addTaskData },
      { status: 502 }
    );
  }

  // Step 3 — wait briefly for addTask's fire-and-forget back-link to land,
  // then verify. addTask schedules the items[i].taskId write asynchronously
  // (see store/route.ts line ~871). For one-call semantics we need to confirm
  // the link actually happened.
  //
  // Polling approach: GET the roadmap up to N times until items[i].taskId
  // matches our taskId, with short backoff. If we time out, fall through to
  // doing the back-link ourselves (idempotent — if it already happened we'll
  // just rewrite the same value).
  const MAX_VERIFY_ATTEMPTS = 5;
  const VERIFY_DELAY_MS = 60;
  let linked = false;
  for (let attempt = 0; attempt < MAX_VERIFY_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, VERIFY_DELAY_MS));
    try {
      const verifyRes = await fetch(`${internalBase()}/api/roadmap/${encodeURIComponent(projectId)}`, {
        cache: 'no-store',
      });
      if (verifyRes.ok) {
        const verifyData = await verifyRes.json();
        const v = (verifyData.versions || []).find((x: any) => x.version === version);
        const it = v && (v.items || []).find((i: any) => i.id === itemId);
        if (it && it.taskId === taskId) {
          linked = true;
          break;
        }
      }
    } catch {
      // ignore, try again
    }
  }

  // Step 4 — if addTask's async back-link didn't land in time, do it
  // ourselves explicitly. We re-upsert the version with the items[] array
  // edited in place. This guarantees the one-call semantics: caller sees
  // success only when both task + link exist.
  if (!linked) {
    try {
      const refreshRes = await fetch(`${internalBase()}/api/roadmap/${encodeURIComponent(projectId)}`, {
        cache: 'no-store',
      });
      const refreshData = await refreshRes.json();
      const v = (refreshData.versions || []).find((x: any) => x.version === version);
      if (!v) throw new Error('version disappeared during link');
      const newItems = (v.items || []).map((i: any) => i.id === itemId ? { ...i, taskId } : i);

      const upsertRes = await fetch(`${internalBase()}/api/roadmap/${encodeURIComponent(projectId)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.ORG_STUDIO_API_KEY ? { Authorization: `Bearer ${process.env.ORG_STUDIO_API_KEY}` } : {}),
        },
        body: JSON.stringify({
          action: 'upsert',
          version,
          title: v.title,
          status: v.status,
          versionType: v.version_type || 'outcome',
          items: newItems,
        }),
      });
      if (!upsertRes.ok) {
        // Partial state: task exists, link does not. Surface this honestly
        // — caller can retry the link or delete the task. We don't
        // auto-delete (ticketNumber was already allocated).
        const upsertDetail = await upsertRes.json().catch(() => ({}));
        return NextResponse.json(
          {
            error: 'partial_link',
            message: 'Task was created but the roadmap item link could not be written. Retry the link via POST /api/roadmap/{projectId} upsert, or delete the task.',
            task: createdTask,
            linkError: { status: upsertRes.status, detail: upsertDetail },
          },
          { status: 207 } // multi-status — partial success
        );
      }
      linked = true;
    } catch (e: any) {
      return NextResponse.json(
        {
          error: 'partial_link',
          message: 'Task was created but the explicit link write threw.',
          task: createdTask,
          linkError: { message: e?.message },
        },
        { status: 207 }
      );
    }
  }

  // Success path — fetch the final linked item so caller has the canonical
  // shape to render.
  let finalItem = roadmapItem;
  try {
    const finalRes = await fetch(`${internalBase()}/api/roadmap/${encodeURIComponent(projectId)}`, {
      cache: 'no-store',
    });
    const finalData = await finalRes.json();
    const v = (finalData.versions || []).find((x: any) => x.version === version);
    const it = v && (v.items || []).find((i: any) => i.id === itemId);
    if (it) finalItem = it;
  } catch {
    // non-fatal
  }

  return NextResponse.json({
    action: 'created_and_linked',
    task: createdTask,
    item: finalItem,
  });
}
