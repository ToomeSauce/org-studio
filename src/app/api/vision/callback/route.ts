/**
 * POST /api/vision/callback
 * 
 * @deprecated — Launch flow simplified to direct task creation from roadmap.
 * This endpoint is no longer called by the Launch button or auto-advance.
 * Kept for potential future use (e.g., AI-generated roadmap proposals).
 * 
 * Handles Telegram inline button callbacks for vision proposals.
 * Expects: { action: "vision_approve" | "vision_reject", projectId: string, version: string, reason?: string }
 * 
 * Routes to the approve/reject endpoints.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getStoreProvider } from '@/lib/store-provider';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action, projectId, version, versionPlan, reason } = body;

    if (!action || !projectId) {
      return NextResponse.json({ error: 'Missing action or projectId' }, { status: 400 });
    }

    const store = await getStoreProvider().read();
    const project = store.projects.find((p: any) => p.id === projectId);
    if (!project) {
      return NextResponse.json({ error: `Project ${projectId} not found` }, { status: 404 });
    }

    if (action === 'vision_approve') {
      // If versionPlan provided, use it. Otherwise construct from pending state.
      const plan = versionPlan || project.autonomy?.lastProposal;
      if (!plan) {
        return NextResponse.json({ error: 'No version plan available to approve' }, { status: 400 });
      }

      // Check if already approved (pending is null)
      if (project.autonomy?.pendingVersion === null) {
        return NextResponse.json({
          status: 'already_processed',
          projectId,
          message: 'Version already processed (auto-approved).',
        });
      }

      // Create tasks from the plan (with dedup)
      const createdTaskIds: string[] = [];
      const tasks = plan.tasks || [];
      const existingTasks = store.tasks || [];
      const port = process.env.PORT || '4501';
      const apiKey = process.env.ORG_STUDIO_API_KEY || '';
      const taskHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) taskHeaders['Authorization'] = `Bearer ${apiKey}`;
      const devOwner = project.devOwner || project.owner;

      for (const task of tasks) {
        // Skip duplicates — check if a task with the same title already exists
        const normalizedTitle = task.title?.toLowerCase().trim();
        const isDupe = existingTasks.some((t: any) =>
          t.projectId === projectId &&
          !t.isArchived &&
          t.title?.toLowerCase().trim() === normalizedTitle
        );
        if (isDupe) {
          console.log(`[Vision Callback] Skipped duplicate: "${task.title}"`);
          continue;
        }

        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/store`, {
            method: 'POST',
            headers: taskHeaders,
            body: JSON.stringify({
              action: 'addTask',
              task: {
                title: task.title,
                description: task.impact || '',
                projectId,
                status: 'backlog',
                assignee: devOwner,
                createdBy: 'vision-autonomy',
                initiatedBy: 'agent',
                version: plan.version,
              },
            }),
          });
          if (res.ok) {
            const data = await res.json();
            if (data.task?.id) {
              createdTaskIds.push(data.task.id);
              existingTasks.push(data.task);
            }
          }
        } catch (e) {
          console.error(`[Vision Callback] Failed to create task "${task.title}":`, e);
        }
      }

      // Update project autonomy state
      project.autonomy = project.autonomy || {};
      project.autonomy.pendingVersion = null;
      project.autonomy.lastApprovedAt = Date.now();
      project.autonomy.lastProposal = plan;
      // Enable auto-advance if not already set (first approval bootstraps the cycle)
      if (!project.autonomy.autoAdvance) {
        project.autonomy.autoAdvance = true;
      }
      if (plan.version) project.currentVersion = plan.version;

      await getStoreProvider().write(store);

      // Trigger the dev agent's event-driven scheduler (fire-and-forget)
      const assignee = project.devOwner || project.owner;
      if (assignee) {
        const teammates = store.settings?.teammates || [];
        const match = teammates.find((t: any) =>
          t.name?.toLowerCase() === assignee.toLowerCase() || t.agentId === assignee.toLowerCase()
        );
        const agentId = match?.agentId;
        if (agentId) {
          const port = process.env.PORT || '4501';
          fetch(`http://127.0.0.1:${port}/api/scheduler`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'trigger', agentId }),
          }).catch(() => {}); // best-effort
        }
      }

      return NextResponse.json({
        status: 'approved',
        projectId,
        version: plan.version,
        tasksCreated: createdTaskIds.length,
        taskIds: createdTaskIds,
      });

    } else if (action === 'vision_reject') {
      project.autonomy = project.autonomy || {};
      project.autonomy.pendingVersion = null;
      project.autonomy.lastRejectedAt = Date.now();
      project.autonomy.lastRejectionReason = reason || 'No reason provided';

      await getStoreProvider().write(store);

      return NextResponse.json({
        status: 'rejected',
        projectId,
        reason: reason || 'No reason provided',
      });

    } else {
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (e: any) {
    console.error('[Vision Callback]', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
