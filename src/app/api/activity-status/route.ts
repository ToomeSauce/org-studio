import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { authenticateRequest } from '@/lib/auth';

const STATUS_PATH = join(process.cwd(), 'data', 'activity-status.json');

interface AgentStatus {
  agent: string;
  status: string;       // e.g. "editing garage.py", "running tests", "idle"
  detail?: string;      // optional longer description
  updatedAt: number;
}

type StatusStore = Record<string, AgentStatus>;

function readStatuses(): StatusStore {
  if (!existsSync(STATUS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STATUS_PATH, 'utf-8'));
  } catch { return {}; }
}

function writeStatuses(data: StatusStore) {
  writeFileSync(STATUS_PATH, JSON.stringify(data, null, 2));
}

// GET — return all agent statuses
export async function GET() {
  const statuses = readStatuses();
  // Expire entries older than 10 minutes
  const now = Date.now();
  const active: StatusStore = {};
  for (const [key, val] of Object.entries(statuses)) {
    if (now - val.updatedAt < 600000) {
      active[key] = val;
    }
  }
  return NextResponse.json({ statuses: active });
}

// POST — agent reports its status
export async function POST(req: NextRequest) {
  const authError = authenticateRequest(req);
  if (authError) return authError;

  try {
    const body = await req.json();
    const { agent, status, detail } = body;
    if (!agent || !status) {
      return NextResponse.json({ error: 'agent and status required' }, { status: 400 });
    }
    const statuses = readStatuses();
    statuses[agent] = {
      agent,
      status,
      detail: detail || undefined,
      updatedAt: Date.now(),
    };
    writeStatuses(statuses);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// DELETE — agent clears its status (going idle)
export async function DELETE(req: NextRequest) {
  const authError = authenticateRequest(req);
  if (authError) return authError;

  try {
    const { agent } = await req.json();
    if (!agent) {
      return NextResponse.json({ error: 'agent required' }, { status: 400 });
    }
    const statuses = readStatuses();
    delete statuses[agent];
    writeStatuses(statuses);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
