/**
 * Scheduler helpers — prompt builder for agent work loops.
 *
 * TODO(#1387 A.3): scheduler is currently cross-workspace by construction
 * (uses getStoreProviderAllWorkspaces()). Split into per-workspace ticks so
 * each workspace's loops/teammates run isolated with their own provider.
 */
import { AgentLoop } from '@/lib/store';
import type { PromptSection } from '@/lib/store';
import { getStoreProviderAllWorkspaces } from "./store-provider";
import { agentOwnedSections, agentHasTaskAccess, isDefaultMainSection } from './section-access';
import { getEligibleBacklogFifo } from './dispatch-gate';

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
  done        → Complete and verified. DEFAULT destination for finished work.
  blocked     → Cannot proceed without external input. Two cases: (a) waiting on a teammate/dependency/another task, OR (b) awaiting human sign-off on irreversible/security-sensitive work. See Blocked & Sign-off Guidance.

DEFAULT AGENT PATH: backlog → in-progress → done.
Do NOT use a "review" status — it was removed (#1290, 2026-05-08). The board has 4 columns. Ship reversible work to done; use blocked + reason for the rare irreversible case.`,
    enabled: true,
    order: 20,
    builtIn: true,
  },
  {
    id: 'review-guidance',
    label: 'Blocked & Sign-off Guidance',
    content: `WHEN TO USE "blocked" (the only non-default destination):

The board has 4 columns: planning → backlog → in-progress → done. There is no Review column (#1290 — killed 2026-05-08 because it kept getting misused as a generic sanity-check shelf).

DEFAULT: When work is complete, move it to "done". You own your domain — ship reversible work without a human checkpoint. The revert button is the safety net.

USE "blocked" in exactly these cases:
  (a) Cannot proceed without external input — waiting on a teammate, dependency, or another task to finish first. Use blockedBy=[<ticket-numbers>] to declare the structured edge for auto-unblock.
  (b) Awaiting human sign-off on irreversible or security-sensitive work — DB schema migrations, data deletions, money/billing changes, paid external API writes, auth changes, secrets, public-endpoint exposure, public launch toggles. Set blockedReason: "awaiting human sign-off — <why irreversible>" and post a comment summarizing what's been staged for review.

That's it. "Want a teammate to look at it" is NOT a reason to block — ship to done and @-ping in a comment if you want eyes.

SELF-CHECK before marking blocked-for-signoff: "If this is wrong, can I revert with git revert <sha> and one redeploy?" Yes → done. No → blocked + reason.

COMPLETION NOTES — when moving a task to "done", write reviewNotes summarizing what shipped (commit SHA, BUILD_ID, what was verified). The field is still called reviewNotes for backward compat — don't be confused, write completion notes there.

COMMENTS — use task comments to communicate about a task:
  - When you encounter something noteworthy while working, leave a comment explaining what you found
  - When a task is sent back to you (moved from done back to in-progress), check the comments for feedback
  - When you have questions about a task, post a comment instead of guessing

TESTING — every task must be tested before moving out of in-progress:
  Every task has a testType field: "self" (default) or "qa".

  SELF TEST (testType = "self"):
  → Before moving to done, you MUST:
    1. Write a test plan in the testPlan field (what you'll verify and how)
    2. Execute the test plan yourself (curl endpoints, check build, verify DB, etc.)
    3. Document results in a task comment or reviewNotes (what passed, what failed, what you verified)
  → Then move to done. (Or to blocked + reason if it needs human sign-off; see above.)

  QA TEST (testType = "qa"):
  → Before moving out of in-progress, you MUST:
    1. Self-test first (same as above — curl, build, basic sanity checks)
    2. Write a test plan describing end-user verification steps
    3. Move the task to "qa" column
  → QA agent picks it up and runs the user-facing test plan
  → If QA finds basic failures (500 errors, broken builds), they'll bounce it back — self-test better.

  IF testPlan IS EMPTY when you try to move to done/qa/blocked:
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
  2. SINGLE-WIP RULE — you may have AT MOST ONE task in-progress at a time. If you already have one or more in-progress, do NOT pull from backlog. Resume the highest-priority in-progress task and finish it (or bounce it back to backlog with a clear comment) before claiming anything new. If you find yourself with multiple in-progress tickets, that is a drift state — pick the one you'll actually finish now, move the rest back to backlog with a one-line comment explaining you're focusing.
  3. If nothing is in-progress, scan "backlog" for assigned tasks. Pick the highest priority one.
     - Read the full task description and any comments FIRST.
     - Only move it to "in-progress" AFTER you have started actual work (opened a file, ran a command, made a change).
     - Do NOT move to "in-progress" just to claim it. The status must reflect reality — if you haven't started working, leave it in backlog.
  4. Before moving any task out of in-progress: check testType.
     - If "self" (default): self-test (write test plan, execute it, document results in a comment or reviewNotes), then move to done. (Use blocked + reason if irreversible/security-sensitive and needs human sign-off; see Blocked & Sign-off Guidance.)
     - If "qa": self-test first, write a test plan for end-user verification, then move to "qa" column.
  5. When a task is complete:
     - If testPlan is empty, write one first — no exceptions.
     - Default: move to "done" directly. Use "blocked" + blockedReason ONLY for irreversible/security-sensitive work needing human sign-off (rare).
     Then go back to step 1.
  6. Repeat until there are NO remaining tasks assigned to you in "in-progress" or "backlog".
  7. If you discover new work, improvements, or follow-up tasks in your domain while working, create them in "backlog" and continue working through the queue.
  8. When all assigned work is done, report idle, clear your activity status, and end.
  9. If you run out of time mid-task, leave it in whatever column it's actually in. Do NOT move to "in-progress" on the way out — the next loop will pick it up.

STRUCTURED TASK EXECUTION — when a task has acceptance criteria (## Done When):
  - Check EACH criterion before marking the task complete. If any criterion is not met, keep working.
  - If the task is too large for one session, decompose it into sub-tasks in "backlog" and complete them individually.
  - Create follow-up tasks for anything you discover along the way that needs attention.
  - Only move the parent task to "done" when ALL exit criteria are satisfied. (Use "blocked" + reason if it's irreversible/security-sensitive and needs human sign-off.)

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
      -H "Authorization: Bearer \${ORG_STUDIO_API_KEY}" \\
      -d '{"agent":"\${agentId}","status":"<status>","detail":"<detail>"}'
    curl -s http://localhost:4501/api/activity-status -X DELETE -H "Content-Type: application/json" \\
      -H "Authorization: Bearer \${ORG_STUDIO_API_KEY}" \\
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
- Use "blocked" + blockedReason ONLY for: irreversible changes needing human sign-off, security-sensitive changes, or work waiting on external input. Default destination for finished work is "done".
- When writing a test plan, cover the acceptance criteria: what to verify, what actions to take, expected results.`,
    enabled: true,
    order: 60,
    builtIn: true,
  },
  {
    id: 'blocker-protocol',
    label: 'Blocker Protocol',
    content: `BLOCKER PROTOCOL — when you move a task to "blocked", you MUST tag who's blocking it.

Why: the home page only surfaces blockers that need the human owner's input. If you don't tag the blocker, your blocked ticket is invisible to the people who could unblock it.

When moving to blocked, set ONE of these on the task:
  - awaitingResponseFrom: "<name>"   → use lowercase agent or human name (e.g. "basil", "trevor", "ana")
  - awaitingResponseFrom: ["<a>", "<b>"]   → array form when multiple parties
  - needsUserResponse: true          → shorthand for "needs the human owner" (currently Basil)

ALSO ALWAYS set blockedReason — a one-line description of what's blocking it.

Example (curl):
  curl -s http://localhost:4501/api/store -X POST -H "Content-Type: application/json" \\
    -d '{"action":"updateTask","id":"<id>","updates":{"status":"blocked","blockedReason":"frontend bundle still buggy after deploy","awaitingResponseFrom":"trevor"}}'

Rules of thumb for who to name:
  - QA-failed something to a dev to fix          → awaitingResponseFrom: "<dev>"
  - Need a product/scope decision from the owner → needsUserResponse: true
  - Waiting on a deploy / external service       → leave both unset, set blockedReason explaining what's external
  - Blocked on another ticket finishing          → use blockedBy: [<ticket numbers>] instead (auto-unblocks when those go done)

Unblocking: when posting a comment that unblocks the task, also clear awaitingResponseFrom (or flip needsUserResponse to false) and either move the task back to backlog/in-progress yourself or use addHandoff so the assignee picks it up next loop.`,
    enabled: true,
    order: 62,
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
  in-progress → Actively being worked by a dev.
  qa          → ** YOUR PRIMARY COLUMN ** — Tasks here need QA validation. This is where you do your main work.
  done        → Complete and verified. No further action needed.
  blocked     → Cannot proceed without external input (dependency or human sign-off). #1290 — review column was removed; do NOT use 'review' status anymore.`,
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

PASS → move to "done" with reviewNotes summarizing what was tested and results (do NOT use "review" — column removed in #1290)
FAIL → leave in "qa", add a comment with:
  - Which test cases failed
  - Reproduction steps
  - Severity (critical / major / minor)
  - Alert the dev by name in the comment

COMPLETION NOTES — when moving a task to "done", ALWAYS write a reviewNotes summary (field name is legacy from when there was a Review column; it now serves as completion notes):
  curl -s http://localhost:4501/api/store -X POST -H "Content-Type: application/json" \\
    -d '{"action":"updateTask","id":"<id>","updates":{"status":"done","reviewNotes":"<summary>"}}'`,
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
  2. SINGLE-WIP RULE — you may have AT MOST ONE task in-progress at a time. If you already have one or more in-progress, do NOT pull a new task from qa or backlog. Resume your existing in-progress work first, or bounce it back with a clear comment before claiming new work. If you find yourself with multiple in-progress tickets, pick the one you'll actually finish now and move the rest back to backlog with a one-line focus comment.
  3. If nothing in qa, scan "in-progress" for tasks assigned to you. Pick the highest priority one.
  4. If nothing in in-progress, scan "backlog" for tasks assigned to you. Pick the highest priority one.
  5. For each task:
     a. Read the full task description, comments, and testPlan.
     b. Run the basic sanity check (bounce-back rule).
     c. If sanity check passes, execute the test plan step by step.
     d. Document results and move the task appropriately (done on pass, leave in qa on fail).
  6. Go back to step 1.
  7. When all work is done, clear your activity status and end.
  8. If you run out of time mid-task, leave it in whatever column it's actually in.

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
      -H "Authorization: Bearer \${ORG_STUDIO_API_KEY}" \\
      -d '{"agent":"\${agentId}","status":"<status>","detail":"<detail>"}'
    curl -s http://localhost:4501/api/activity-status -X DELETE -H "Content-Type: application/json" \\
      -H "Authorization: Bearer \${ORG_STUDIO_API_KEY}" \\
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
    id: 'blocker-protocol',
    label: 'Blocker Protocol',
    content: `BLOCKER PROTOCOL — when you move a task to "blocked" (e.g. QA-failed back to a dev), you MUST tag who's blocking it.

Why: the home page only surfaces blockers that need the human owner's input. QA-failed tickets bouncing back to a dev should NOT spam the human's home view.

When bouncing a QA-failed ticket back to a dev, set:
  - awaitingResponseFrom: "<dev-name>"   → lowercase, e.g. "trevor", "ana", "mikey"
  - blockedReason: "<one-line reason>"

If you genuinely need the human owner's product/scope decision (rare in QA flow):
  - needsUserResponse: true

Example (bouncing QA failure back to Trevor):
  curl -s http://localhost:4501/api/store -X POST -H "Content-Type: application/json" \\
    -d '{"action":"updateTask","id":"<id>","updates":{"status":"blocked","blockedReason":"create-reward submit button fires no event","awaitingResponseFrom":"trevor"}}'

Do NOT leave awaitingResponseFrom empty when QA-failing — a blocker with no named party is invisible to everyone and goes stale.`,
    enabled: true,
    order: 62,
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
    const store = await getStoreProviderAllWorkspaces().read();
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
    const provider = getStoreProviderAllWorkspaces();
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
    // #1497: targeted per-task UPDATEs instead of a full-store rewrite. The
    // old code read the entire store, mutated tasks in-memory, then
    // .write(store) — which DELETEs+INSERTs every task and races with
    // concurrent updateTask flips. Use provider.updateTask(taskId, ...) to
    // clear just devHandoff on the affected rows.
    const provider = getStoreProviderAllWorkspaces();
    const store = await provider.read();
    for (const t of store.tasks) {
      if (taskIds.includes(t.id) && t.devHandoff) {
        try { await provider.updateTask(t.id, { devHandoff: null }); }
        catch (e: any) { console.warn(`clearConsumedHandoffs #1497 updateTask failed for ${t.id}:`, e?.message || e); }
      }
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
  //   VISIBLE_ONLY = shown for awareness, NOT dispatched (external blocker)
  //   IGNORED     = not shown at all ('done', 'planning', unknown statuses)
  //
  // Never filter via `status !== 'done'` — new statuses silently become
  // actionable any time someone adds one to the schema. Always allowlist.
  const ACTIONABLE_STATUSES = new Set(['in-progress', 'backlog', 'qa']);
  // #1290: was ['blocked','review']; review column killed. Only blocked is shown for awareness now.
  const VISIBLE_ONLY_STATUSES = new Set(['blocked']);

  // Find tasks assigned to this agent (all non-archived — bucketed by status below)
  const nameLower = agentName.toLowerCase();
  const agentTasks = (store.tasks || []).filter((t: any) => {
    const assignee = (t.assignee || '').toLowerCase();
    return (assignee === nameLower || assignee === agentId) && !t.isArchived;
  });

  const inProgress = agentTasks.filter((t: any) => t.status === 'in-progress');
  const blocked = agentTasks.filter((t: any) => t.status === 'blocked');

  // #1189 / #1250 — single ordered dispatch queue. Versioned roadmap tickets
  // and adhoc bug/chore/spike/followup tickets sit in the same queue, ordered
  // by user-controlled sortOrder ASC (createdAt as deterministic tiebreaker).
  // The eligibility rules per lane are unchanged (versioned tickets still
  // need horizon/waitsFor/priorVersionsComplete; adhoc tickets need only an
  // active project + assignee + backlog status); what changed is the ORDER
  // — it is now the same field the context-board DnD writes (sortOrder), so
  // dragging a ticket to the top of backlog moves it to the top of dispatch.
  // The single source of truth lives in dispatch-gate.ts; do not re-implement
  // the filter here.
  //
  // #1197/#1198 SINGLE-WIP HARD GATE
  // -------------------------------
  // If the agent already has any in-progress task, suppress the backlog list
  // entirely from the dispatch message. The previous prompt-only rule (in the
  // skill / scheduler sections) was insufficient: agents continued to claim
  // backlog tickets while in-progress work was open, accumulating WIP that
  // had to be manually consolidated. By withholding backlog from dispatch when
  // in-progress is non-empty, we make multi-WIP impossible-by-default at the
  // dispatch boundary while still showing the agent their resume list.
  //
  // Edge cases handled:
  //   - QA in-progress: same rule, QA list still shown (in-progress takes
  //     precedence; QA review of someone else's work is not new claim).
  //   - blocked tasks: don't count toward in-progress, no effect on this gate.
  //   - dispatch with ONLY in-progress (no backlog): unchanged behavior.
  //
  // The agent can still pull a new backlog task by:
  //   1. Finishing the in-progress task (move to done), OR
  //   2. Bouncing it back to backlog (move to backlog) with a focus comment.
  // Either action clears the gate on the next dispatch.
  const rawBacklog = getEligibleBacklogFifo(store, [nameLower, agentId]) as any[];
  const backlog = inProgress.length > 0 ? [] : rawBacklog;
  const backlogSuppressedCount = inProgress.length > 0 ? rawBacklog.length : 0;
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
    // #1198 SINGLE-WIP: when in-progress is non-empty, dispatcher hides backlog
    // entirely. Tell the agent explicitly so they don't go pull from the board.
    const lockNote = backlogSuppressedCount > 0
      ? ` — backlog (${backlogSuppressedCount}) is hidden until in-progress is cleared`
      : '';
    lines.push(`**Resume in-progress (${inProgress.length})${lockNote}:**`);
    if (inProgress.length > 1) {
      lines.push(`> ⚠️ You have multiple in-progress tickets. Per the SINGLE-WIP rule, pick the one you'll actually finish now and move the rest back to backlog with a one-line focus comment. Do NOT work them in parallel.`);
    }
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
  // #1386 Phase 2 — per-agent API token wiring is deferred to a follow-up.
  //
  // Prompts above reference ${ORG_STUDIO_API_KEY} literally; that variable
  // is set in the agent shell environment by the upstream dispatch path
  // (gateway chat.send), not here. The right place to plug in a per-agent
  // token is the dispatch layer's env construction, which lives outside
  // this repo. The read-side helper is already in place:
  //   resolveAgentApiToken(teammates, agentId) in src/lib/teammates.ts
  // returns the per-agent token if settings.teammates[i].agentToken is
  // set, else falls back to process.env.ORG_STUDIO_API_KEY. The dispatch
  // path can call it when constructing the agent env. No prompt content
  // change required.
  //
  // Wiring the dispatch path itself is >50 LoC and crosses the
  // gateway/host boundary, so per #1386 scope it's a follow-up ticket.
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
