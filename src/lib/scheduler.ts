/**
 * Scheduler helpers — prompt builder for agent work loops
 */
import { AgentLoop } from '@/lib/store';
import type { PromptSection } from '@/lib/store';

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
             or you're not fully confident in the result. When in doubt, use review.`,
    enabled: true,
    order: 30,
    builtIn: true,
  },
  {
    id: 'work-loop',
    label: 'Work Loop',
    content: `WORK LOOP — repeat until all your assigned work is done:
  1. Scan "in-progress" for tasks assigned to you. Pick the highest priority one and continue working on it.
  2. If nothing is in-progress, scan "backlog" for assigned tasks. Move the highest priority one to "in-progress" and start it.
  3. When a task is complete, move it to "done" or "review" (see guidance above). Then go back to step 1.
  4. Repeat until there are NO remaining tasks assigned to you in "in-progress" or "backlog".
  5. If you discover new work, improvements, or follow-up tasks in your domain while working, create them in "backlog" and continue working through the queue.
  6. When all assigned work is done, report idle, clear your activity status, and end.

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
      -d '{"action":"addTask","task":{"title":"<title>","projectId":"<project-id>","status":"backlog","assignee":"\${agentName}","priority":"medium"}}'

  Update task status:
    curl -s http://localhost:4501/api/store -X POST -H "Content-Type: application/json" \\
      -d '{"action":"updateTask","id":"<id>","updates":{"status":"<new-status>"}}'

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
- Clear your activity status when all work is done.`,
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
 * Interpolate ${agentName} and ${agentId} placeholders in a string.
 */
function interpolate(text: string, agentName: string, agentId: string): string {
  return text.replace(/\$\{agentName\}/g, agentName).replace(/\$\{agentId\}/g, agentId);
}

/**
 * Get the effective prompt sections for a given loop.
 * If the loop has custom promptSections, merge with defaults (custom overrides by id).
 * Otherwise, return a copy of DEFAULT_SECTIONS.
 */
export function getEffectiveSections(loop: AgentLoop): PromptSection[] {
  if (!loop.promptSections || loop.promptSections.length === 0) {
    return DEFAULT_SECTIONS.map(s => ({ ...s }));
  }

  // Start from defaults, then overlay loop customizations by id
  const sectionMap = new Map<string, PromptSection>();
  for (const s of DEFAULT_SECTIONS) {
    sectionMap.set(s.id, { ...s });
  }
  for (const s of loop.promptSections) {
    sectionMap.set(s.id, { ...s });
  }

  return Array.from(sectionMap.values());
}

/**
 * Build the agent prompt from a loop's enabled steps.
 * Supports global preamble (prepended to all loops) and per-loop system prompt override.
 */
export function buildLoopPrompt(
  loop: AgentLoop,
  agentName: string,
  globalPreamble?: string
): string {
  const parts: string[] = [];

  // Global preamble — always prepended if provided
  if (globalPreamble?.trim()) {
    parts.push(globalPreamble.trim());
    parts.push('');
  }

  parts.push(`SCHEDULER_LOOP: autonomous work cycle for ${agentName}`);
  parts.push('');

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
  const sections = getEffectiveSections(loop);
  const enabledSections = sections
    .filter(s => s.enabled)
    .sort((a, b) => a.order - b.order);

  const sectionText = enabledSections
    .map(s => interpolate(s.content, agentName, loop.agentId))
    .join('\n\n');

  parts.push(sectionText);

  return parts.join('\n');
}
