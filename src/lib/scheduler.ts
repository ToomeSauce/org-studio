/**
 * Scheduler helpers — prompt builder for agent work loops
 */
import { AgentLoop } from '@/lib/store';
import type { PromptSection } from '@/lib/store';
import { getStoreProvider } from './store-provider';

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
  planning    → Humans are scoping/speccing this task. DO NOT touch. Not ready for agents.
  backlog     → Ready for an agent to pick up. This is YOUR intake queue.
  in-progress → Actively being worked. Resume these first.
  qa          → QA validation in progress. Test assignee is running the test plan. If you're the test assignee, follow the test plan.
  review      → Work is done but needs human eyes. Move here when you're not 100% confident.
  done        → Complete and verified. No further action needed.`,
    enabled: true,
    order: 20,
    builtIn: true,
  },
  {
    id: 'review-guidance',
    label: 'Review Guidance',
    content: `WHEN TO USE "review" vs "done":
  → done:    Task is self-contained AND you can verify it yourself (tests pass, build clean, output matches spec).
  → review:  Task touches shared code, involves subjective quality, changes user-facing behavior,
             or you're not fully confident in the result. When in doubt, use review.

REVIEW NOTES — when moving a task to "review" or "done", ALWAYS write a reviewNotes summary:
  curl -s http://localhost:4501/api/store -X POST -H "Content-Type: application/json" \\
    -d '{"action":"updateTask","id":"<id>","updates":{"status":"review","reviewNotes":"<summary>"}}'

  The reviewNotes field should include:
  - What was completed
  - What was NOT completed (and why)
  - Any blockers or follow-ups needed
  This is how the human knows what happened without reading code diffs.

COMMENTS — use task comments to communicate about a task:
  - When you encounter something noteworthy while working, leave a comment explaining what you found
  - When a task is sent back to you (moved from review/done back to in-progress), check the comments for feedback
  - When you have questions about a task, post a comment instead of guessing

TESTING — every task must be tested before moving out of in-progress:
  Every task has a testType field: "self" (default) or "qa".

  SELF TEST (testType = "self"):
  → Before moving to review/done, you MUST:
    1. Write a test plan in the testPlan field (what you'll verify and how)
    2. Execute the test plan yourself (curl endpoints, check build, verify DB, etc.)
    3. Document results in reviewNotes (what passed, what failed, what you verified)
  → Then move to review or done.
  → If you skip self-testing, QA will bounce it back.

  QA TEST (testType = "qa"):
  → Before moving out of in-progress, you MUST:
    1. Self-test first (same as above — curl, build, basic sanity checks)
    2. Write a test plan describing end-user verification steps
    3. Move the task to "qa" column (NOT review — move directly to qa)
  → QA agent picks it up and runs the user-facing test plan
  → If QA finds basic failures (500 errors, broken builds), they'll bounce it back — self-test better.

  IF testPlan IS EMPTY when you try to move to review/done/qa:
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
     - If "self" (default): self-test (write test plan, execute it, document results in reviewNotes), then move to review/done.
     - If "qa": self-test first, write a test plan for end-user verification, then move to "qa" column (NOT review).
  4. When a task is complete:
     - If testPlan is empty, write one first — no exceptions.
     - Then move to "done", "review", or "qa" per the testType rules above.
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

NEVER pull from "planning" — humans own that column. Those tasks are not ready.`,
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

  Create new task (always to "backlog"):
    curl -s http://localhost:4501/api/store -X POST -H "Content-Type: application/json" \\
      -d '{"action":"addTask","task":{"title":"<title>","projectId":"<project-id>","status":"backlog","assignee":"\${agentName}"}}'

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
- NEVER pull tasks from "planning" — humans own that column.
- When you see opportunities to improve your domain, create new tasks and work them.
- Clear your activity status when all work is done.
- Every task must be tested. Check testType: "self" = self-test and document; "qa" = self-test then move to qa column.
- When writing a test plan, cover the acceptance criteria: what to verify, what actions to take, expected results.`,
    enabled: true,
    order: 60,
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
  planning    → Humans are scoping/speccing this task. DO NOT touch. Not ready for agents.
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

NEVER pull from "planning" — humans own that column. Those tasks are not ready.`,
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

  Create new task (always to "backlog"):
    curl -s http://localhost:4501/api/store -X POST -H "Content-Type: application/json" \\
      -d '{"action":"addTask","task":{"title":"<title>","projectId":"<project-id>","status":"backlog","assignee":"\${agentName}"}}'

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
- NEVER pull tasks from "planning" — humans own that column.`,
    enabled: true,
    order: 60,
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
function interpolate(text: string, agentName: string, agentId: string): string {
  return text.replace(/\$\{agentName\}/g, agentName).replace(/\$\{agentId\}/g, agentId);
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
  // Find actionable tasks for this agent
  const nameLower = agentName.toLowerCase();
  const agentTasks = (store.tasks || []).filter((t: any) => {
    const assignee = (t.assignee || '').toLowerCase();
    return (assignee === nameLower || assignee === agentId) && !t.isArchived;
  });

  const inProgress = agentTasks.filter((t: any) => t.status === 'in-progress');
  const backlog = agentTasks.filter((t: any) => t.status === 'backlog');
  const inQA = agentTasks.filter((t: any) => t.status === 'qa');

  // Nothing to do
  if (inProgress.length === 0 && backlog.length === 0 && inQA.length === 0) {
    return null;
  }

  // Find the project for context
  const projects = store.projects || [];

  // Build focused message
  const lines: string[] = [];
  lines.push(`📋 **Task Dispatch — ${agentName}**`);
  lines.push('');

  // Priority 1: Resume in-progress work
  if (inProgress.length > 0) {
    lines.push(`**Resume in-progress (${inProgress.length}):**`);
    for (const t of inProgress) {
      const proj = projects.find((p: any) => p.id === t.projectId);
      lines.push(`- **${t.title}** ${t.ticketNumber ? `(#${t.ticketNumber})` : ''}`);
      if (proj) lines.push(` Project: ${proj.name}${t.version ? ` v${t.version}` : ''}`);
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
    if (proj) lines.push(` Project: ${proj.name}${next.version ? ` v${next.version}` : ''}`);
    if (next.description) lines.push(` Description: ${next.description.substring(0, 300)}`);
    if (next.doneWhen) lines.push(` Done when: ${next.doneWhen}`);
    if (next.constraints) lines.push(` Constraints: ${next.constraints}`);
    if (next.testPlan) lines.push(` Test plan: ${next.testPlan}`);
    lines.push(` (+${backlog.length - 1} more in backlog)`);
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

  // Instructions (minimal — agent's ORG.md has the full workflow)
  const apiKey = process.env.ORG_STUDIO_API_KEY || '';
  lines.push('**Instructions:**');
  lines.push('1. Read your ORG.md for current context and workflow');
  lines.push('2. **Work the tasks listed above — do NOT create new tasks.** Your backlog is pre-populated.');
  lines.push('3. Move task to in-progress when you start:');
  lines.push(` \`curl -s http://localhost:4501/api/store -X POST -H "Content-Type: application/json" -H "Authorization: Bearer ${apiKey}" -d '{"action":"updateTask","id":"<task-id>","updates":{"status":"in-progress"}}'\``);
  lines.push('4. Use sub-agents for heavy work (coding, testing, builds)');
  lines.push('5. **Post progress comments** as you work — decisions made, blockers hit, approaches taken, key findings:');
  lines.push(` \`curl -s http://localhost:4501/api/store -X POST -H "Content-Type: application/json" -H "Authorization: Bearer ${apiKey}" -d '{"action":"addComment","taskId":"<task-id>","comment":{"author":"<your-name>","content":"<update>","type":"comment"}}'\``);
  lines.push('   Post at least one comment per task (e.g. "Scaffolded Next.js 16 with Tailwind — chose App Router over Pages for RSC support")');
  lines.push('6. **When done, you MUST update task status.** This triggers the next task. If you skip this, the pipeline stops.');
  lines.push('   Include a **verification checklist** in reviewNotes showing what you tested. Use ✅/❌/⏭️:');
  lines.push('   Example reviewNotes: "Built hero section with logo + tagline + CTA buttons.\\n\\nVerification:\\n✅ Component renders in light and dark mode\\n✅ Build passes (zero TS errors)\\n✅ Responsive at 375px, 768px, 1440px\\n❌ Lighthouse a11y — no browser available\\n⏭️ E2E test — deferred to QA"');
  lines.push(` \`curl -s http://localhost:4501/api/store -X POST -H "Content-Type: application/json" -H "Authorization: Bearer ${apiKey}" -d '{"action":"updateTask","id":"<task-id>","updates":{"status":"done","reviewNotes":"<summary + verification checklist>"}}'\``);
  lines.push('7. After updating status, the next task dispatches automatically. Do NOT pull multiple tasks at once.');
  lines.push('8. Do NOT ask the user for permission to continue or present "Next Task" buttons. Just work, update, and stop. The system handles chaining.');

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

  const sectionText = enabledSections
    .map(s => interpolate(s.content, agentName, loop.agentId))
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
