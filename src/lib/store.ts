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
const CURRENT_SEED_VERSION = 3; // Bump this to force re-seed

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

  // Done — Catpilot Platform
  { id: 'd01', title: 'Grader v2 — pure LLM grading, no embeddings', status: 'done', projectId: 'proj-catpilot', assignee: 'Henry', createdAt: Date.now() - 86400000 * 14 },
  { id: 'd02', title: 'Server-side pass enforcement + JSON injection fix', status: 'done', projectId: 'proj-catpilot', assignee: 'Henry', createdAt: Date.now() - 86400000 * 12 },
  { id: 'd03', title: 'Grader v2 global rollout — all 29 team-modules updated', status: 'done', projectId: 'proj-catpilot', assignee: 'Henry', createdAt: Date.now() - 86400000 * 7 },
  { id: 'd04', title: 'Module 333 test suites — 9 classes, 97-100% accuracy', status: 'done', projectId: 'proj-catpilot', assignee: 'Henry', createdAt: Date.now() - 86400000 * 12 },
  { id: 'd05', title: 'Module 341/342 seed SQL — clean clones for prod', status: 'done', projectId: 'proj-catpilot', assignee: 'Henry', createdAt: Date.now() - 86400000 * 10 },
  { id: 'd06', title: 'Dedicated test user grader-test@catpilot.ai (user 456)', status: 'done', projectId: 'proj-catpilot', assignee: 'Henry', createdAt: Date.now() - 86400000 * 10 },
  { id: 'd07', title: 'Studio V2 Quick Create — single text box → AI module', status: 'done', projectId: 'proj-catpilot', assignee: 'Henry', createdAt: Date.now() - 86400000 * 16 },
  { id: 'd08', title: 'Reference module injection for quality generation', status: 'done', projectId: 'proj-catpilot', assignee: 'Henry', createdAt: Date.now() - 86400000 * 16 },
  { id: 'd09', title: 'TQF v1.0 pushed + Module 333 learning objectives populated', status: 'done', projectId: 'proj-catpilot', assignee: 'Henry', createdAt: Date.now() - 86400000 * 14 },
  { id: 'd10', title: 'Remove embeddings from generation pipeline', status: 'done', projectId: 'proj-catpilot', assignee: 'Henry', createdAt: Date.now() - 86400000 * 14 },

  // Done — Short-Form Learning
  { id: 'd11', title: 'Short-Form design spec v1.1 — all 11 questions resolved', status: 'done', projectId: 'proj-shortform', assignee: 'Henry', createdAt: Date.now() - 86400000 * 4 },
  { id: 'd12', title: 'Phase 0-6: DB migration, seed, progress bar, speed round', status: 'done', projectId: 'proj-shortform', assignee: 'Henry', createdAt: Date.now() - 86400000 * 3 },
  { id: 'd13', title: 'Module 343 Slack handlers — 5 speed round actions', status: 'done', projectId: 'proj-shortform', assignee: 'Henry', createdAt: Date.now() - 86400000 * 3 },
  { id: 'd14', title: 'Module 343 test suite — 35/35 passing (100%)', status: 'done', projectId: 'proj-shortform', assignee: 'Henry', createdAt: Date.now() - 86400000 * 2 },
  { id: 'd15', title: 'Reset button fix — clear completions, transitions, speed round', status: 'done', projectId: 'proj-shortform', assignee: 'Henry', createdAt: Date.now() - 86400000 * 2 },
  { id: 'd16', title: 'Transition suppression fix for last checkpoint', status: 'done', projectId: 'proj-shortform', assignee: 'Henry', createdAt: Date.now() - 86400000 * 2 },

  // Done — Voice Service
  { id: 'd17', title: 'OpenAI Realtime API integration (gpt-realtime-1.5)', status: 'done', projectId: 'proj-voice', assignee: 'Henry', createdAt: Date.now() - 86400000 * 18 },
  { id: 'd18', title: 'Voice service deployed on App Service with CI/CD', status: 'done', projectId: 'proj-voice', assignee: 'Henry', createdAt: Date.now() - 86400000 * 17 },
  { id: 'd19', title: 'VoIP web client — /demo browser mic → Realtime API', status: 'done', projectId: 'proj-voice', assignee: 'Henry', createdAt: Date.now() - 86400000 * 16 },
  { id: 'd20', title: 'POST /call endpoint with custom system_prompt + context', status: 'done', projectId: 'proj-voice', assignee: 'Henry', createdAt: Date.now() - 86400000 * 15 },
  { id: 'd21', title: 'Security hardening — auth, rate limiting, audit logging', status: 'done', projectId: 'proj-voice', assignee: 'Henry', createdAt: Date.now() - 86400000 * 14 },
  { id: 'd22', title: 'Twilio PSTN integration + SMS inbound/outbound', status: 'done', projectId: 'proj-voice', assignee: 'Henry', createdAt: Date.now() - 86400000 * 2 },
  { id: 'd23', title: 'Whisper hallucination filter — 25 phrases suppressed', status: 'done', projectId: 'proj-voice', assignee: 'Henry', createdAt: Date.now() - 86400000 * 15 },
  { id: 'd24', title: 'Caller greetings + known caller prompts (PII externalized)', status: 'done', projectId: 'proj-voice', assignee: 'Henry', createdAt: Date.now() - 86400000 * 2 },

  // Done — Mission Control
  { id: 'd25', title: 'Mission Control scaffolded — Next.js 16 + Tailwind', status: 'done', projectId: 'proj-mc', assignee: 'Henry', createdAt: Date.now() - 86400000 * 2 },
  { id: 'd26', title: 'Server-side Gateway proxy — WS with auto-reconnect', status: 'done', projectId: 'proj-mc', assignee: 'Henry', createdAt: Date.now() - 86400000 * 2 },
  { id: 'd27', title: 'Gateway proxy fix — Ed25519 + dangerouslyDisableDeviceAuth', status: 'done', projectId: 'proj-mc', assignee: 'Henry', createdAt: Date.now() - 86400000 * 1 },
  { id: 'd28', title: '10 pages built — Dashboard, Projects, Tasks, Agents, Cron, Calendar, Memory, Docs, Team, Activity', status: 'done', projectId: 'proj-mc', assignee: 'Henry', createdAt: Date.now() - 86400000 * 1 },
  { id: 'd29', title: 'Readability overhaul — typography scale, spacing, contrast', status: 'done', projectId: 'proj-mc', assignee: 'Henry', createdAt: Date.now() },
  { id: 'd30', title: 'Team page with org chart + 3 new agents configured', status: 'done', projectId: 'proj-mc', assignee: 'Henry', createdAt: Date.now() },

  // Done — Agent Operations
  { id: 'd31', title: 'Gmail API + Calendar API — OAuth, writer access', status: 'done', projectId: 'proj-ops', assignee: 'Henry', createdAt: Date.now() - 86400000 * 19 },
  { id: 'd32', title: 'Email crons — market hours, after hours, weekends', status: 'done', projectId: 'proj-ops', assignee: 'Henry', createdAt: Date.now() - 86400000 * 8 },
  { id: 'd33', title: 'Daily Take 5 email digest — 7 PM ET cron', status: 'done', projectId: 'proj-ops', assignee: 'Henry', createdAt: Date.now() - 86400000 * 18 },
  { id: 'd34', title: 'Slack DMs working — reinstalled app with im:write', status: 'done', projectId: 'proj-ops', assignee: 'Henry', createdAt: Date.now() - 86400000 * 19 },
  { id: 'd35', title: 'reMarkable tablet — rmapi auth, archive cleanup, PDF push', status: 'done', projectId: 'proj-ops', assignee: 'Henry', createdAt: Date.now() - 86400000 * 6 },
  { id: 'd36', title: 'Moltbook presence — 22 communities, weekly reports pipeline', status: 'done', projectId: 'proj-ops', assignee: 'Henry', createdAt: Date.now() - 86400000 * 5 },
  { id: 'd37', title: 'Research crons — Mon/Tue/Wed/Fri 8pm + daily 1am', status: 'done', projectId: 'proj-ops', assignee: 'Henry', createdAt: Date.now() - 86400000 * 5 },
  { id: 'd38', title: 'TTS voice configured — Steffan DragonHDLatestNeural', status: 'done', projectId: 'proj-ops', assignee: 'Henry', createdAt: Date.now() - 86400000 * 19 },
  { id: 'd39', title: 'Model provider chain — Foundry → Sweden → OpenAI → Copilot', status: 'done', projectId: 'proj-ops', assignee: 'Henry', createdAt: Date.now() - 86400000 * 18 },
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
