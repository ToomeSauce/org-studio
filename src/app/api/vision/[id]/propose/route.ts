import { NextRequest, NextResponse } from 'next/server';
import { buildVisionPrompt } from '@/lib/vision-prompt';
import { getStoreProvider } from '@/lib/store-provider';

export const dynamic = 'force-dynamic';

/**
 * POST /api/vision/[id]/propose
 * 
 * Generates a version proposal prompt for a vision.
 * Returns the structured prompt that an agent (or cron) uses to propose the next version.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await params;
    const store = await getStoreProvider().read();

    const project = store.projects.find((p: any) => p.id === projectId);
    if (!project) {
      return NextResponse.json(
        { error: `Project ${projectId} not found` },
        { status: 404 }
      );
    }

    // Build the agent prompt
    const projectTasks = (store.tasks || []).filter((t: any) => t.projectId === projectId);
    const prompt = await buildVisionPrompt(project, projectTasks, store.projects || []);

    // Check for skip/error
    if (prompt.startsWith('SKIP:') || prompt.startsWith('ERROR:')) {
      return NextResponse.json({ projectId, status: 'skipped', message: prompt });
    }

    // Store as pending (awaiting agent response)
    await getStoreProvider().updateProject(projectId, {
      autonomy: {
        ...(project.autonomy || {}),
        pendingVersion: 'awaiting_agent_response',
        lastProposedAt: Date.now(),
      },
    });

    return NextResponse.json({
      projectId,
      status: 'proposal_generated',
      prompt,
    });
  } catch (e: any) {
    console.error('[Vision Propose]', e);
    return NextResponse.json(
      { error: e.message },
      { status: 500 }
    );
  }
}
