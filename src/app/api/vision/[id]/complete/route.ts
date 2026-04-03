/**
 * POST /api/vision/[id]/complete
 * 
 * @deprecated — Launch flow simplified to direct task creation from roadmap.
 * This endpoint is no longer called by the Launch button or auto-advance.
 * Kept for potential future use (e.g., AI-generated roadmap proposals).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getStoreProvider } from '@/lib/store-provider';

export const dynamic = 'force-dynamic';

/**
 * Helper: Check if a version bump is major or minor
 * Same integer part before first dot = same major
 * E.g., "0.901" and "0.9" have major=0, "1.0" has major=1
 */
function isSameMajor(currentVersion: string, proposedVersion: string): boolean {
  const currentMajor = currentVersion.split('.')[0];
  const proposedMajor = proposedVersion.split('.')[0];
  return currentMajor === proposedMajor;
}

/**
 * Helper: Send notification via Gateway RPC
 */
async function sendNotification(params: { sessionKey: string; message: string; idempotencyKey: string }) {
  try {
    const port = process.env.PORT || '4501';
    await fetch(`http://127.0.0.1:${port}/api/gateway`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'chat.send',
        params,
      }),
    });
  } catch (e) {
    console.error('[Vision Complete] Notification failed (non-blocking):', e);
  }
}

/**
 * Helper: Generate task ID
 */
function generateTaskId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).substring(7)}`;
}

/**
 * Helper: Check if a task title already exists for this project (done, review, qa, in-progress, or backlog)
 */
function taskAlreadyExists(title: string, projectId: string, tasks: any[]): boolean {
  const normalizedTitle = title.toLowerCase().trim();
  return tasks.some(t =>
    t.projectId === projectId &&
    !t.isArchived &&
    t.title?.toLowerCase().trim() === normalizedTitle
  );
}

/**
 * Helper: Create tasks from proposal (with dedup against existing tasks)
 */
async function createTasksFromProposal(
  projectId: string,
  tasks: any[],
  version: string,
  devOwner: string,
): Promise<string[]> {
  const port = process.env.PORT || '4501';
  const apiKey = process.env.ORG_STUDIO_API_KEY || '';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  // Read current tasks to check for duplicates
  const store = await getStoreProvider().read();
  const existingTasks = store.tasks || [];
  const createdTaskIds: string[] = [];

  for (const taskSpec of tasks) {
    // Skip if a task with the same title already exists for this project
    if (taskAlreadyExists(taskSpec.title, projectId, existingTasks)) {
      console.log(`[Vision Complete] Skipped duplicate: "${taskSpec.title}" (already exists for ${projectId})`);
      continue;
    }

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/store`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          action: 'addTask',
          task: {
            title: taskSpec.title,
            description: taskSpec.impact || '',
            projectId,
            status: 'backlog',
            assignee: devOwner,
            createdBy: 'vision-autonomy',
            initiatedBy: 'agent',
            version,
          },
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.task?.id) {
          createdTaskIds.push(data.task.id);
          // Add to existingTasks so subsequent checks in this batch also dedup
          existingTasks.push(data.task);
        }
      }
    } catch (e) {
      console.error(`[Vision Complete] Failed to create task "${taskSpec.title}":`, e);
    }
  }

  return createdTaskIds;
}

/**
 * Helper: Trigger dev agent scheduler
 */
async function triggerDevAgentScheduler(projectId: string) {
  try {
    const store = await getStoreProvider().read();
    const project = store.projects.find((p: any) => p.id === projectId);
    if (!project) return;

    const assignee = project.devOwner || project.owner;
    if (!assignee) return;

    const teammates = store.settings?.teammates || [];
    const match = teammates.find(
      (t: any) =>
        t.name?.toLowerCase() === assignee.toLowerCase() ||
        t.agentId === assignee.toLowerCase()
    );

    if (match?.agentId) {
      const port = process.env.PORT || '4501';
      await fetch(`http://127.0.0.1:${port}/api/scheduler`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'trigger', agentId: match.agentId }),
      });
    }
  } catch (e) {
    console.error('[Vision Complete] Scheduler trigger failed (non-blocking):', e);
  }
}

/**
 * POST /api/vision/[id]/complete
 *
 * Agent calls this after proposing a version or finding no improvements.
 *
 * Body:
 *   { proposal: { version, tasks, rationale, lifecycleSuggestion } }
 *   OR
 *   { noImprovements: true }
 *
 * Logic:
 * 1. If noImprovements: clear pendingVersion, return
 * 2. Store proposal in autonomy.lastProposal
 * 3. Check approvalMode:
 *    - "per-major": Compare versions. If same major, auto-approve.
 *    - "per-version": Set pendingVersion to version string, wait for button click.
 *    - Default: per-version
 * 4. For auto-approve: create tasks, update currentVersion, clear pendingVersion, notify.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await params;
    const body = await req.json();
    const { proposal, noImprovements } = body;

    const store = await getStoreProvider().read();
    const project = store.projects.find((p: any) => p.id === projectId);

    if (!project) {
      return NextResponse.json({ error: `Project ${projectId} not found` }, { status: 404 });
    }

    // Case 1: No improvements found
    if (noImprovements === true) {
      project.autonomy = project.autonomy || {};
      project.autonomy.pendingVersion = null;
      project.autonomy.lastProposalAt = Date.now();
      project.autonomy.lastProposalStatus = 'no_improvements';

      await getStoreProvider().write(store);

      return NextResponse.json({
        status: 'no_improvements',
        projectId,
        message: 'No meaningful improvements found.',
      });
    }

    // Case 2: Proposal provided
    if (!proposal) {
      return NextResponse.json(
        { error: 'Either proposal or noImprovements is required' },
        { status: 400 }
      );
    }

    const { version, tasks, rationale, lifecycleSuggestion } = proposal;

    if (!version) {
      return NextResponse.json({ error: 'proposal.version is required' }, { status: 400 });
    }

    // Store the proposal
    project.autonomy = project.autonomy || {};
    project.autonomy.lastProposal = {
      version,
      tasks: tasks || [],
      rationale: rationale || '',
      lifecycleSuggestion: lifecycleSuggestion || '',
      proposedAt: Date.now(),
    };

    const approvalMode = project.autonomy?.approvalMode || 'per-version';
    const currentVersion = project.currentVersion || '0.0';
    const devOwner = project.devOwner || project.owner || 'unknown';

    // Determine if this is a major or minor version bump
    const isMajorBump = !isSameMajor(currentVersion, version);

    if (approvalMode === 'per-major' && !isMajorBump) {
      // AUTO-APPROVE: Minor version with per-major mode
      console.log(`[Vision Complete] Auto-approving ${project.name} v${version} (minor bump, per-major mode)`);

      // Create tasks via store API (handles ticketNumbers, dedup, etc.)
      const createdTaskIds = await createTasksFromProposal(
        projectId,
        tasks || [],
        version,
        devOwner,
      );

      // Update project state
      await getStoreProvider().updateProject(projectId, {
        currentVersion: version,
        autonomy: {
          ...project.autonomy,
          pendingVersion: null,
          lastApprovedAt: Date.now(),
          autoAdvance: true,
        },
      });

      // Trigger scheduler (async, best-effort)
      triggerDevAgentScheduler(projectId).catch(() => {});

      // Notify agent (if available)
      if (project.agentId) {
        sendNotification({
          sessionKey: `agent:${project.agentId}:main`,
          message: `✅ Auto-approved ${project.name} v${version}\n${createdTaskIds.length} task(s) created in backlog.`,
          idempotencyKey: `vision-autoapprove-${projectId}-${Date.now()}`,
        }).catch(() => {});
      }

      // Notify vision owner
      sendNotification({
        sessionKey: 'agent:main:main',
        message: `✅ **Auto-approved: ${project.name} v${version}**\n${createdTaskIds.length} task(s) created. Approval mode: per-major (minor version auto-approved).\n\nRationale: ${rationale || 'N/A'}`,
        idempotencyKey: `vision-autoapprove-notify-${projectId}-${Date.now()}`,
      }).catch(() => {});

      return NextResponse.json({
        status: 'auto_approved',
        projectId,
        version,
        taskCount: createdTaskIds.length,
        taskIds: createdTaskIds,
        message: `Auto-approved v${version} and created ${createdTaskIds.length} task(s).`,
      });
    } else {
      // MANUAL APPROVAL: Set pendingVersion to version string, wait for button click
      console.log(`[Vision Complete] Awaiting approval for ${project.name} v${version} (approvalMode: ${approvalMode})`);

      project.autonomy.pendingVersion = version;

      await getStoreProvider().write(store);

      return NextResponse.json({
        status: 'awaiting_approval',
        projectId,
        version,
        message: `Proposal stored. Awaiting human approval for v${version}.`,
      });
    }
  } catch (e: any) {
    console.error('[Vision Complete]', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
