// Data store — file-backed via /api/store
// Projects and tasks persist on disk at data/store.json

export interface Section {
  id: string;
  name: string;
  owner: string;       // assignee name (free text, matches teammate name)
  outcomes: string;    // free text
  contract: string;    // free text describing what this section owes to / expects from other sections
  archivedAt?: number;   // Soft-delete timestamp — section is hidden but chat history preserved
  archivedBy?: string;   // Who archived this section
}

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
  workspace_id?: string;  // v0.16: multi-workspace support (default: 'default-workspace')

  // --- Vision Board fields (Phase 1+) ---
  visionDocPath?: string;       // Path to VISION.md (repo-relative or absolute)
  repoUrl?: string;             // GitHub repo URL (e.g. "org/my-project")
  lifecycle?: 'building' | 'mature' | 'bau' | 'sunset';
  visionOwner?: string;         // Human who approves version plans
  devOwner?: string;            // Agent/human who does dev work
  qaOwner?: string;             // Agent/human who runs QA
  currentVersion?: string;      // e.g. "0.3"
  dependsOn?: string[];         // Project IDs this vision depends on
  autonomy?: {
    enabled: boolean;
    cadence?: 'daily' | 'weekly' | 'biweekly' | 'monthly'; // @deprecated - replaced by approvalMode
    approvalMode?: 'per-version' | 'per-major';
    lastProposedAt?: number;
    lastApprovedAt?: number;
    lastLaunchedAt?: number;
    pendingVersion?: string;
    cronJobId?: string; // @deprecated - replaced by Launch model
  };

  // --- Outcomes & Guardrails (Phase 2) ---
  outcomes?: Array<{
    id: string;
    text: string;
    done: boolean;
    createdAt: number;
    completedAt?: number;
  }>;
  pendingOutcomes?: Array<{
    id: string;
    text: string;
    justification: string;  // One-line: who benefits and why
    proposedBy: string;      // Agent name
    proposedAt: number;
  }>;
  guardrails?: string; // Combined boundaries + contribution criteria

  // --- Sections (per-project organizational units) ---
  sections?: Section[];

  // --- Archive / migration ---
  isArchived?: boolean;
  archivedAt?: number;
  archivedReason?: string;  // e.g. "qa-fold"
  migratedTo?: { projectId: string; sectionId: string };
}

export interface CommentScope {
  kind: 'task' | 'section' | 'board' | 'dm' | 'channel';
  taskId?: string;
  sectionId?: string;
  boardProjectId?: string;
  dmThreadId?: string;
}

export interface Comment {
  id: string;
  author: string;
  content: string;
  createdAt: number;
  type?: 'comment' | 'system'; // system = auto-generated (reopened, reassigned, etc.)
  model?: string;
  mentions?: string[]; // @agent mentions for notification
  scope?: CommentScope;
}

/** @deprecated Use Comment instead */
export type TaskComment = Comment;

export interface Task {
  id: string;
  ticketNumber?: number;  // Sequential ticket number (#1, #2, etc.) for easy reference
  title: string;
  description?: string;
  workspace_id?: string;  // v0.16: multi-workspace support (default: 'default-workspace')
  // Seed task structured fields
  // @deprecated — use description for goals/vision. Kept for backward compat.
  outcome?: string;
  doneWhen?: string;     // Testable exit criteria (most critical field)
  constraints?: string;  // Boundaries / what NOT to do
  context?: string;      // Links, files, prior art
  testPlan?: string;     // Test plan — dev writes it, self-executes or QA-executes depending on testType
  testType?: 'self' | 'qa';   // Testing type: 'self' (default) = dev self-tests; 'qa' = dev self-tests then QA agent runs e2e
  testAssignee?: string;       // Who runs QA — explicit > team default > self (only relevant when testType: 'qa')
  reviewNotes?: string;   // Agent writes summary when moving to review/done
  outcomeIds?: string[];  // Which outcomes this task serves
  isArchived?: boolean;   // Archive flag — tasks are archived instead of deleted
  archivedAt?: number;    // When task was archived
  archivedBy?: string;    // Who archived it
  status: 'planning' | 'backlog' | 'in-progress' | 'qa' | 'review' | 'done';
  projectId: string;
  assignee: string;
  priority?: 'high' | 'medium' | 'low';
  sectionId?: string;     // Section within the project this task belongs to
  version?: string;       // Version field (e.g., "0.902") — set when vision cycle creates the task
  sortOrder?: number;
  createdAt: number;
  lastActivityAt?: number;  // Track last comment, status change, or field update (for stall detection)
  loopCount?: number;       // Scheduler loops on this task at same status (resets on status change)
  loopPausedAt?: number;    // Timestamp when loop was paused due to stall detection
  loopPauseReason?: string; // Why the loop was paused
  devHandoff?: {            // Context injection: dev attaches notes when resolving a blocker
    message: string;          // The context/instructions for the agent
    author: string;           // Who wrote it
    createdAt: number;        // When it was written
  };
  taskType?: 'feature' | 'bug' | 'chore' | 'spike' | 'followup';
  roadmapItemId?: string;  // links roadmap tasks back to their RoadmapItem (items[].id). Presence = roadmap task.
  comments?: TaskComment[];
  statusHistory?: { status: string; timestamp: number; by?: string; model?: string }[];
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
  console.log('[store:mutateStore] sending', { action, payload: JSON.stringify(payload).slice(0, 500) });
  const resp = await fetch('/api/store', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  console.log('[store:mutateStore] response', { action, status: resp.status, ok: resp.ok });
  if (resp.status === 401) {
    console.warn('[store:mutateStore] 401 — session expired, redirecting to login');
    if (typeof window !== 'undefined') {
      window.location.href = '/login';
    }
    throw new Error('Session expired');
  }
  if (!resp.ok) throw new Error(`Store mutation failed: ${resp.status}`);
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
  console.log('[store:updateProject] called', { id, updates: JSON.stringify(updates).slice(0, 500) });
  await mutateStore('updateProject', { id, updates });
  _projects = _projects.map(p => p.id === id ? { ...p, ...updates } : p);
  console.log('[store:updateProject] local cache updated');
}

export async function addComment(taskId: string, comment: Omit<TaskComment, 'id' | 'createdAt'>): Promise<TaskComment> {
  const result = await mutateStore('addComment', { taskId, comment });
  // Update local cache
  _tasks = _tasks.map(t => t.id === taskId ? { ...t, comments: [...(t.comments || []), result.comment] } : t);
  return result.comment;
}

// === Section mutators ===
export async function addSection(projectId: string, section: Omit<Section, 'id'> & { id?: string }): Promise<Section> {
  const result = await mutateStore('addSection', { projectId, section });
  // Update local cache
  _projects = _projects.map(p => {
    if (p.id !== projectId) return p;
    return { ...p, sections: [...(p.sections || []), result.section] };
  });
  return result.section;
}

export async function updateSection(projectId: string, sectionId: string, updates: Partial<Section>): Promise<void> {
  await mutateStore('updateSection', { projectId, sectionId, updates });
  _projects = _projects.map(p => {
    if (p.id !== projectId) return p;
    return { ...p, sections: (p.sections || []).map(s => s.id === sectionId ? { ...s, ...updates } : s) };
  });
}

export async function deleteSection(projectId: string, sectionId: string): Promise<void> {
  await mutateStore('deleteSection', { projectId, sectionId });
  _projects = _projects.map(p => {
    if (p.id !== projectId) return p;
    return { ...p, sections: (p.sections || []).filter(s => s.id !== sectionId) };
  });
}

export async function reorderSections(projectId: string, sectionIds: string[]): Promise<void> {
  await mutateStore('reorderSections', { projectId, sectionIds });
  _projects = _projects.map(p => {
    if (p.id !== projectId) return p;
    const sMap = new Map((p.sections || []).map(s => [s.id, s]));
    const ordered = sectionIds.filter(id => sMap.has(id)).map(id => sMap.get(id)!);
    const rest = (p.sections || []).filter(s => !sectionIds.includes(s.id));
    return { ...p, sections: [...ordered, ...rest] };
  });
}

export function saveProjects(p: Project[]) { _projects = p; }
export function saveTasks(t: Task[]) { _tasks = t; }

export function getProjectCompletion(projectId: string): number {
  const tasks = _tasks.filter(t => t.projectId === projectId);
  if (tasks.length === 0) return 0;
  const done = tasks.filter(t => t.status === 'done').length;
  return Math.round((done / tasks.length) * 100);
}

// --- Live Status Indicators ---

export type TaskActivityStatus = 'active' | 'idle' | 'stalled';

const STALL_THRESHOLDS = {
  'in-progress': 4 * 60 * 60 * 1000,  // 4 hours for in-progress
  'qa': 6 * 60 * 60 * 1000,            // 6 hours for QA
  'review': 8 * 60 * 60 * 1000,        // 8 hours for review
};

const IDLE_THRESHOLD = 2 * 60 * 60 * 1000;  // 2 hours = idle, 4+ = stalled

export function getTaskActivityStatus(task: Task): TaskActivityStatus {
  if (!['in-progress', 'qa', 'review'].includes(task.status)) {
    return 'active';  // Only track these statuses
  }

  const lastActivity = task.lastActivityAt || task.createdAt;
  const now = Date.now();
  const timeSinceActivity = now - lastActivity;

  const threshold = STALL_THRESHOLDS[task.status as keyof typeof STALL_THRESHOLDS];
  if (!threshold) return 'active';

  if (timeSinceActivity > threshold) return 'stalled';
  if (timeSinceActivity > IDLE_THRESHOLD) return 'idle';
  return 'active';
}

export function getActivityStatusDisplay(status: TaskActivityStatus): { icon: string; label: string; color: string } {
  const displays = {
    active: { icon: '🟢', label: 'Active', color: 'text-green-600' },
    idle: { icon: '⏸️', label: 'Idle', color: 'text-amber-600' },
    stalled: { icon: '⚠️', label: 'Stalled', color: 'text-red-600' },
  };
  return displays[status];
}

// --- Search and Filter Helpers ---

/**
 * Search tasks by title, description, ticket number, or any other field
 * Returns matching tasks (excludes archived by default)
 */
export function searchTasks(query: string, includeArchived = false): Task[] {
  const q = query.toLowerCase().trim();
  if (!q) return _tasks.filter(t => !t.isArchived || includeArchived);

  return _tasks.filter(t => {
    // Skip archived unless explicitly requested
    if (!includeArchived && t.isArchived) return false;

    // Search by ticket number
    if (t.ticketNumber && t.ticketNumber.toString() === q) return true;
    if (t.ticketNumber && t.ticketNumber.toString().includes(q)) return true;

    // Search by title
    if (t.title.toLowerCase().includes(q)) return true;

    // Search by description
    if (t.description?.toLowerCase().includes(q)) return true;

    // Search by project name (need to join with projects)
    // This is best-effort as we can't access project names from this function

    // Search by assignee
    if (t.assignee.toLowerCase().includes(q)) return true;

    // Search by status
    if (t.status.toLowerCase().includes(q)) return true;

    return false;
  });
}

/**
 * Get all archived tasks
 */
export function getArchivedTasks(): Task[] {
  return _tasks.filter(t => t.isArchived);
}

/**
 * Get non-archived tasks (active board tasks)
 */
export function getActiveTasks(): Task[] {
  return _tasks.filter(t => !t.isArchived);
}

/**
 * Archive a task (instead of deleting)
 */
export async function archiveTask(id: string, by?: string): Promise<void> {
  await mutateStore('deleteTask', { id, by: by || 'unknown' });
  _tasks = _tasks.map(t => t.id === id
    ? { ...t, isArchived: true, archivedAt: Date.now(), archivedBy: by || 'unknown' }
    : t
  );
}

/**
 * Unarchive a task
 */
export async function unarchiveTask(id: string): Promise<void> {
  await mutateStore('unarchiveTask', { id });
  _tasks = _tasks.map(t => t.id === id
    ? { ...t, isArchived: false, archivedAt: undefined, archivedBy: undefined }
    : t
  );
}

/**
 * Permanently delete a task (skip archive)
 */
export async function permanentlyDeleteTask(id: string): Promise<void> {
  await mutateStore('permanentlyDeleteTask', { id });
  _tasks = _tasks.filter(t => t.id !== id);
}

/**
 * Extract @mentions from a comment string (e.g., "@Alex", "@Riley")
 * Returns array of mentioned agent names
 */
export function extractMentions(content: string): string[] {
  const regex = /@(\w+)/g;
  const matches = content.match(regex);
  return matches ? matches.map(m => m.slice(1)) : [];
}
