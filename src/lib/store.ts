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

// === Components (#1112 Arc — PR 1) ===
//
// `Component` is the evolved form of `Section`. Same shape, plus two new
// capabilities: a descriptive `role` hint and structured inter-component
// dependencies (`waitsFor`).
//
// Design locks (from the arc ticket #1112):
//  - `role` is DESCRIPTIVE free text. Never an enum. Schedulers never branch
//    on it. Behavior comes from the agent's skills + per-component context.
//  - `waitsFor` references project versions, not component versions. Components
//    inherit the project's version cycle.
//  - No ACLs, no permissions, no component-level lifecycle. Keep it minimal.
//
// `Section` is retained as a runtime-compatible alias (see below) until every
// call site has migrated. PR 1 is additive only — nothing in the code base
// reads `components` yet. PRs 2–4 wire the downstream consumers.
export interface Component {
  id: string;
  name: string;              // "Frontend", "Backend", "QA", "Auth Service"
  owner: string;             // agent name (free text, matches teammate name)
  role?: string;             // DESCRIPTIVE free text: "dev" | "qa" | "security" | "docs" | ...
                             // Schedulers MUST NOT branch on this — it's UI + humans only.
  outcomes: string;          // free text — what this component exists to deliver
  contract: string;          // free text — what it gives to / expects from other components
  // Versioned inter-component dependencies (same project or cross-project).
  // When all tasks for the referenced component at the referenced version reach
  // `done`, our component's tasks that were blocked waiting on this entry can be
  // auto-unblocked (mechanism lands in PR 2, not this PR).
  waitsFor?: Array<{
    componentId: string;       // component id we're waiting on
    projectId?: string;        // optional — if different project. Defaults to same project.
    version: string;           // the project version of the target component we're waiting on
  }>;
  archivedAt?: number;
  archivedBy?: string;
}

// `sections` and `Section` remain the on-disk primitive throughout PR 1 so
// existing readers/writers don't change. `components`, when populated, is an
// additive secondary shape. PR 3 flips the UI to read `components` with
// fallback to `sections`. PR 4+ migrates stores. After all call sites are
// migrated, we remove the `sections` path entirely.

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
  // #1351 — multi-repo support. Projects with frontend+backend or multiple
  // services list every repo here. The single `repoUrl` above is kept for
  // backward compat and treated as the first entry when `repoUrls` is unset.
  // Each entry is "owner/repo" form (no protocol, no https://github.com prefix).
  repoUrls?: string[];
  // #1690 — compact precomputed checkout map injected into execution-worker
  // briefs. Stored in Postgres `data` JSONB overflow (no migration).
  repoContextPack?: string;             // UTF-8 markdown, max 4KB
  repoContextPackGeneratedAt?: number;  // epoch ms; brief warns after 30 days
  lifecycle?: 'building' | 'mature' | 'bau' | 'sunset';
  visionOwner?: string;         // Human who approves version plans
  devOwner?: string;            // Agent/human who does dev work
  qaOwner?: string;             // Agent/human who runs QA
  currentVersion?: string;      // e.g. "0.3"
  dependsOn?: string[];         // Project IDs this vision depends on
  state?: 'active' | 'inactive' | 'started' | 'stopped';
  // ^ #1185: rename 'started'→'active', 'stopped'→'inactive'. Old literals kept
  //   in the type during transition; migration script normalizes data; reads
  //   go through isProjectRunning() / normalizeProjectState() helpers.

  autonomy?: {
    // enabled: boolean — REMOVED (dead field, replaced by project.state)
    cadence?: 'daily' | 'weekly' | 'biweekly' | 'monthly'; // @deprecated - replaced by approvalMode
    approvalMode?: 'per-version' | 'per-major';
    lastProposedAt?: number;
    lastApprovedAt?: number;
    lastLaunchedAt?: number;
    pendingVersion?: string;
    cronJobId?: string; // @deprecated - replaced by Launch model
  };

  // #1652 Phase A-1 — per-project autonomy budget + boundaries.
  // Persisted via JSONB overflow (`data`) — no migration required.
  budget?: {
    ceilingUsdMonth?: number;
    ceilingUsdVersion?: number;
    // Alert threshold percent for budget warnings.
    // Default 80 is applied by read/update validation helpers when absent.
    alertPct?: number;
  };
  boundaries?: {
    freeToDecide: string[];
    mustAsk: string[];
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

  // --- Components (#1112 Arc — PR 1, additive) ---
  // Evolved form of `sections`. See `Component` interface above. PR 1 is
  // additive: if `components` is populated, readers may prefer it; if not,
  // existing `sections` continues to work. PR 3 flips UI defaults. PR 4+
  // migrates stores and removes the `sections` path.
  components?: Component[];

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
  type?: 'comment' | 'system' | 'stop' | 'resume'; // system = auto-generated (reopened, reassigned, etc.); stop/resume = #1492 lease-guard STOP markers
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
  testType?: 'self' | 'qa';   // DEPRECATED post-#862: tasks route by assignee only. Field retained for historical tasks.
  testAssignee?: string;       // DEPRECATED post-#862: QA-component owner uses standard assignee field. Retained for history.
  reviewNotes?: string;   // Completion notes — written when moving to done. (Field name is legacy from when there was a Review column; it now serves as completion notes for done tasks. #1290.)
  outcomeIds?: string[];  // Which outcomes this task serves
  isArchived?: boolean;   // Archive flag — tasks are archived instead of deleted
  archivedAt?: number;    // When task was archived
  archivedBy?: string;    // Who archived it
  status: 'planning' | 'backlog' | 'in-progress' | 'done' | 'blocked';
  projectId: string;
  assignee: string;
  // priority field removed (#1249, 2026-05-06). Ordering is via sortOrder /
  // column position; see #1250 for the user-facing drag-and-drop UI. The DB
  // column `priority` is intentionally retained as deprecated until a follow-up
  // migration drops it.
  sectionId?: string;     // Section within the project this task belongs to
  version?: string;       // Version field (e.g., "0.902") — set when vision cycle creates the task
  sortOrder?: number;
  createdAt: number;
  lastActivityAt?: number;  // Track last comment, status change, or field update (for stall detection)
  loopCount?: number;       // Scheduler loops on this task at same status (resets on status change)
  loopPausedAt?: number;    // Timestamp when loop was paused due to stall detection
  loopPauseReason?: string; // Why the loop was paused
  blockedReason?: string;   // Why the task is blocked (required when status='blocked' — see #1138 follow-up)
  // #1588 — Blocked Gate. Structured classification of WHY a task is blocked,
  // so the system can distinguish a legitimate block from an abdication.
  //   irreversible-decision : genuinely needs a human (DDL drop, billing, irreversible)
  //   external-dependency   : waiting on a third party / deploy / external event
  //   needs-human-judgment  : a real judgment call only the human owner should make
  //   awaiting-review       : ABDICATION type — a PR/work the OWNER was told to do
  //                           themselves. The gate auto-bounces these back to the
  //                           owner instead of accepting the block.
  // Required (in addition to blockedReason) when transitioning to 'blocked'
  // UNLESS blockedBy[] is set (a dependency block — case-a — passes untouched).
  blockedReasonType?: 'irreversible-decision' | 'external-dependency' | 'needs-human-judgment' | 'awaiting-review';

  // #1689 — modelTier tagging substrate. Optional complexity tag used by
  // future model routing (P-4). Absent = unrouted; dispatch behaves exactly
  // as today. Validated in addTask/updateTask via src/lib/model-tier.ts.
  // Persists via the `data` JSONB overflow (no column, no migration).
  modelTier?: 'trivial' | 'standard' | 'complex' | null;
  // #1691 — planner jobs are feature tasks whose deliverable is board data,
  // not code. Chunk provenance fields also live in JSONB overflow. Generated
  // chunks share the source task's canonical roadmapItemId/version; the
  // roadmap item's taskId remains anchored to the plan task.
  jobKind?: 'code' | 'plan';
  parentId?: string;
  plannerChunkKey?: string;
  plannerSourceTaskId?: string;

  // #1589 Domain Steward — last time the active-stewardship sweep nudged the
  // owner about this ticket. Idempotency stamp (no duplicate nudges within
  // NUDGE_COOLDOWN_MS). Persists via the `data` JSONB overflow (no column).
  lastStewardNudgeAt?: number | null;

  // #1352 — Claim contract (60-min heartbeat lease).
  // When an agent transitions a task INTO in-progress, claim_started_at is
  // stamped and claim_lease_expires_at = claim_started_at + 60min. Every
  // activity that bumps lastActivityAt (comments, updateTask field writes,
  // explicit heartbeatClaim action) extends claim_lease_expires_at to
  // now + 60min idempotently. On transition OUT of in-progress (done /
  // blocked / backlog), both fields are cleared. Scheduler tick reads
  // these to detect stale claims and auto-bounce. Soft contract: lease
  // expiry alone never blocks anything; the bounce decision also requires
  // "assignee active on other tasks" or escalation triggers.
  // 60min window is the Basil-confirmed middle ground — agent-friendly
  // enough that real work won't trip it, conservative enough to catch
  // dead claims within an hour rather than half a day.
  claim_started_at?: number;
  claim_lease_expires_at?: number;
  // #1254 — Project-scope opt-in for blocked tasks that legitimately have
  // no component (cross-cutting milestones, launches, exit gates). When
  // true, the orphan-blocked callout on ProjectDashboardPage skips this
  // task. Has no effect when sectionId/roadmapItemId/parentId are set —
  // those already disqualify the task from the callout.
  projectScoped?: boolean;
  // #1192 — "blocked on whom?". Lowercase agent name(s) or 'basil' for the
  // human owner. Drives the home Blockers section: only tickets where this
  // includes the user's name surface on the home page. Empty/null = blocked
  // on something external (deploy, third party) and not on a specific person.
  awaitingResponseFrom?: string | string[];
  // #1192 — convenience flag. true = needs Basil's input/decision. Equivalent
  // to awaitingResponseFrom: 'basil'. Either field surfaces on the home view.
  needsUserResponse?: boolean;
  inFlightRunId?: string;   // Subagent runId working on this task (observable, not enforced)
  /** @deprecated #1290 (2026-05-08): Review column removed. Field kept on the type for legacy data; agents should not set it on new tasks. Use status='blocked' + blockedReason for irreversible/security-sensitive work. */
  needsReview?: boolean;
  /** @deprecated #1290 (2026-05-08): see needsReview above. */
  reviewReason?: string;
  devHandoff?: {            // Context injection: dev attaches notes when resolving a blocker
    message: string;          // The context/instructions for the agent
    author: string;           // Who wrote it
    createdAt: number;        // When it was written
  };
  taskType?: 'feature' | 'bug' | 'chore' | 'spike' | 'followup';
  roadmapItemId?: string;  // links roadmap tasks back to their RoadmapItem (items[].id). Presence = roadmap task.
  // #1102: structured blocker graph. Ticket numbers this task is blocked by.
  // When ALL listed tickets reach status=done, the task is auto-flipped back to backlog
  // and the assignee's loop is triggered. Empty/null = manual-unblock-only (external blocker).
  blockedBy?: number[];
  // #1102: audit trail of blockers that triggered an auto-unblock. Preserved across unblocks
  // for history. Never read by the dispatcher — purely observability.
  previouslyBlockedBy?: number[];
  comments?: TaskComment[];
  // #1293 phase 1 — server adds this to every task in the GET /api/store
  // snapshot. Source of truth: SUM of dual-written normalized + inline; we
  // currently take length of the inline blob, which matches normalized
  // counts byte-for-byte after the #1288 backfill. UI card badges read this
  // instead of comments?.length once the inline blob is stripped on the wire.
  // Optional because the in-memory store builder keeps the field absent
  // until the server stamps it (e.g. optimistic local creates).
  commentCount?: number;
  statusHistory?: { status: string; timestamp: number; by?: string; model?: string }[];

  // #1351 — Repo-truth grounding. Populated on addTask / updateTask by the
  // fuzzy matcher when create-time content scores above threshold against
  // recent merged PRs (linked repos, last 90d) or done tasks (last 90d).
  // Best-effort: empty / undefined means "no matches found OR matcher
  // unavailable", not "definitively no duplicates". Persisted via the
  // JSONB overflow column (no migration). Rendered as a banner in
  // TaskDetailPanel (slice 3).
  possibly_already_shipped?: Array<{
    type: 'pr' | 'task';
    id: string;        // PR: "owner/repo#123"; task: ticketNumber as string
    title: string;     // PR/task title at match time
    score: number;     // 0..1, tuned threshold (see gh-pr-cache.ts)
    url?: string;      // PR HTML url for one-click open
    mergedAt?: number; // ms epoch (PRs only)
    matchedAt: number; // when this match was recorded
  }>;

  // #1351 — First-class duplicate-of pointer. When set, both tickets
  // cross-link in the UI and the duplicate inherits the canonical ticket's
  // status semantically (no auto-status-mirroring; humans / agents flip
  // status explicitly and reference this field for audit). Ticket number
  // form (e.g. 1342) for human-friendly cross-reference.
  duplicate_of?: number;
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
  if (!resp.ok) {
    // #1260: read the server's {error: "…"} body so callers can show a real
    // message instead of a silent dead button. Falls back to status code if
    // the body isn't JSON / has no error field.
    let serverMessage = '';
    try {
      const body = await resp.clone().json();
      if (body && typeof body.error === 'string' && body.error.trim()) {
        serverMessage = body.error.trim();
      }
    } catch {
      try {
        const text = await resp.text();
        if (text && text.trim()) serverMessage = text.trim().slice(0, 500);
      } catch {
        // ignore — fall through to generic message below
      }
    }
    const msg = serverMessage
      ? `${serverMessage} (HTTP ${resp.status})`
      : `Store mutation failed: ${resp.status}`;
    console.warn('[store:mutateStore] failure', { action, status: resp.status, serverMessage });
    throw new Error(msg);
  }
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
  // Update local cache. #1293 phase 1: bump commentCount alongside the inline
  // optimistic blob so card badges update instantly. Inline blob retained for
  // local-only fallback paths and the TaskDetailPanel — the panel itself now
  // pulls from listComments on open, but bumping inline keeps the optimistic
  // "new comment visible" path working until the panel refetches.
  _tasks = _tasks.map(t => t.id === taskId
    ? { ...t, comments: [...(t.comments || []), result.comment], commentCount: ((t as any).commentCount ?? (t.comments?.length || 0)) + 1 }
    : t);
  return result.comment;
}

// === Section mutators ===
// #1112 PR 3: dual-write — keep both `sections[]` and `components[]` in sync
// in the local cache so the new Components panel reads fresh data immediately.
export async function addSection(projectId: string, section: Omit<Section, 'id'> & { id?: string }): Promise<Section> {
  const result = await mutateStore('addSection', { projectId, section });
  // Update local cache — dual-write sections + components
  _projects = _projects.map(p => {
    if (p.id !== projectId) return p;
    const updated: Partial<Project> = { sections: [...(p.sections || []), result.section] };
    // Mirror into components[] so the new UI sees it immediately
    updated.components = [...(p.components || []), result.section as Component];
    return { ...p, ...updated };
  });
  return result.section;
}

export async function updateSection(projectId: string, sectionId: string, updates: Partial<Section>): Promise<void> {
  await mutateStore('updateSection', { projectId, sectionId, updates });
  _projects = _projects.map(p => {
    if (p.id !== projectId) return p;
    return {
      ...p,
      sections: (p.sections || []).map(s => s.id === sectionId ? { ...s, ...updates } : s),
      components: (p.components || []).map(c => c.id === sectionId ? { ...c, ...updates } : c),
    };
  });
}

export async function deleteSection(projectId: string, sectionId: string): Promise<void> {
  await mutateStore('deleteSection', { projectId, sectionId });
  _projects = _projects.map(p => {
    if (p.id !== projectId) return p;
    return {
      ...p,
      sections: (p.sections || []).filter(s => s.id !== sectionId),
      components: (p.components || []).filter(c => c.id !== sectionId),
    };
  });
}

export async function reorderSections(projectId: string, sectionIds: string[]): Promise<void> {
  await mutateStore('reorderSections', { projectId, sectionIds });
  _projects = _projects.map(p => {
    if (p.id !== projectId) return p;
    const sMap = new Map((p.sections || []).map(s => [s.id, s]));
    const ordered = sectionIds.filter(id => sMap.has(id)).map(id => sMap.get(id)!);
    const rest = (p.sections || []).filter(s => !sectionIds.includes(s.id));
    // Mirror reorder to components[]
    const cMap = new Map((p.components || []).map(c => [c.id, c]));
    const cOrdered = sectionIds.filter(id => cMap.has(id)).map(id => cMap.get(id)!);
    const cRest = (p.components || []).filter(c => !sectionIds.includes(c.id));
    return { ...p, sections: [...ordered, ...rest], components: [...cOrdered, ...cRest] };
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

// #1290 (2026-05-08): 'review' status removed from the type union. Stall
// threshold for review kept here only for historical statusHistory entries
// that still carry status='review' — unreachable for new tasks.
const STALL_THRESHOLDS = {
  'in-progress': 4 * 60 * 60 * 1000,  // 4 hours for in-progress
};

const IDLE_THRESHOLD = 2 * 60 * 60 * 1000;  // 2 hours = idle, 4+ = stalled

export function getTaskActivityStatus(task: Task): TaskActivityStatus {
  // #1290: 'review' is gone; only 'in-progress' is tracked for activity.
  if (task.status !== 'in-progress') {
    return 'active';
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
  const regex = /(?<![\w.])@(\w+)/g;
  const matches = content.match(regex);
  return matches ? matches.map(m => m.slice(1)) : [];
}
