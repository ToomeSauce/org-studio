import { NextRequest, NextResponse } from 'next/server';
import { getStoreProvider } from '@/lib/store-provider';

export const dynamic = 'force-dynamic';

/**
 * POST /api/vision/[id]/approve
 * 
 * Approves a pending version and creates tasks.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await params;
    const body = await req.json();
    const { versionPlan } = body;

    if (!versionPlan) {
      return NextResponse.json(
        { error: 'versionPlan is required' },
        { status: 400 }
      );
    }

    const store = await getStoreProvider().read();

    // Find project
    const project = store.projects.find((p: any) => p.id === projectId);
    if (!project) {
      return NextResponse.json(
        { error: `Project ${projectId} not found` },
        { status: 404 }
      );
    }

    // Create tasks from versionPlan.tasks
    const createdTaskIds: string[] = [];
    const devOwner = project.devOwner || project.owner;
    const maxTicketNumber = Math.max(...(store.tasks || []).map((t: any) => t.ticketNumber || 0), 0);

    if (versionPlan.tasks && Array.isArray(versionPlan.tasks)) {
      for (const taskSpec of versionPlan.tasks) {
        const taskId = `task-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        const task = {
          id: taskId,
          ticketNumber: maxTicketNumber + 1,
          title: taskSpec.title,
          description: taskSpec.impact || '',
          status: 'backlog',
          projectId,
          assignee: devOwner,
          createdAt: Date.now(),
          createdBy: 'vision-autonomy',
          comments: [
            {
              id: `comment-${Date.now()}`,
              author: 'vision-autonomy',
              content: `Part of version ${versionPlan.version} (approved)`,
              createdAt: Date.now(),
              type: 'system',
            },
          ],
          statusHistory: [
            {
              status: 'backlog',
              timestamp: Date.now(),
              by: 'vision-autonomy',
            },
          ],
        };
        store.tasks.push(task);
        createdTaskIds.push(taskId);
      }
    }

    // Update project
    project.autonomy = project.autonomy || {};
    project.autonomy.pendingVersion = undefined;
    project.autonomy.lastApprovedAt = Date.now();
    project.currentVersion = versionPlan.version;

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
      projectId,
      versionPlan,
      createdTaskIds,
      message: `Approved version ${versionPlan.version} and created ${createdTaskIds.length} task(s).`,
    });
  } catch (e: any) {
    console.error('[Vision Approve]', e);
    return NextResponse.json(
      { error: e.message },
      { status: 500 }
    );
  }
}
