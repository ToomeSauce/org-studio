/**
 * vision-cron.ts
 * 
 * Helpers to manage OpenClaw cron jobs for autonomous vision improvements.
 * Uses Gateway RPC to create, update, and delete cron jobs.
 */

import { Project } from './store';
import { rpc } from './gateway-rpc';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface CronJob {
  name: string;
  schedule: {
    kind: 'cron';
    expr: string;
    tz: string;
  };
  payload: {
    kind: 'agentTurn';
    message: string;
    model: string;
    timeoutSeconds: number;
  };
  sessionTarget: 'isolated';
  delivery: { mode: 'announce' };
}

/**
 * Map cadence to cron expression
 * All times are 10am America/New_York
 */
export function cadenceToCron(cadence: string): string {
  switch (cadence) {
    case 'daily': return '0 10 * * *';
    case 'weekly': return '0 10 * * 1'; // Monday
    case 'biweekly': return '0 10 1,15 * *'; // 1st and 15th
    case 'monthly': return '0 10 1 * *'; // 1st of month
    default: return '0 10 * * 1'; // Default to weekly
  }
}

/**
 * Resolve devOwner name to agentId from store
 */
function resolveDevAgentId(project: Project): string | null {
  if (!project.devOwner) return null;
  try {
    const store = JSON.parse(readFileSync(join(process.cwd(), 'data', 'store.json'), 'utf-8'));
    const teammates = store.settings?.teammates || [];
    const match = teammates.find((t: any) => 
      t.name?.toLowerCase() === project.devOwner?.toLowerCase()
    );
    return match?.agentId || null;
  } catch {
    return null;
  }
}

/**
 * Build the vision cycle message that the cron agent will receive
 * Exported for use by both legacy cron and new Launch model
 */
export function buildLaunchMessage(project: Project): string {
  const projectId = project.id;
  const projectName = project.name;
  const devOwner = project.devOwner || 'unknown';
  const notifyTarget = process.env.NOTIFY_CHAT_ID || '';
  const apiKey = process.env.ORG_STUDIO_API_KEY || '';

  return `You are running a vision improvement cycle for the ${projectName} project.

## Step 1: Get the proposal prompt
Call: POST http://localhost:4501/api/vision/${projectId}/propose
This returns a structured prompt with the current VISION.md content, roadmap items, aspirations, boundaries, and constraints.

## Step 2: Analyze and propose
Read the prompt field from the response. Think through what would meaningfully move ${projectName} forward. Apply all constraints (impact thesis, max 8 tasks, demo test, no duplicates, boundary enforcement).

Determine the next unshipped version by reading the roadmap. Look for the first version section that still has unchecked \`- [ ]\` items. Do NOT propose a version that is already fully shipped (all items \`- [x]\`).

## Step 3: If no meaningful improvements exist, return: NO_IMPROVEMENTS_FOUND

## Step 4: Send proposal with inline buttons
If you have a proposal, send it via the message tool with inline approve/reject buttons:

Use: message(action="send", channel="telegram", target="${notifyTarget}", message="...", buttons=[[{"text": "✅ Approve", "callback_data": "vision_approve:${projectId}:v{VERSION}", "style": "success"}, {"text": "❌ Reject", "callback_data": "vision_reject:${projectId}:v{VERSION}", "style": "danger"}]])

Format the message as:
🔮 **Version Proposal: ${projectName} v{version}**
_Proposed by: ${devOwner} (vision cycle)_

{rationale}

**Tasks ({count}):**
1. **{title}** — {impact} _{effort}_
...

Lifecycle: stays \`{LIFECYCLE}\`
⚠️ _Proposal only — no tasks created yet._

After sending via the message tool, reply NO_REPLY.

IMPORTANT: This is a PROPOSAL only. Do NOT create tasks or modify any code. Wait for human approval before any execution.

## Step 5: Report completion
After sending the proposal (or finding no improvements), call:

POST http://localhost:4501/api/vision/${projectId}/complete
Authorization: Bearer ${apiKey}
Content-Type: application/json

If you proposed a version:
Body: {"proposal": {"version": "X.Y", "tasks": [{"title": "...", "impact": "..."}], "rationale": "..."}}

If no improvements found:
Body: {"noImprovements": true}

This step is MANDATORY. The system uses this to track cycle state and auto-approve minor versions.`;
}


/**
 * Build a cron job for a vision
 */
export function buildVisionCronJob(project: Project): CronJob {
  const cadence = project.autonomy?.cadence || 'weekly';
  const cronExpr = cadenceToCron(cadence);
  const message = buildLaunchMessage(project);

  return {
    name: `Vision: ${project.name} — improvement cycle`,
    schedule: {
      kind: 'cron',
      expr: cronExpr,
      tz: 'America/New_York',
    },
    payload: {
      kind: 'agentTurn',
      message,
      model: 'foundry-openai/gpt-5.4', // Reasoning model for strategic work
      timeoutSeconds: 300,
    },
    sessionTarget: 'isolated',
    delivery: { mode: 'announce' },
  };
}

/**
 * Register a vision cron via Gateway RPC
 * @deprecated - Replaced by Launch model. Use POST /api/vision/{id}/launch instead.
 * Returns null to signal this function is no longer used.
 */
export async function registerVisionCron(project: Project): Promise<string | null> {
  console.warn('[Vision Cron] registerVisionCron called but deprecated — use Launch model instead');
  return null;
}

/**
 * Update a vision cron via Gateway RPC (when cadence changes)
 * @deprecated - Replaced by Launch model. Use POST /api/vision/{id}/launch instead.
 */
export async function updateVisionCron(cronJobId: string, project: Project): Promise<boolean> {
  console.warn('[Vision Cron] updateVisionCron called but deprecated — use Launch model instead');
  return false;
}

/**
 * Delete a vision cron via Gateway RPC
 * @deprecated - Replaced by Launch model. Use POST /api/vision/{id}/launch instead.
 */
export async function deleteVisionCron(cronJobId: string): Promise<void> {
  console.warn('[Vision Cron] deleteVisionCron called but deprecated — use Launch model instead');
}

// ===== Backward compatibility aliases =====
/**
 * @deprecated Use registerVisionCron instead
 */
export async function registerCronJob(cronJob: CronJob, projectId: string): Promise<string> {
  // Legacy stub — new code should use registerVisionCron
  const cronJobId = `cron-${projectId}-${Date.now()}`;
  console.log(`[Vision Cron] registerCronJob (deprecated) — generated ID: ${cronJobId}`);
  return cronJobId;
}

/**
 * @deprecated Use updateVisionCron instead
 */
export async function updateCronJob(cronJobId: string, project: Project, visionPrompt: string): Promise<void> {
  // Legacy stub
  console.log(`[Vision Cron] updateCronJob (deprecated) — job ${cronJobId}`);
}

/**
 * @deprecated Use deleteVisionCron instead
 */
export async function deleteCronJob(cronJobId: string): Promise<void> {
  // Legacy stub
  console.log(`[Vision Cron] deleteCronJob (deprecated) — job ${cronJobId}`);
}
