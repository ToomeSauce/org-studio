/**
 * Scheduler helpers — prompt builder for agent work loops
 */
import { AgentLoop } from '@/lib/store';
import type { PromptSection } from '@/lib/store';
import { getStoreProvider } from './store-provider';
import { agentOwnedSections, agentHasTaskAccess, isDefaultMainSection } from './section-access';
import { isVersionInHorizon } from './version-utils';

// Re-export for convenience
export type { PromptSection };

/**
 * Default prompt sections — these match the original hardcoded prompt exactly.
 * Content uses ${agentName} and ${agentId} placeholders for interpolation.
 */
export const DEFAULT_SECTIONS: PromptSection[] = [
  {
    id: 'task-management',
    label: 'Task Management',
    content: `TASK MANAGEMENT:
- Fetch tasks: curl -s http://localhost:4501/api/store | parse JSON, filter tasks where assignee matches your name
- Tasks at the top of a column have higher priority (lower sortOrder = higher priority)`,
    enabled: true,
    order: 10,
    builtIn: true,
  },
  {
    id: 'column-workflow',
    label: 'Column Workflow',
    content: `COLUMN WORKFLOW — understand what each column means:
  planning    → Tasks being scoped/specced. Both humans AND agents can add/refine tasks here. **You are encouraged to pull tasks from planning, scope them out (acceptance criteria, constraints, context), and move them to backlog when ready for execution.** When in doubt about scope, post a comment asking instead of guessing.
  backlog     → Ready for an agent to pick up. This is YOUR intake queue.
  in-progress → Actively being worked. Resume these first.
  qa          → QA validation in progress. Test assignee is running the test plan. If you're the test assignee, follow the test plan.
  review      → Work is done but needs human review. OPT-IN ONLY — see review guidance below.
  done        → Complete and verified. DEFAULT destination for finished work.

DEFAULT AGENT PATH: backlog → in-progress → done.
Review is opt-in. Ship directly to done for reversible work in your owned domain.`,
    enabled: true,
    order: 20,
    builtIn: true,
  },
  {
    id: 'review-guidance',
    label: 'Review Guidance',
    content: `WHEN TO USE "review" (opt-in — use ONLY when mandatory):
  → done (DEFAULT): Task is in your owned domain AND the changes are reversible (can be reverted via git revert, config rollback, or similar). Ship it.
  → review (OPT-IN): Use ONLY when:
    (a) Irreversible changes — DB migrations, deletions, money/billing, external API writes with cost
    (b) Cross-domain changes — touching another agent's owned code/section
    (c) Mission/vision/roadmap direction changes
    (d) Security-sensitive changes
    When in doubt about reversibility, use review.

SELF-FLAGGING: At task start (or mid-work if scope changes), decide if the task needs review.
  If yes: set needsReview=true and reviewReason="<why>" via updateTask.
  If needsReview is true, move to "review" instead of "done" when complete.
  If needsReview is false or unset, move directly to "done".

REVIEW NOTES — REQUIRED when moving to "review". NOT required for direct-to-done:
  When moving to review, include reviewNotes explaining what was done, what wasn't, and why review is needed.
  For direct-to-done: the commit message + final task comment is the record. No ceremony.

COMMENTS — use task comments to communicate about a task:
  - When you encounter something noteworthy while working, leave a comment explaining what you found
  - When a task is sent back to you (moved from review/done back to in-progress), check the comments for feedback
  - When you have questions about a task, post a comment instead of guessing

TESTING — every task must be tested before moving out of in-progress:
  Every task has a testType field: "self" (default) or "qa".

  SELF TEST (testType = "self"):
  → Before moving to done, you MUST:
    1. Write a test plan in the testPlan field (what you'll verify and how)
    2. Execute the test plan yourself (curl endpoints, check build, verify DB, etc.)
    3. Document results in a task comment or reviewNotes (what passed, what failed, what you verified)
  → Then move to done (or review if needsReview=true).

  QA TEST (testType = "qa"):
  → Before moving out of in-progress, you MUST:
    1. Self-test first (same as above — curl, build, basic sanity checks)
    2. Write a test plan describing end-user verification steps
    3. Move the task to "qa" column (NOT review — move directly to qa)
  → QA agent picks it up and runs the user-facing test plan
  → If QA finds basic failures (500 errors, broken builds), they'll bounce it back — self-test better.

  IF testPlan IS EMPTY when you try to move to done/review/qa:
  → Write one first. No exceptions.`,
    enabled: true,
    order: 30,
    builtIn: true,
  },
  {
    id: 'work-loop',
    label: 'Work Loop',
    content: `WORK LOOP — repeat until all your assigned work is done:
  1. Scan "in-progress" for tasks assigned to you. Pick the highest priority one and continue working on it.
  2. If nothing is in-progress, scan "backlog" for assigned tasks. Pick the highest priority one.
     - Read the full task description and any comments FIRST.
     - Only move it to "in-progress" AFTER you have started actual work (opened a file, ran a command, made a change).
     - Do NOT move to "in-progress" just to claim it. The status must reflect reality — if you haven't started working, leave it in backlog.
  3. Before moving any task out of in-progress: check testType.
     - If "self" (default): self-test (write test plan, execute it, document results in a comment or reviewNotes), then move to done (or review if needsReview=true).
     - If "qa": self-test first, write a test plan for end-user verification, then move to "qa" column (NOT review).
  4. When a task is complete:
     - If testPlan is empty, write one first — no exceptions.
     - Default: move to "done" directly. Use "review" ONLY if needsReview=true.
     Then go back to step 1.
  5. Repeat until there are NO remaining tasks assigned to you in "in-progress" or "backlog".
  6. If you discover new work, improvements, or follow-up tasks in your domain while working, create them in "backlog" and continue working through the queue.
  7. When all assigned work is done, report idle, clear your activity status, and end.
  8. If you run out of time mid-task, leave it in whatever column it's actually in. Do NOT move to "in-progress" on the way out — the next loop will pick it up.

STRUCTURED TASK EXECUTION — when a task has acceptance criteria (## Done When):
  - Check EACH criterion before marking the task complete. If any criterion is not met, keep working.
  - If the task is too large for one session, decompose it into sub-tasks in "backlog" and complete them individually.
  - Create follow-up tasks for anything you discover along the way that needs attention.
  - Only move the parent task to "done" or "review" when ALL exit criteria are satisfied.

TEST PLAN — every task has a testPlan field:
  - Write a test plan before marking the task as done or moving to qa.
  - For self-test tasks: describe what you verified and how.
  - For QA tasks: describe end-user verification steps for the QA reviewer.
  - Leave the testPlan intact — don't delete or modify it after writing.

PLANNING COLUMN — you can both add tasks to planning AND pull tasks from it. When you discover work that needs scoping, drop it in planning. When you find a planning task in your domain that needs scoping, scope it out (acceptance criteria, constraints, context) and move it to backlog when ready for execution. If a planning task lacks enough context to scope, post a comment asking before moving forward.`,
    enabled: true,
    order: 40,
    builtIn: true,
  },
  {
    id: 'api-reference',
    label: 'API Reference',
    content: `API REFERENCE:
  Fetch tasks:
    curl -s http://localhost:4501/api/store | parse JSON → .tasks[]

  Create new follow-up/adhoc task (always to "backlog"):
    curl -s http://localhost:4501/api/store -X POST -H "Content-Type: application/json" \\
      -d '{"action":"addTask","task":{"title":"<title>","projectId":"<project-id>","status":"backlog","assignee":"\${agentName}","taskType":"followup"}}'
    IMPORTANT: When creating follow-up tasks, always set taskType='followup' (or 'bug', 'chore', 'spike'). Never set version.
    When creating roadmap tasks, use the vision page flow — do not call addTask directly with version set. The API will reject it.

  Update task status:
    curl -s http://localhost:4501/api/store -X POST -H "Content-Type: application/json" \\
      -d '{"action":"updateTask","id":"<id>","updates":{"status":"<new-status>"}}'

  Add comment to task (for questions, updates, or when reopening):
    curl -s http://localhost:4501/api/store -X POST -H "Content-Type: application/json" \\
      -d '{"action":"addComment","taskId":"<id>","comment":{"author":"\${agentName}","content":"<message>","type":"comment"}}'
    Use type "comment" for normal messages. Use type "system" for automated status changes.
    Comments are visible in the task detail panel — use them to communicate with the team about a task.

  Handoff note (when you resolve a blocker for another agent's task):
    curl -s http://localhost:4501/api/store -X POST -H "Content-Type: application/json" \\
      -d '{"action":"addHandoff","taskId":"<id>","author":"\${agentName}","message":"<context for the assignee>"}'    
    This injects your message directly into the assignee's NEXT scheduler loop prompt.
    Use this instead of a regular comment when you've fixed something and the assignee needs to know what changed.
    The handoff is consumed once (auto-cleared after delivery).

  Report activity (update while working, clear when done):
    curl -s http://localhost:4501/api/activity-status -X POST -H "Content-Type: application/json" \\
      -d '{"agent":"\${agentId}","status":"<status>","detail":"<detail>"}'
    curl -s http://localhost:4501/api/activity-status -X DELETE -H "Content-Type: application/json" \\
      -d '{"agent":"\${agentId}"}'`,
    enabled: true,
    order: 50,
    builtIn: true,
  },
  {
    id: 'rules',
    label: 'Rules',
    content: `RULES:
- Only work tasks in YOUR domain. Read ORG.md for scope.
- If blocked on a task, note the blocker, skip it, and move to the next.
- NEVER touch main/master branches on shared repos. Staging only.
- You CAN pull tasks from "planning" — scope them out (acceptance criteria, constraints, context), then move them to backlog when ready for execution. Encouraged, not just allowed.
- When you see opportunities to improve your domain, create new tasks and work them.
- Clear your activity status when all work is done.
- Every task must be tested. Check testType: "self" = self-test and document; "qa" = self-test then move to qa column.
- DEFAULT path: backlog → in-progress → done. Ship directly to done for reversible work in your owned domain.
- Use "review" ONLY for: irreversible changes, cross-domain work, mission/vision changes, or security-sensitive changes. Set needsReview=true when starting such tasks.
- When writing a test plan, cover the acceptance criteria: what to verify, what actions to take, expected results.`,
    enabled: true,
    order: 60,
    builtIn: true,
  },
  {
    id: 'sections-awareness',
    label: 'Sections Awareness',
    content: `SECTIONS — projects are split into sections you may own:
- Tasks assigned to you are ALWAYS visible regardless of section.
- By default, focus on tasks in sections you own or where you've been @mentioned.
- You CAN still read all tasks via the API — isolation is a focus aid, not a permission boundary.
- Cross-section handoffs (devHandoff) stay fully visible.`,
    enabled: true,
    order: 65,
    builtIn: true,
  },
  {
    id: 'exit-protocol',
    label: 'Exit Protocol',
    content: `WHEN DONE — before ending, do these two things:
1. Write a brief summary of what you accomplished to your daily memory file:
   File: memory/$(date +%Y-%m-%d).md (in your workspace directory)
   Append a section like:
     ## Scheduler Loop — HH:MM
     - Worked on: [task title]
     - What I did: [1-2 sentence summary]
     - Status: [done / in-progress / blocked]
     - New tasks created: [list or "none"]
   This ensures continuity between loop runs and interactive sessions.
2. Return a brief plain-text summary of what you did. This will be delivered to the team.`,
    enabled: true,
    order: 70,
    builtIn: true,
  },
  {
    id: 'idle-handling',
    label: 'Idle Handling',
    content: `IF IDLE — if you have NO tasks in backlog or in-progress:
- Do NOT write to memory (nothing happened).
- Return ONLY the text: HEARTBEAT_OK
- Do NOT say "no tasks found" or "nothing to do" or any other idle message.
- HEARTBEAT_OK tells the system you ran successfully but had nothing to report. It will NOT be delivered to anyone.`,
    enabled: true,
    order: 80,
    builtIn: true,
  },
  {
    id: 'direct-messages',
    label: 'Recent mentions & DMs',
    content: `RECENT MENTIONS & DMs — your inbox (last 24h):
\${dmInbox}

If you were @mentioned in a task, board, or section comment, the notification was delivered to your session in real time.
Check above for any mention notifications you may have received.

To reply to a DM:
  curl -s http://localhost:4501/api/store -X POST -H "Content-Type: application/json" \\
    -H "Authorization: Bearer YOUR_ORG_STUDIO_API_KEY" \\
    -d '{"action":"addComment","scope":{"kind":"dm","dmThreadId":"<thread-id>"},"comment":{"author":"\${agentName}","content":"your reply","type":"comment"}}'`,
    enabled: true,
    order: 85,
    builtIn: true,
  },
];

/**
 * QA-specific prompt sections — used when a teammate has role: "qa".
 * Emphasizes scanning the QA column, executing test plans, and bounce-back rules.
 */
export const QA_SECTIONS: PromptSection[] = [
  {
    id: 'task-management',
    label: 'Task Management',
    content: `TASK MANAGEMENT:
- Fetch tasks: curl -s http://localhost:4501/api/store | parse JSON
- Primary focus: tasks in the "qa" column where testAssignee matches your name (or you are the team's default QA agent)
- Secondary: tasks in "in-progress" or "backlog" assigned to you
- Tasks at the top of a column have higher priority (lower sortOrder = higher priority)`,
    enabled: true,
    order: 10,
    builtIn: true,
  },
  {
    id: 'column-workflow',
    label: 'Column Workflow',
    content: `COLUMN WORKFLOW — understand what each column means:
  planning    → Tasks being scoped. Humans AND agents can add/refine tasks here. You can pull planning tasks, scope them out, and move them to backlog when ready for execution.
  backlog     → Ready for an agent to pick up.
  backlog     → Ready for an agent to pick up.
  in-progress → Actively being worked by a dev.
  qa          → ** YOUR PRIMARY COLUMN ** — Tasks here need QA validation. This is where you do your main work.
  review      → Work is done and needs human eyes.
  done        → Complete and verified. No further action needed.`,
    enabled: true,
    order: 20,
    builtIn: true,
  },
  {
    id: 'review-guidance',
    label: 'QA Review Guidance',
    content: `QA REVIEW GUIDANCE:

BOUNCE-BACK RULE — before running the test plan, do a basic sanity check:
  - Can the feature be reached? (no 404s, no 500s)
  - Does the build compile? (no build failures)
  - Are the expected endpoints/pages present?
  If basic stuff is broken, do NOT waste time on the full test plan. Instead:
  1. Move the task back to "in-progress"
  2. Add a comment: "Dev self-test incomplete — [what's broken]"
  3. Alert the dev (mention their name in the comment)

TEST PLAN EXECUTION:
  1. Read the task's testPlan field
  2. Execute each test case step by step
  3. Document results: ✅ for pass, ❌ for fail, per test case
  4. Include specific details for failures (URL, error message, expected vs actual)

IF testPlan IS EMPTY:
  - Add a comment asking the dev to write a test plan
  - Skip the task — move on to the next one
  - Do NOT invent your own test plan

PASS → move to "done" or "review" with reviewNotes summarizing what was tested and results
FAIL → leave in "qa", add a comment with:
  - Which test cases failed
  - Reproduction steps
  - Severity (critical / major / minor)
  - Alert the dev by name in the comment

REVIEW NOTES — when moving a task to "review" or "done", ALWAYS write a reviewNotes summary:
  curl -s http://localhost:4501/api/store -X POST -H "Content-Type: application/json" \\
    -d '{"action":"updateTask","id":"<id>","updates":{"status":"review","reviewNotes":"<summary>"}}'`,
    enabled: true,
    order: 30,
    builtIn: true,
  },
  {
    id: 'work-loop',
    label: 'QA Work Loop',
    content: `QA WORK LOOP — repeat until all your QA work is done:
  1. Scan "qa" column for tasks where testAssignee matches your name (or you're the default QA agent).
     Pick the highest priority one.
  2. If nothing in qa, scan "in-progress" for tasks assigned to you. Pick the highest priority one.
  3. If nothing in in-progress, scan "backlog" for tasks assigned to you. Pick the highest priority one.
  4. For each task:
     a. Read the full task description, comments, and testPlan.
     b. Run the basic sanity check (bounce-back rule).
     c. If sanity check passes, execute the test plan step by step.
     d. Document results and move the task appropriately (done/review on pass, leave in qa on fail).
  5. Go back to step 1.
  6. When all work is done, clear your activity status and end.
  7. If you run out of time mid-task, leave it in whatever column it's actually in.

PLANNING COLUMN — you can both add QA-related tasks to planning AND pull tasks from it. Scope out planning tasks with clear test acceptance criteria, then move them to backlog when ready for an agent to execute. If a planning task lacks enough context to scope, post a comment asking instead of guessing.`,
    enabled: true,
    order: 40,
    builtIn: true,
  },
  {
    id: 'api-reference',
    label: 'API Reference',
    content: `API REFERENCE:
  Fetch tasks:
    curl -s http://localhost:4501/api/store | parse JSON → .tasks[]

  Create new follow-up/adhoc task (always to "backlog"):
    curl -s http://localhost:4501/api/store -X POST -H "Content-Type: application/json" \\
      -d '{"action":"addTask","task":{"title":"<title>","projectId":"<project-id>","status":"backlog","assignee":"\${agentName}","taskType":"followup"}}'
    IMPORTANT: When creating follow-up tasks, always set taskType='followup' (or 'bug', 'chore', 'spike'). Never set version.
    When creating roadmap tasks, use the vision page flow — do not call addTask directly with version set. The API will reject it.

  Update task status:
    curl -s http://localhost:4501/api/store -X POST -H "Content-Type: application/json" \\
      -d '{"action":"updateTask","id":"<id>","updates":{"status":"<new-status>"}}'

  Add comment to task (for questions, updates, or when reopening):
    curl -s http://localhost:4501/api/store -X POST -H "Content-Type: application/json" \\
      -d '{"action":"addComment","taskId":"<id>","comment":{"author":"\${agentName}","content":"<message>","type":"comment"}}'
    Use type "comment" for normal messages. Use type "system" for automated status changes.
    Comments are visible in the task detail panel — use them to communicate with the team about a task.

  Handoff note (when you resolve a blocker for another agent's task):
    curl -s http://localhost:4501/api/store -X POST -H "Content-Type: application/json" \\
      -d '{"action":"addHandoff","taskId":"<id>","author":"\${agentName}","message":"<context for the assignee>"}'    
    This injects your message directly into the assignee's NEXT scheduler loop prompt.
    Use this instead of a regular comment when you've fixed something and the assignee needs to know what changed.
    The handoff is consumed once (auto-cleared after delivery).

  Report activity (update while working, clear when done):
    curl -s http://localhost:4501/api/activity-status -X POST -H "Content-Type: application/json" \\
      -d '{"agent":"\${agentId}","status":"<status>","detail":"<detail>"}'
    curl -s http://localhost:4501/api/activity-status -X DELETE -H "Content-Type: application/json" \\
      -d '{"agent":"\${agentId}"}'`,
    enabled: true,
    order: 50,
    builtIn: true,
  },
  {
    id: 'rules',
    label: 'QA Rules',
    content: `RULES:
- Your primary job is QA — always check the qa column first.
- Do NOT modify code. You are a tester, not a fixer. Report issues, don't fix them.
- Be specific in failure reports: include URLs, error messages, reproduction steps, expected vs actual behavior.
- If a task's testPlan is empty, add a comment asking the dev to write one and skip the task.
- Only work tasks in YOUR domain (testing/QA). Read ORG.md for scope.
- If blocked on a task, note the blocker as a comment, skip it, and move to the next.
- Clear your activity status when all work is done.
- You CAN pull tasks from "planning" — scope them out (acceptance criteria, constraints, context), then move them to backlog when ready for execution. Encouraged, not just allowed.`,
    enabled: true,
    order: 60,
    builtIn: true,
  },
  {
    id: 'sections-awareness',
    label: 'Sections Awareness',
    content: `SECTIONS — projects are split into sections you may own:
- Tasks assigned to you are ALWAYS visible regardless of section.
- By default, focus on tasks in sections you own or where you've been @mentioned.
- You CAN still read all tasks via the API — isolation is a focus aid, not a permission boundary.
- Cross-section handoffs (devHandoff) stay fully visible.`,
    enabled: true,
    order: 65,
    builtIn: true,
  },
  {
    id: 'exit-protocol',
    label: 'Exit Protocol',
    content: `WHEN DONE — before ending, do these two things:
1. Write a brief summary of what you accomplished to your daily memory file:
   File: memory/$(date +%Y-%m-%d).md (in your workspace directory)
   Append a section like:
     ## Scheduler Loop — HH:MM
     - Worked on: [task title]
     - What I did: [1-2 sentence summary]
     - Status: [done / in-progress / blocked]
     - New tasks created: [list or "none"]
   This ensures continuity between loop runs and interactive sessions.
2. Return a brief plain-text summary of what you did. This will be delivered to the team.`,
    enabled: true,
    order: 70,
    builtIn: true,
  },
  {
    id: 'idle-handling',
    label: 'Idle Handling',
    content: `IF IDLE — if you have NO tasks in qa, in-progress, or backlog:
- Do NOT write to memory (nothing happened).
- Return ONLY the text: HEARTBEAT_OK
- Do NOT say "no tasks found" or "nothing to do" or any other idle message.
- HEARTBEAT_OK tells the system you ran successfully but had nothing to report. It will NOT be delivered to anyone.`,
    enabled: true,
    order: 80,
    builtIn: true,
  },
];

/**
 * Interpolate ${agentName} and ${agentId} placeholders in a string.
 */
function interpolate(text: string, agentName: string, agentId: string, extras?: Record<string, string>): string {
  let result = text.replace(/\$\{agentName\}/g, agentName).replace(/\$\{agentId\}/g, agentId);
  if (extras) {
    for (const [key, value] of Object.entries(extras)) {
      result = result.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), value);
    }
  }
  return result;
}

/**
 * Get the effective prompt sections for a given loop.
 * If role is "qa", starts from QA_SECTIONS instead of DEFAULT_SECTIONS.
 * If the loop has custom promptSections, merge with the base (custom overrides by id).
 * Otherwise, return a copy of the base sections.
 */
export function getEffectiveSections(loop: AgentLoop, role?: string): PromptSection[] {
  const baseSections = role === 'qa' ? QA_SECTIONS : DEFAULT_SECTIONS;

  if (!loop.promptSections || loop.promptSections.length === 0) {
    return baseSections.map(s => ({ ...s }));
  }

  // Start from base, then overlay loop customizations by id
  const sectionMap = new Map<string, PromptSection>();
  for (const s of baseSections) {
    sectionMap.set(s.id, { ...s });
  }
  for (const s of loop.promptSections) {
    sectionMap.set(s.id, { ...s });
  }

  return Array.from(sectionMap.values());
}

/**
 * Read pending handoff notes for an agent from the store.
 * Returns formatted handoff blocks and the task IDs that have them (for cleanup).
 */
async function getPendingHandoffs(agentId: string, agentName: string): Promise<{ text: string; taskIds: string[] }> {
  try {
    const store = await getStoreProvider().read();
    const tasks = store.tasks || [];
    const nameLower = agentName.toLowerCase();
    const blocks: string[] = [];
    const taskIds: string[] = [];

    for (const t of tasks) {
      if (!t.devHandoff) continue;
      const assignee = (t.assignee || '').toLowerCase();
      if (assignee !== nameLower && assignee !== agentId) continue;

      blocks.push(
        `⚡ CONTEXT INJECTION — "${t.title}" (#${t.ticketNumber || '?'})\n` +
        `From: ${t.devHandoff.author}\n` +
        `---\n` +
        `${t.devHandoff.message}\n` +
        `---\n` +
        `This information was injected by a teammate to help you with this task. Read it carefully before proceeding.`
      );
      taskIds.push(t.id);
    }

    return { text: blocks.join('\n\n'), taskIds };
  } catch {
    return { text: '', taskIds: [] };
  }
}

/**
 * Fetch recent DMs for an agent (last 24h, up to 5 messages).
 * Returns formatted text for injection into the scheduler prompt.
 * TODO: Add proper unread tracking. For now, "recent" = last 24h.
 */
async function getRecentDmInbox(agentId: string, agentName: string): Promise<string> {
  try {
    const provider = getStoreProvider();
    if (typeof (provider as any).listDmThreads !== 'function') {
      return '(No DM threads available with current storage provider)';
    }

    const threads: any[] = await (provider as any).listDmThreads();
    if (!threads || threads.length === 0) return '(No recent DMs)';

    // Filter threads where this agent is a participant
    const nameLower = agentName.toLowerCase();
    const idLower = agentId.toLowerCase();
    const agentThreads = threads.filter((t: any) => {
      const participants = t.participantIds || [];
      return participants.some((p: string) =>
        p.toLowerCase() === nameLower || p.toLowerCase() === idLower
      );
    });

    if (agentThreads.length === 0) return '(No recent DMs)';

    // Only include threads with messages in the last 24h
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const recentThreads = agentThreads.filter((t: any) => t.lastCommentAt > cutoff).slice(0, 5);

    if (recentThreads.length === 0) return '(No DMs in the last 24h)';

    const lines: string[] = [];
    for (const t of recentThreads) {
      const otherParticipant = (t.participantIds || []).find((p: string) =>
        p.toLowerCase() !== nameLower && p.toLowerCase() !== idLower
      ) || 'unknown';
      const preview = (t.lastCommentPreview || '').slice(0, 80);
      const author = t.lastCommentAuthor || 'unknown';
      lines.push(`- From ${author} (thread with ${otherParticipant}): "${preview}"  [thread: ${t.threadId}]`);
    }
    return lines.join('\n');
  } catch {
    return '(Error fetching DM inbox)';
  }
}

/**
 * Clear consumed handoffs from the store (called after prompt is built).
 */
export async function clearConsumedHandoffs(taskIds: string[]): Promise<void> {
  if (taskIds.length === 0) return;
  try {
    const store = await getStoreProvider().read();
    let changed = false;
    for (const t of store.tasks) {
      if (taskIds.includes(t.id) && t.devHandoff) {
        delete t.devHandoff;
        changed = true;
      }
    }
    if (changed) {
      await getStoreProvider().write(store);
    }
  } catch (e) {
    console.warn('clearConsumedHandoffs error:', e);
  }
}

/**
 * Build a focused dispatch message for an agent's main persistent session.
 * Unlike buildLoopPrompt (which includes all workflow instructions),
 * this is a concise task assignment that assumes the agent already
 * knows how to work (from their ORG.md, which includes the full workflow).
 * 
 * Called by the event-driven dispatcher when tasks land in backlog or when manually triggered.
 */
export async function buildDispatchMessage(
  store: any,
  agentId: string,
  agentName: string,
  agentRole?: string,
): Promise<string | null> {
  // #1100: Status taxonomy for dispatch — ALWAYS allowlist, never negation.
  //   ACTIONABLE  = buckets we build a dispatch prompt for (work IS ready)
  //   VISIBLE_ONLY = shown for awareness, NOT dispatched (external blocker / awaiting review)
  //   IGNORED     = not shown at all ('done', 'planning', unknown statuses)
  //
  // Never filter via `status !== 'done'` — new statuses silently become
  // actionable any time someone adds one to the schema. Always allowlist.
  const ACTIONABLE_STATUSES = new Set(['in-progress', 'backlog', 'qa']);
  const VISIBLE_ONLY_STATUSES = new Set(['blocked', 'review']);

  // Find tasks assigned to this agent (all non-archived — bucketed by status below)
  const nameLower = agentName.toLowerCase();
  const agentTasks = (store.tasks || []).filter((t: any) => {
    const assignee = (t.assignee || '').toLowerCase();
    return (assignee === nameLower || assignee === agentId) && !t.isArchived;
  });

  const inProgress = agentTasks.filter((t: any) => t.status === 'in-progress');
  const blocked = agentTasks.filter((t: any) => t.status === 'blocked');

  // Approval horizon + project-state filter for backlog only. In-progress and QA tasks keep going —
  // they were already approved when the agent picked them up. Only NEW work pulls
  // need to respect the current approval horizon and project run-state.
  const backlog = agentTasks.filter((t: any) => {
    if (t.status !== 'backlog') return false;
    // Project state gate: stopped projects don't dispatch new work
    if (t.projectId) {
      const proj = (store.projects || []).find((p: any) => p.id === t.projectId);
      if (proj?.state === 'stopped') return false;
    }
    if (!t.projectId || !t.version) return true; // no version → not version-gated
    const proj = (store.projects || []).find((p: any) => p.id === t.projectId);
    const approvedThrough = proj?.autonomy?.approvedThrough;
    if (!approvedThrough) return false; // no horizon set → hold off on all backlog
    return isVersionInHorizon(t.version, approvedThrough);
  });
  const inQA = agentTasks.filter((t: any) => t.status === 'qa');

  // Nothing ACTIONABLE to do — don't dispatch even if blocked tasks exist.
  // (Blocked tasks are visible-only; dispatching with nothing actionable would
  // produce a noisy "here's what's blocked" with nothing the agent can act on.)
  if (inProgress.length === 0 && backlog.length === 0 && inQA.length === 0) {
    return null;
  }

  // Runtime sanity: catch accidental status-bucket drift. If a new bucket is
  // added above but not added to ACTIONABLE_STATUSES/VISIBLE_ONLY_STATUSES,
  // this warning fires in dev. Cheap insurance.
  for (const t of agentTasks) {
    const s = t.status;
    if (!ACTIONABLE_STATUSES.has(s) && !VISIBLE_ONLY_STATUSES.has(s) && s !== 'done' && s !== 'planning') {
      console.warn(`[buildDispatchMessage] unknown status '${s}' on task ${t.id} — not bucketed`);
    }
  }

  // Find the project for context
  const projects = store.projects || [];

  // Build focused message
  const lines: string[] = [];
  lines.push(`📋 **Task Dispatch — ${agentName}**`);
  lines.push('');

  // Show owned sections (if any)
  const owned = agentOwnedSections(projects, agentName);
  if (owned.length > 0) {
    const sectionList = owned.map(o => `${o.project.name} → ${o.section.name}`).join(', ');
    lines.push(`**Your sections:** ${sectionList}`);
    lines.push('');
  }

  // Priority 1: Resume in-progress work
  if (inProgress.length > 0) {
    lines.push(`**Resume in-progress (${inProgress.length}):**`);
    for (const t of inProgress) {
      const proj = projects.find((p: any) => p.id === t.projectId);
      lines.push(`- **${t.title}** ${t.ticketNumber ? `(#${t.ticketNumber})` : ''}`);
      if (proj) lines.push(` Project: ${proj.name}${t.version ? ` ${t.version}` : ''}`);
      if (t.sectionId && proj && !isDefaultMainSection(t.sectionId, proj.id)) {
        const sec = (proj.sections || []).find((s: any) => s.id === t.sectionId);
        if (sec) lines.push(` Section: ${sec.name}`);
      }
      if (t.description) lines.push(` Description: ${t.description.substring(0, 200)}`);
      if (t.doneWhen) lines.push(` Done when: ${t.doneWhen}`);
      if (t.constraints) lines.push(` Constraints: ${t.constraints}`);
      if (t.testPlan) lines.push(` Test plan: ${t.testPlan}`);
    }
    lines.push('');
  }

  // Priority 2: QA tasks (if agent has QA role)
  if (inQA.length > 0 && agentRole === 'qa') {
    lines.push(`**QA tasks waiting (${inQA.length}):**`);
    for (const t of inQA) {
      const proj = projects.find((p: any) => p.id === t.projectId);
      lines.push(`- **${t.title}** ${t.ticketNumber ? `(#${t.ticketNumber})` : ''}`);
      if (proj) lines.push(` Project: ${proj.name}`);
      if (t.sectionId && proj && !isDefaultMainSection(t.sectionId, proj.id)) {
        const sec = (proj.sections || []).find((s: any) => s.id === t.sectionId);
        if (sec) lines.push(` Section: ${sec.name}`);
      }
      if (t.testPlan) lines.push(` Test plan: ${t.testPlan}`);
    }
    lines.push('');
  }

  // Priority 3: Backlog (pull next)
  if (backlog.length > 0 && inProgress.length === 0) {
    // Only show backlog if nothing is in-progress
    const next = backlog[0]; // Top of backlog = highest priority
    const proj = projects.find((p: any) => p.id === next.projectId);
    lines.push(`**Next from backlog:**`);
    lines.push(`- **${next.title}** ${next.ticketNumber ? `(#${next.ticketNumber})` : ''}`);
    if (proj) lines.push(` Project: ${proj.name}${next.version ? ` ${next.version}` : ''}`);
    if (next.sectionId && proj && !isDefaultMainSection(next.sectionId, proj.id)) {
      const sec = (proj.sections || []).find((s: any) => s.id === next.sectionId);
      if (sec) lines.push(` Section: ${sec.name}`);
    }
    if (next.description) lines.push(` Description: ${next.description.substring(0, 300)}`);
    if (next.doneWhen) lines.push(` Done when: ${next.doneWhen}`);
    if (next.constraints) lines.push(` Constraints: ${next.constraints}`);
    if (next.testPlan) lines.push(` Test plan: ${next.testPlan}`);
    lines.push(` (+${backlog.length - 1} more in backlog)`);
    lines.push('');
  }

  // #1100: Blocked tasks — visibility only. These are NOT part of the dispatch
  // work queue. Showing them here prevents agents from independently pulling
  // their own task list, seeing blocked tickets, and trying to work them.
  if (blocked.length > 0) {
    lines.push(`**🚫 Blocked (${blocked.length}) — do NOT work these; waiting on external unblock:**`);
    for (const t of blocked) {
      const proj = projects.find((p: any) => p.id === t.projectId);
      const projLabel = proj ? ` [${proj.name}]` : '';
      lines.push(`- #${t.ticketNumber ?? '?'} ${t.title}${projLabel}`);
    }
    lines.push('');
  }

  // Check for handoffs (context injections from other agents)
  const handoffTaskIds: string[] = [];
  const handoffLines: string[] = [];
  for (const t of [...inProgress, ...backlog.slice(0, 1)]) {
    if (t.devHandoff) {
      handoffLines.push(`🔧 **Handoff for "${t.title}":** ${t.devHandoff.message}`);
      handoffTaskIds.push(t.id);
    }
  }
  if (handoffLines.length > 0) {
    lines.push('**Handoffs from team:**');
    lines.push(...handoffLines);
    lines.push('');
  }

  // Store handoff task IDs for cleanup
  (buildDispatchMessage as any)._lastHandoffTaskIds = handoffTaskIds;

  // Instructions — kept minimal. Full workflow lives in the org-studio-api skill.
  lines.push('**Instructions:**');
  lines.push('1. Read your ORG.md for current context and the `org-studio-api` skill for the full work contract.');
  lines.push('2. **Work the tasks listed above — do NOT create new tasks.** Your backlog is pre-populated.');
  lines.push('3. Move task to in-progress, post progress comments, and update status to done when finished (see skill for curl examples).');
  lines.push('4. After updating status, the next task dispatches automatically. Do NOT pull multiple tasks at once.');
  lines.push('5. Do NOT ask the user for permission to continue or present "Next Task" buttons. Just work, update, and stop.');
  lines.push('6. **Blocked tasks are not yours to work.** They are shown for awareness only — wait for unblock, or post a comment if you can help remove the blocker.');

  return lines.join('\n');
}

/**
 * Build the agent prompt from a loop's enabled steps.
 * Supports global preamble (prepended to all loops) and per-loop system prompt override.
 * If role is "qa", QA-specific prompt sections are used instead of defaults.
 * When includeHandoffs is true, includes any pending devHandoff context injections.
 */
export async function buildLoopPrompt(
  loop: AgentLoop,
  agentName: string,
  globalPreamble?: string,
  role?: string,
  includeHandoffs?: boolean,
): Promise<string> {
  const parts: string[] = [];

  // Global preamble — always prepended if provided
  if (globalPreamble?.trim()) {
    parts.push(globalPreamble.trim());
    parts.push('');
  }

  parts.push(`SCHEDULER_LOOP: autonomous work cycle for ${agentName}`);
  parts.push('');

  // Context injections — devHandoff notes from teammates (only for one-shot/triggered runs)
  if (includeHandoffs) {
    const { text: handoffText, taskIds: handoffTaskIds } = await getPendingHandoffs(loop.agentId, agentName);
    if (handoffText) {
      parts.push('════════════════════════════════════════');
      parts.push('IMPORTANT — READ BEFORE STARTING WORK:');
      parts.push('════════════════════════════════════════');
      parts.push('');
      parts.push(handoffText);
      parts.push('');
      parts.push('════════════════════════════════════════');
      parts.push('');
    }

    // Store handoff task IDs for cleanup by the caller
    (buildLoopPrompt as any)._lastHandoffTaskIds = handoffTaskIds;
  } else {
    (buildLoopPrompt as any)._lastHandoffTaskIds = [];
  }

  if (loop.systemPrompt?.trim()) {
    // Per-loop system prompt override — replaces the default steps section
    parts.push(loop.systemPrompt.trim());
  } else {
    // Default: build from enabled steps
    const enabledSteps = loop.steps.filter(s => s.enabled);

    let stepLines = '';
    enabledSteps.forEach((step, i) => {
      stepLines += `${i + 1}. [${step.type}] ${step.description}\n`;
      if (step.instruction) {
        stepLines += `   Instructions: ${step.instruction}\n`;
      }
    });

    parts.push('You are running an automated work loop. Follow these steps in order:');
    parts.push('');
    parts.push(stepLines.trimEnd());
  }

  parts.push('');

  // Build prompt sections
  const sections = getEffectiveSections(loop, role);
  const enabledSections = sections
    .filter(s => s.enabled)
    .sort((a, b) => a.order - b.order);

  // Fetch DM inbox for the direct-messages section (conditional on whether section is enabled)
  const hasDmSection = enabledSections.some(s => s.id === 'direct-messages');
  let dmInbox = '';
  if (hasDmSection) {
    dmInbox = await getRecentDmInbox(loop.agentId, agentName);
  }

  const extras: Record<string, string> = {};
  if (dmInbox) extras.dmInbox = dmInbox;

  const sectionText = enabledSections
    .map(s => interpolate(s.content, agentName, loop.agentId, extras))
    .join('\n\n');

  parts.push(sectionText);

  // Add execution model guidance (for sub-agents and heavy work)
  parts.push('');
  parts.push('════════════════════════════════════════');
  parts.push('EXECUTION MODEL');
  parts.push('════════════════════════════════════════');
  parts.push('');
  parts.push('- For quick tasks (move a card, post a comment, read a doc): do it inline');
  parts.push('- For coding/building tasks (npm install, multi-file changes, testing): spawn a sub-agent with adequate timeout');
  parts.push('- Use sessions_spawn with mode="run" and runTimeoutSeconds=600 (or more for large tasks)');
  parts.push('- The sub-agent inherits your workspace');
  parts.push('- Never let a task time out mid-work. If it\'s too big for this session, spawn a sub-agent.');

  return parts.join('\n');
}
