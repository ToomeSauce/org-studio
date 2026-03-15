import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { authenticateRequest } from '@/lib/auth';

const STORE_PATH = join(process.cwd(), 'data', 'store.json');
const EXAMPLE_PATH = join(process.cwd(), 'data', 'store.example.json');
const SCHEDULER_URL = 'http://localhost:4501/api/scheduler';

interface StoreData {
  projects: any[];
  tasks: any[];
  settings?: Record<string, any>;
}

function readStore(): StoreData {
  if (!existsSync(STORE_PATH)) {
    // Bootstrap from example if available
    if (existsSync(EXAMPLE_PATH)) {
      const example = readFileSync(EXAMPLE_PATH, 'utf-8');
      writeFileSync(STORE_PATH, example);
      return JSON.parse(example);
    }
    return { projects: [], tasks: [] };
  }
  return JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
}

function writeStore(data: StoreData) {
  writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
}

/** Fire event-driven scheduler trigger for an agent when work lands in their backlog. Best-effort, non-blocking. */
function triggerAgentLoop(assignee: string, store: StoreData) {
  if (!assignee) return;
  // Resolve assignee name → agentId
  const teammates = store.settings?.teammates || [];
  const match = teammates.find((t: any) =>
    t.name?.toLowerCase() === assignee.toLowerCase() ||
    t.agentId === assignee.toLowerCase()
  );
  const agentId = match?.agentId;
  if (!agentId) return;

  // Fire-and-forget — don't await, don't block the response
  fetch(SCHEDULER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'trigger', agentId }),
  }).catch(() => {}); // swallow errors — best-effort
}

// GET — return all projects and tasks
export async function GET() {
  try {
    const data = readStore();
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST — handle mutations
export async function POST(req: NextRequest) {
  const authError = authenticateRequest(req);
  if (authError) return authError;

  try {
    const body = await req.json();
    const { action, ...payload } = body;
    const store = readStore();

    switch (action) {
      case 'addTask': {
        const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        const now = Date.now();
        const initialStatus = payload.task?.status || 'backlog';
        const task = {
          id,
          createdAt: now,
          ...payload.task,
          statusHistory: [{ status: initialStatus, timestamp: now }],
          initiatedBy: payload.task?.initiatedBy || 'unknown',
        };
        store.tasks.push(task);
        writeStore(store);

        // Event-driven: if task lands in backlog, trigger the assignee's loop
        if (initialStatus === 'backlog' && task.assignee) {
          triggerAgentLoop(task.assignee, store);
        }

        return NextResponse.json({ ok: true, task });
      }

      case 'updateTask': {
        let triggeredAssignee: string | null = null;
        store.tasks = store.tasks.map(t => {
          if (t.id !== payload.id) return t;
          const updates = { ...payload.updates };
          // Auto-track status changes in statusHistory
          if (updates.status && updates.status !== t.status) {
            const history = t.statusHistory || [];
            history.push({ status: updates.status, timestamp: Date.now() });
            updates.statusHistory = history;
          }
          const updated = { ...t, ...updates };
          // If task moved to backlog (or reassigned while in backlog), trigger the loop
          if ((updated.status === 'backlog') &&
              (updates.status === 'backlog' || updates.assignee) &&
              updated.assignee) {
            triggeredAssignee = updated.assignee;
          }
          return updated;
        });
        writeStore(store);

        if (triggeredAssignee) {
          triggerAgentLoop(triggeredAssignee, store);
        }

        return NextResponse.json({ ok: true });
      }

      case 'deleteTask': {
        store.tasks = store.tasks.filter(t => t.id !== payload.id);
        writeStore(store);
        return NextResponse.json({ ok: true });
      }

      case 'addProject': {
        const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        const project = { id, createdAt: Date.now(), ...payload.project };
        store.projects.push(project);
        writeStore(store);
        return NextResponse.json({ ok: true, project });
      }

      case 'updateProject': {
        store.projects = store.projects.map(p =>
          p.id === payload.id ? { ...p, ...payload.updates } : p
        );
        writeStore(store);
        return NextResponse.json({ ok: true });
      }

      case 'deleteProject': {
        store.projects = store.projects.filter(p => p.id !== payload.id);
        writeStore(store);
        return NextResponse.json({ ok: true });
      }

      case 'updateSettings': {
        store.settings = { ...(store.settings || {}), ...payload.settings };
        writeStore(store);
        return NextResponse.json({ ok: true });
      }

      case 'addTeammate': {
        const teammates = store.settings?.teammates || [];
        const id = payload.teammate?.id || Math.random().toString(36).slice(2, 10);
        const teammate = { id, ...payload.teammate };
        teammates.push(teammate);
        store.settings = { ...(store.settings || {}), teammates };
        writeStore(store);
        return NextResponse.json({ ok: true, teammate });
      }

      case 'updateTeammate': {
        const teammates = store.settings?.teammates || [];
        const idx = teammates.findIndex((t: any) => t.id === payload.id);
        if (idx >= 0) {
          teammates[idx] = { ...teammates[idx], ...payload.updates };
          store.settings = { ...(store.settings || {}), teammates };
          writeStore(store);
        }
        return NextResponse.json({ ok: true });
      }

      case 'removeTeammate': {
        const teammates = (store.settings?.teammates || []).filter((t: any) => t.id !== payload.id);
        store.settings = { ...(store.settings || {}), teammates };
        writeStore(store);
        return NextResponse.json({ ok: true });
      }

      case 'updateValues': {
        store.settings = { ...(store.settings || {}), values: payload.values };
        writeStore(store);
        return NextResponse.json({ ok: true });
      }

      case 'addLoop': {
        const loops = store.settings?.loops || [];
        const id = 'loop-' + Math.random().toString(36).slice(2, 10);
        const loop = { id, ...payload.loop };
        loops.push(loop);
        store.settings = { ...(store.settings || {}), loops };
        writeStore(store);
        return NextResponse.json({ ok: true, loop: { ...loop, id } });
      }

      case 'updateLoop': {
        const loops = store.settings?.loops || [];
        const idx = loops.findIndex((l: any) => l.id === payload.id);
        if (idx >= 0) {
          loops[idx] = { ...loops[idx], ...payload.updates };
          store.settings = { ...(store.settings || {}), loops };
          writeStore(store);
        }
        return NextResponse.json({ ok: true });
      }

      case 'deleteLoop': {
        const loops = (store.settings?.loops || []).filter((l: any) => l.id !== payload.id);
        store.settings = { ...(store.settings || {}), loops };
        writeStore(store);
        return NextResponse.json({ ok: true });
      }

      case 'updateLoopPreamble': {
        store.settings = { ...(store.settings || {}), loopPreamble: payload.loopPreamble };
        writeStore(store);
        return NextResponse.json({ ok: true });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
