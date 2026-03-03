// Data store — localStorage now, PostgreSQL later
// All tables prefixed with hank_ when we migrate

export interface Project {
  id: string;
  name: string;
  description: string;
  phase: 'active' | 'planning' | 'paused' | 'complete';
  owner: string;
  priority: 'high' | 'medium' | 'low';
  createdAt: number;
  createdBy: string;
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: 'backlog' | 'todo' | 'in-progress' | 'review' | 'done';
  projectId: string;
  assignee: string;
  priority?: 'high' | 'medium' | 'low';
  createdAt: number;
}

const PROJECTS_KEY = 'mc_projects';
const TASKS_KEY = 'mc_tasks';
const SEED_VERSION_KEY = 'mc_seed_version';
const CURRENT_SEED_VERSION = 2; // Bump this to force re-seed

function generateId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// === Default seed data ===
const DEFAULT_PROJECTS: Project[] = [
  { id: 'proj-catpilot', name: 'Catpilot Platform', description: 'Core coaching platform — grader v2, studio, frontend, backend', phase: 'active', owner: 'Henry', priority: 'high', createdAt: Date.now() - 86400000 * 14, createdBy: 'Henry' },
  { id: 'proj-shortform', name: 'Short-Form Learning', description: 'Micro-checkpoint modules with speed rounds — Module 343 prototype', phase: 'active', owner: 'Henry', priority: 'high', createdAt: Date.now() - 86400000 * 5, createdBy: 'Henry' },
  { id: 'proj-voice', name: 'Voice Service', description: 'AI phone calls via OpenAI Realtime API — Twilio PSTN + VoIP demo', phase: 'paused', owner: 'Henry', priority: 'medium', createdAt: Date.now() - 86400000 * 20, createdBy: 'Henry' },
  { id: 'proj-mc', name: 'Mission Control', description: 'Local dashboard for agent visibility — Gateway proxy, kanban, calendar', phase: 'active', owner: 'Henry', priority: 'medium', createdAt: Date.now() - 86400000 * 2, createdBy: 'Henry' },
  { id: 'proj-ops', name: 'Agent Operations', description: 'Email crons, research reports, Moltbook, reMarkable sync', phase: 'active', owner: 'Henry', priority: 'low', createdAt: Date.now() - 86400000 * 10, createdBy: 'Henry' },
];

const DEFAULT_TASKS: Task[] = [
  // Backlog (assigned to Basil — ideas/requests)
  { id: 't1', title: 'Enable ADMIN_CONTENT_GEN_ENABLED on staging', status: 'backlog', projectId: 'proj-catpilot', assignee: 'Basil', createdAt: Date.now() - 86400000 * 7 },
  { id: 't2', title: 'Create Event Grid subscription for incoming calls', status: 'backlog', projectId: 'proj-voice', assignee: 'Basil', createdAt: Date.now() - 86400000 * 10 },
  { id: 't3', title: 'Purchase real phone number before trial expires Mar 27', status: 'backlog', projectId: 'proj-voice', assignee: 'Basil', createdAt: Date.now() - 86400000 * 5 },
  { id: 't4', title: 'Enable Google Sheets API on project 838199623940', status: 'backlog', projectId: 'proj-ops', assignee: 'Basil', createdAt: Date.now() - 86400000 * 3 },
  { id: 't5', title: 'Run seed scripts against production DB (modules 341/342)', status: 'backlog', projectId: 'proj-catpilot', assignee: 'Basil', createdAt: Date.now() - 86400000 * 8 },

  // Todo (assigned to Henry)
  { id: 't6', title: 'Improve Module 343 Checkpoint 3 hint scaffolding', status: 'todo', projectId: 'proj-shortform', assignee: 'Henry', createdAt: Date.now() - 86400000 * 2 },
  { id: 't7', title: 'Fix Module 343 Checkpoint 4 domain mismatch prompt', status: 'todo', projectId: 'proj-shortform', assignee: 'Henry', createdAt: Date.now() - 86400000 * 2 },
  { id: 't8', title: 'Short-Form REST API endpoints for frontend portal', status: 'todo', projectId: 'proj-shortform', assignee: 'Henry', createdAt: Date.now() - 86400000 * 1 },
  { id: 't9', title: 'Parallel checkpoint generation (asyncio.gather)', status: 'todo', projectId: 'proj-catpilot', assignee: 'Henry', createdAt: Date.now() - 86400000 * 6 },
  { id: 't10', title: 'Debug PSTN audio path — call connects but no voice', status: 'todo', projectId: 'proj-voice', assignee: 'Henry', createdAt: Date.now() - 86400000 * 8 },

  // In Progress (Henry)
  { id: 't11', title: 'Mission Control — enhanced dashboard + weekly calendar', status: 'in-progress', projectId: 'proj-mc', assignee: 'Henry', createdAt: Date.now() - 86400000 },
  { id: 't12', title: 'Ed25519 device identity for Gateway handshake', status: 'in-progress', projectId: 'proj-mc', assignee: 'Henry', createdAt: Date.now() - 86400000 },

  // Review
  { id: 't13', title: 'Short-Form Module 343 — 35/35 test suite passing', status: 'review', projectId: 'proj-shortform', assignee: 'Henry', createdAt: Date.now() - 86400000 * 1 },
  { id: 't14', title: 'Grader v2 global rollout — 29 team-modules updated', status: 'review', projectId: 'proj-catpilot', assignee: 'Henry', createdAt: Date.now() - 86400000 * 5 },

  // Done
  { id: 't15', title: 'Gateway proxy — stable WS connection + token auth', status: 'done', projectId: 'proj-mc', assignee: 'Henry', createdAt: Date.now() - 86400000 * 1 },
  { id: 't16', title: 'Voice service deployed on App Service with CI/CD', status: 'done', projectId: 'proj-voice', assignee: 'Henry', createdAt: Date.now() - 86400000 * 15 },
  { id: 't17', title: 'Reset button fix + transition suppression for short-form', status: 'done', projectId: 'proj-shortform', assignee: 'Henry', createdAt: Date.now() - 86400000 * 1 },
];

// === Storage helpers ===
function checkSeedVersion() {
  if (typeof window === 'undefined') return;
  try {
    const stored = parseInt(localStorage.getItem(SEED_VERSION_KEY) || '0', 10);
    if (stored < CURRENT_SEED_VERSION) {
      // Clear stale data so defaults re-seed
      localStorage.removeItem(PROJECTS_KEY);
      localStorage.removeItem(TASKS_KEY);
      localStorage.setItem(SEED_VERSION_KEY, String(CURRENT_SEED_VERSION));
    }
  } catch {}
}

function load<T>(key: string, defaults: T[]): T[] {
  if (typeof window === 'undefined') return defaults;
  checkSeedVersion();
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : defaults;
  } catch { return defaults; }
}

function save<T>(key: string, data: T[]) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(key, JSON.stringify(data));
}

// === Public API ===
export function getProjects(): Project[] { return load(PROJECTS_KEY, DEFAULT_PROJECTS); }
export function getTasks(): Task[] { return load(TASKS_KEY, DEFAULT_TASKS); }
export function saveProjects(p: Project[]) { save(PROJECTS_KEY, p); }
export function saveTasks(t: Task[]) { save(TASKS_KEY, t); }

export function addTask(task: Omit<Task, 'id' | 'createdAt'>): Task {
  const tasks = getTasks();
  const newTask: Task = { ...task, id: generateId(), createdAt: Date.now() };
  tasks.push(newTask);
  saveTasks(tasks);
  return newTask;
}

export function updateTask(id: string, updates: Partial<Task>) {
  const tasks = getTasks().map(t => t.id === id ? { ...t, ...updates } : t);
  saveTasks(tasks);
}

export function deleteTask(id: string) {
  saveTasks(getTasks().filter(t => t.id !== id));
}

export function addProject(proj: Omit<Project, 'id' | 'createdAt'>): Project {
  const projects = getProjects();
  const newProj: Project = { ...proj, id: generateId(), createdAt: Date.now() };
  projects.push(newProj);
  saveProjects(projects);
  return newProj;
}

export function getProjectCompletion(projectId: string): number {
  const tasks = getTasks().filter(t => t.projectId === projectId);
  if (tasks.length === 0) return 0;
  const done = tasks.filter(t => t.status === 'done').length;
  return Math.round((done / tasks.length) * 100);
}
