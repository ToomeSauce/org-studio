import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Tests for store data operation patterns.
 *
 * The actual store route is a Next.js API handler (uses NextRequest/NextResponse),
 * so we replicate the core logic patterns here with an in-memory store,
 * mirroring the behavior in src/app/api/store/route.ts and
 * src/app/api/scheduler/route.ts.
 */

// ---------- In-memory store (mirrors route.ts logic) ----------

interface Task {
  id: string;
  title: string;
  status: string;
  assignee: string;
  projectId: string;
  createdAt: number;
  initiatedBy?: string;
  statusHistory?: { status: string; timestamp: number }[];
}

interface StoreData {
  tasks: Task[];
  projects: any[];
  settings?: Record<string, any>;
}

let store: StoreData;

function addTask(taskInput: Partial<Task> & { title: string; status?: string; assignee?: string; projectId?: string; initiatedBy?: string }): Task {
  const id = 'task-' + Math.random().toString(36).slice(2, 10);
  const now = Date.now();
  const initialStatus = taskInput.status || 'backlog';
  const task: Task = {
    id,
    title: taskInput.title,
    status: initialStatus,
    assignee: taskInput.assignee || '',
    projectId: taskInput.projectId || 'proj-1',
    createdAt: now,
    initiatedBy: taskInput.initiatedBy || 'unknown',
    statusHistory: [{ status: initialStatus, timestamp: now }],
  };
  store.tasks.push(task);
  return task;
}

function updateTask(id: string, updates: Partial<Task>): Task | undefined {
  let updated: Task | undefined;
  store.tasks = store.tasks.map(t => {
    if (t.id !== id) return t;
    const u = { ...updates };
    // Auto-track status changes in statusHistory (mirrors route.ts)
    if (u.status && u.status !== t.status) {
      const history = [...(t.statusHistory || [])];
      history.push({ status: u.status, timestamp: Date.now() });
      (u as any).statusHistory = history;
    }
    updated = { ...t, ...u };
    return updated;
  });
  return updated;
}

/** hasActionableWork — mirrors scheduler/route.ts logic */
function hasActionableWork(agentId: string): boolean {
  const teammates = store.settings?.teammates || [];
  const tm = teammates.find((t: any) => t.agentId === agentId);
  const agentName = tm?.name || agentId;
  const nameLower = agentName.toLowerCase();

  return store.tasks.some(t => {
    const assignee = (t.assignee || '').toLowerCase();
    const status = (t.status || '').toLowerCase();
    return (assignee === nameLower || assignee === agentId) &&
           (status === 'backlog' || status === 'in-progress');
  });
}

// ---------- Tests ----------

beforeEach(() => {
  store = {
    tasks: [],
    projects: [{ id: 'proj-1', name: 'Test Project' }],
    settings: {
      teammates: [
        { id: 'tm-1', agentId: 'alex', name: 'Alex', isHuman: false },
        { id: 'tm-2', agentId: 'ana', name: 'Ana', isHuman: false },
        { id: 'tm-3', agentId: '', name: 'Jordan', isHuman: true },
      ],
    },
  };
});

describe('addTask', () => {
  it('creates statusHistory with initial status', () => {
    const task = addTask({ title: 'Fix bug', status: 'backlog' });

    expect(task.statusHistory).toBeDefined();
    expect(task.statusHistory).toHaveLength(1);
    expect(task.statusHistory![0].status).toBe('backlog');
    expect(task.statusHistory![0].timestamp).toBeGreaterThan(0);
  });

  it('sets initiatedBy from input', () => {
    const task = addTask({ title: 'Write docs', initiatedBy: 'alex' });
    expect(task.initiatedBy).toBe('alex');
  });

  it('defaults initiatedBy to "unknown" when not provided', () => {
    const task = addTask({ title: 'Mystery task' });
    expect(task.initiatedBy).toBe('unknown');
  });

  it('defaults status to "backlog" when not specified', () => {
    const task = addTask({ title: 'Unspecified status' });
    expect(task.status).toBe('backlog');
    expect(task.statusHistory![0].status).toBe('backlog');
  });
});

describe('updateTask', () => {
  it('appends to statusHistory on status change', () => {
    const task = addTask({ title: 'Build feature', status: 'backlog' });

    const updated = updateTask(task.id, { status: 'in-progress' });

    expect(updated).toBeDefined();
    expect(updated!.statusHistory).toHaveLength(2);
    expect(updated!.statusHistory![0].status).toBe('backlog');
    expect(updated!.statusHistory![1].status).toBe('in-progress');
  });

  it('does NOT append to statusHistory when status unchanged', () => {
    const task = addTask({ title: 'Stable task', status: 'backlog' });

    const updated = updateTask(task.id, { title: 'Renamed task' });

    expect(updated).toBeDefined();
    expect(updated!.statusHistory).toHaveLength(1); // no new entry
    expect(updated!.title).toBe('Renamed task');
  });

  it('tracks full lifecycle through multiple status changes', () => {
    const task = addTask({ title: 'Lifecycle task', status: 'backlog' });

    updateTask(task.id, { status: 'in-progress' });
    updateTask(task.id, { status: 'review' });
    const final = updateTask(task.id, { status: 'done' });

    expect(final!.statusHistory).toHaveLength(4);
    const statuses = final!.statusHistory!.map(h => h.status);
    expect(statuses).toEqual(['backlog', 'in-progress', 'review', 'done']);
  });
});

describe('hasActionableWork', () => {
  it('returns true when agent has backlog tasks (matched by name)', () => {
    addTask({ title: 'Backlog work', status: 'backlog', assignee: 'Alex' });

    expect(hasActionableWork('alex')).toBe(true);
  });

  it('returns true when agent has in-progress tasks', () => {
    addTask({ title: 'Active work', status: 'in-progress', assignee: 'Alex' });

    expect(hasActionableWork('alex')).toBe(true);
  });

  it('returns false when agent only has done tasks', () => {
    addTask({ title: 'Done work', status: 'done', assignee: 'Alex' });

    expect(hasActionableWork('alex')).toBe(false);
  });

  it('returns false when agent only has review tasks', () => {
    addTask({ title: 'Review work', status: 'review', assignee: 'Alex' });

    expect(hasActionableWork('alex')).toBe(false);
  });

  it('returns false when agent only has planning tasks', () => {
    addTask({ title: 'Planned work', status: 'planning', assignee: 'Alex' });

    expect(hasActionableWork('alex')).toBe(false);
  });

  it('returns false when no tasks assigned to agent', () => {
    addTask({ title: 'Someone else task', status: 'backlog', assignee: 'Ana' });

    expect(hasActionableWork('alex')).toBe(false);
  });

  it('matches case-insensitively', () => {
    addTask({ title: 'Case test', status: 'backlog', assignee: 'MIKEY' });

    expect(hasActionableWork('alex')).toBe(true);
  });

  it('matches by agentId directly', () => {
    addTask({ title: 'Agent ID match', status: 'backlog', assignee: 'alex' });

    expect(hasActionableWork('alex')).toBe(true);
  });
});

describe('trigger cooldown pattern', () => {
  it('debounces rapid triggers within the cooldown window', () => {
    const COOLDOWN_MS = 60_000;
    const lastTriggerByAgent: Record<string, number> = {};

    function shouldTrigger(agentId: string, now: number): boolean {
      const lastTrigger = lastTriggerByAgent[agentId] || 0;
      if (now - lastTrigger < COOLDOWN_MS) {
        return false; // cooldown — skip
      }
      lastTriggerByAgent[agentId] = now;
      return true;
    }

    const t0 = Date.now();

    // First trigger should fire
    expect(shouldTrigger('alex', t0)).toBe(true);

    // Immediate second trigger should be debounced
    expect(shouldTrigger('alex', t0 + 100)).toBe(false);

    // Trigger 30s later — still within cooldown
    expect(shouldTrigger('alex', t0 + 30_000)).toBe(false);

    // Trigger after cooldown expires
    expect(shouldTrigger('alex', t0 + 60_001)).toBe(true);

    // Different agent should not be affected
    expect(shouldTrigger('ana', t0 + 100)).toBe(true);
  });
});
