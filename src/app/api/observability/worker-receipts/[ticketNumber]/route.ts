import { NextRequest, NextResponse } from 'next/server';
import { cloudReadGate } from '@/lib/read-gate';
import { resolveWorkspaceIdForRequest } from '@/lib/workspace-auth';
import { getWorkerPipelineReceipt } from '@/lib/worker-pipeline-receipt';

export const dynamic = 'force-dynamic';

function parseTicketNumber(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) return null;
  return parsed;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ ticketNumber: string }> },
) {
  const denied = await cloudReadGate(req);
  if (denied) return denied;

  const workspaceId = await resolveWorkspaceIdForRequest(req);
  const { ticketNumber: rawTicketNumber } = await params;
  const ticketNumber = parseTicketNumber(rawTicketNumber);
  if (ticketNumber == null) {
    return NextResponse.json(
      { error: 'Invalid ticketNumber (must be numeric)' },
      { status: 400 },
    );
  }

  const receipt = await getWorkerPipelineReceipt(workspaceId, ticketNumber);
  if (!receipt) {
    return NextResponse.json(
      { error: 'Worker receipt not found' },
      { status: 404 },
    );
  }

  return NextResponse.json(receipt);
}
