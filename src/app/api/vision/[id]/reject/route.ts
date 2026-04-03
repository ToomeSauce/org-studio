import { NextRequest, NextResponse } from 'next/server';
import { getStoreProvider } from '@/lib/store-provider';

export const dynamic = 'force-dynamic';

async function readStore(): Promise<any> {
  return await getStoreProvider().read();
}

async function writeStore(data: any): Promise<void> {
  await getStoreProvider().write(data);
}

/**
 * POST /api/vision/[id]/reject
 * 
 * Rejects a pending version proposal.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await params;
    const body = await req.json();
    const { reason = 'No reason provided' } = body;

    const store = await readStore();

    // Find project
    const project = store.projects.find((p: any) => p.id === projectId);
    if (!project) {
      return NextResponse.json(
        { error: `Project ${projectId} not found` },
        { status: 404 }
      );
    }

    // Clear pending version
    project.autonomy = project.autonomy || {};
    project.autonomy.pendingVersion = undefined;
    project.autonomy.lastRejectedAt = Date.now();
    project.autonomy.lastRejectionReason = reason;

    await writeStore(store);

    return NextResponse.json({
      projectId,
      reason,
      message: `Rejected version proposal with reason: ${reason}`,
    });
  } catch (e: any) {
    console.error('[Vision Reject]', e);
    return NextResponse.json(
      { error: e.message },
      { status: 500 }
    );
  }
}
