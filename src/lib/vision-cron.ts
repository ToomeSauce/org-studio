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
 * Build the wake message handed to the devOwner agent when a project
 * launches a new version.
 *
 * Roadmap-aware, in-session only. The version was already approved via
 * the Org Studio roadmap UI (approvedVersions[] checkboxes); the agent's
 * job is to start working — not to propose a version, not to send a
 * Telegram side-channel, not to push approve/reject buttons anywhere.
 *
 * #1230: ripped out the legacy "Version Proposal: ... vision_approve:"
 * Telegram flow. If a future flow needs version proposals, it should be
 * a separate cron + a separate prompt, not bolted into Launch.
 */
export async function buildLaunchMessage(project: Project): Promise<string> {
  const projectId = project.id;
  const projectName = project.name;
  const version = project.currentVersion || '(unset)';

  const itemsLines = await loadVersionItemSummary(projectId, project.currentVersion || null);
  const itemsBlock = itemsLines.length
    ? `\nRoadmap items in this version:\n${itemsLines.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n`
    : '';

  return `${projectName} just launched ${version}.
${itemsBlock}
Next steps:
1. Open the roadmap for this project in Org Studio (http://localhost:4501) and confirm each item's \`doneWhen\` is sharp enough to work against. Edit it inline if not.
2. Pick the first item's task, move it to \`in-progress\`, and start working.
3. Update task status as you go (in-progress → review/done). The next dispatch is automatic; don't ask for one.

Do NOT propose a new version — that already happened in the roadmap UI before launch.
Do NOT send Telegram approve/reject messages or buttons — the legacy proposal flow is retired.

If something is genuinely blocking (missing context, conflicting requirement, unclear scope), comment on the task with status=blocked and stop.`;
}

/**
 * Load a short "title → task #ticket" line per roadmap item for the
 * current version. Best-effort: if Postgres isn't reachable or the row
 * isn't present, return [] and the caller will skip the items block.
 */
async function loadVersionItemSummary(
  projectId: string,
  version: string | null,
): Promise<string[]> {
  if (!version) return [];
  if (!process.env.DATABASE_URL) return [];
  try {
    const pg = await import('pg');
    const client = new pg.Client(process.env.DATABASE_URL);
    await client.connect();
    try {
      const rv = await client.query(
        `SELECT items FROM org_studio_roadmap_versions
         WHERE project_id = $1 AND version = $2 AND workspace_id = $3 LIMIT 1`,
        [projectId, version, 'default-workspace'],
      );
      if (rv.rows.length === 0) return [];
      const items: any[] = Array.isArray(rv.rows[0].items) ? rv.rows[0].items : [];
      if (items.length === 0) return [];

      // For each item, look up the ticket number if the taskId is set so
      // the agent can navigate directly. Don't fail the whole message if
      // a single lookup misses.
      const lines: string[] = [];
      for (const it of items) {
        const title = it?.title || '(untitled)';
        if (it?.taskId) {
          try {
            const t = await client.query(
              `SELECT ticket_number FROM org_studio_tasks WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
              [it.taskId, 'default-workspace'],
            );
            const num = t.rows[0]?.ticket_number;
            lines.push(num ? `${title} → #${num}` : `${title} → task ${it.taskId}`);
          } catch {
            lines.push(`${title} → task ${it.taskId}`);
          }
        } else {
          lines.push(`${title} (no task linked)`);
        }
      }
      return lines;
    } finally {
      await client.end();
    }
  } catch (e: any) {
    console.warn(`[vision-cron] loadVersionItemSummary failed for ${projectId} ${version}: ${e?.message}`);
    return [];
  }
}


/**
 * Build a cron job for a vision
 * @deprecated #1230 — buildLaunchMessage is async now and the legacy
 * weekly-cron flow is unwired. Kept as a stub; remove in a follow-up
 * once we've verified nothing imports it.
 */
export async function buildVisionCronJob(project: Project): Promise<CronJob> {
  const cadence = project.autonomy?.cadence || 'weekly';
  const cronExpr = cadenceToCron(cadence);
  const message = await buildLaunchMessage(project);

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
      model: 'foundry-openai/gpt-5.4',
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
