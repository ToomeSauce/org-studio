// Data store — file-backed via /api/store
// Projects and tasks persist on disk at data/store.json

export interface Project {
  id: string;
  name: string;
  description: string;
  phase: 'active' | 'planning' | 'paused' | 'complete' | 'inspiration';
  owner: string;
  priority: 'high' | 'medium' | 'low';
  sortOrder?: number;
  createdAt: number;
  createdBy: string;
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: 'planning' | 'backlog' | 'in-progress' | 'review' | 'done';
  projectId: string;
  assignee: string;
  priority?: 'high' | 'medium' | 'low';
  sortOrder?: number;
  createdAt: number;
}

export interface LoopStep {
  id: string;
  type: 'read-org' | 'sync-tasks' | 'work-next' | 'report' | 'custom';
  description: string;
  instruction?: string; // prompt text for custom steps
  enabled: boolean;
}

export interface PromptSection {
  id: string;           // unique key, e.g. 'task-management', 'column-workflow', 'rules'
  label: string;        // human-readable name for UI
  content: string;      // the actual prompt text (supports ${agentName} and ${agentId} interpolation)
  enabled: boolean;     // can be toggled off
  order: number;        // display/prompt order
  builtIn: boolean;     // true = shipped with Org Studio, false = user-created
}

export interface AgentLoop {
  id: string;
  agentId: string;
  enabled: boolean;
  intervalMinutes: number;
  startOffsetMinutes: number; // offset from the hour (e.g. 5 = :05)
  steps: LoopStep[];
  systemPrompt?: string; // Per-loop system prompt override (optional)
  promptSections?: PromptSection[]; // Custom prompt sections (merged with defaults)
  model?: string; // Model override per loop (default: foundry-openai-chat/gpt-5.4)
  lastRun?: number;
  nextRun?: number;
  cronJobId?: string; // OpenClaw cron job ID once deployed
}

export const DEFAULT_LOOP_STEPS: LoopStep[] = [
  { id: 'step-org', type: 'read-org', description: 'Read ORG.md — refresh mission, values, domain boundaries', enabled: true },
  { id: 'step-sync', type: 'sync-tasks', description: 'Sync tasks — check Context Board, create task if doing untracked work', enabled: true },
  { id: 'step-work', type: 'work-next', description: 'Work next — progress highest priority in-progress task, or pull from backlog', enabled: true },
  { id: 'step-report', type: 'report', description: 'Report — update task status, move completed to Done, set activity status', enabled: true },
];

// === Cache for synchronous access (hydrated from API) ===
let _projects: Project[] = [];
let _tasks: Task[] = [];
let _loaded = false;

// === API helpers ===
async function fetchStore(): Promise<{ projects: Project[]; tasks: Task[] }> {
  const resp = await fetch('/api/store');
  if (!resp.ok) throw new Error('Failed to fetch store');
  return resp.json();
}

async function mutateStore(action: string, payload: Record<string, any> = {}): Promise<any> {
  const resp = await fetch('/api/store', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  if (!resp.ok) throw new Error('Store mutation failed');
  return resp.json();
}

// === Hydration (call once from useEffect) ===
export async function hydrateStore(): Promise<{ projects: Project[]; tasks: Task[] }> {
  const data = await fetchStore();
  _projects = data.projects;
  _tasks = data.tasks;
  _loaded = true;
  return data;
}

// === Synchronous getters (return cached data) ===
export function getProjects(): Project[] { return _projects; }
export function getTasks(): Task[] { return _tasks; }
export function isStoreLoaded(): boolean { return _loaded; }

// === Async mutators ===
export async function addTask(task: Omit<Task, 'id' | 'createdAt'>): Promise<Task> {
  const result = await mutateStore('addTask', { task });
  _tasks.push(result.task);
  return result.task;
}

export async function updateTask(id: string, updates: Partial<Task>): Promise<void> {
  await mutateStore('updateTask', { id, updates });
  _tasks = _tasks.map(t => t.id === id ? { ...t, ...updates } : t);
}

export async function deleteTask(id: string): Promise<void> {
  await mutateStore('deleteTask', { id });
  _tasks = _tasks.filter(t => t.id !== id);
}

export async function addProject(proj: Omit<Project, 'id' | 'createdAt'>): Promise<Project> {
  const result = await mutateStore('addProject', { project: proj });
  _projects.push(result.project);
  return result.project;
}

export async function updateProject(id: string, updates: Partial<Project>): Promise<void> {
  await mutateStore('updateProject', { id, updates });
  _projects = _projects.map(p => p.id === id ? { ...p, ...updates } : p);
}

export function saveProjects(p: Project[]) { _projects = p; }
export function saveTasks(t: Task[]) { _tasks = t; }

export function getProjectCompletion(projectId: string): number {
  const tasks = _tasks.filter(t => t.projectId === projectId);
  if (tasks.length === 0) return 0;
  const done = tasks.filter(t => t.status === 'done').length;
  return Math.round((done / tasks.length) * 100);
}
