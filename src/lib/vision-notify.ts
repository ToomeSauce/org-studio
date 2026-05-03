/**
 * @deprecated — Topic posting removed from active flow (2026-03-31).
 * Org Studio context board is now the single source of sprint status.
 * Agents work in their persistent main sessions — no topic routing needed.
 */

import { Project } from './store';
import { rpc } from './gateway-rpc';

const NOTIFY_CHAT_ID = process.env.NOTIFY_CHAT_ID || '';

interface VersionPlan {
  version: string;
  rationale: string;
  tasks: Array<{
    title: string;
    impact: string;
  }>;
}

interface VersionSummary {
  version: string;
  tasksShipped: string[];
  retrospective?: string;
}

/**
 * Sends a version proposal notification via Telegram with approve/reject buttons.
 */
export async function sendVersionProposal(project: Project, versionPlan: VersionPlan) {
  try {
    const devOwner = project.devOwner || project.owner || 'System';
    const tasksList = versionPlan.tasks
      .map(
        (t, i) => `${i + 1}. **${t.title}** — ${t.impact}`
      )
      .join('\n');

    const message = `🔮 **Version Proposal: ${project.name} ${versionPlan.version}**

**Proposed by:** ${devOwner} (auto)
**Impact:** ${versionPlan.rationale}

**Tasks (${versionPlan.tasks.length}):**
${tasksList}`;

    // Use message tool via Gateway RPC to send with inline buttons
    // Buttons: vision_approve:{projectId}, vision_reject:{projectId}
    await rpc('chat.send', {
      chatId: NOTIFY_CHAT_ID,
      message,
      buttons: [
        { text: '✅ Approve', callback_data: `vision_approve:${project.id}` },
        { text: '❌ Reject', callback_data: `vision_reject:${project.id}` },
      ],
    });
  } catch (e) {
    console.error('[Vision Notify] Failed to send proposal:', e);
  }
}

/**
 * Sends a version completion summary notification.
 */
export async function sendVersionComplete(
  project: Project,
  summary: VersionSummary
) {
  try {
    const shippedList = summary.tasksShipped
      .map((t, i) => `${i + 1}. ${t}`)
      .join('\n');

    let message = `✅ **Version Complete: ${project.name} ${summary.version}**

**Shipped:**
${shippedList}`;

    if (summary.retrospective) {
      message += `\n\n**Retrospective:**
${summary.retrospective}`;
    }

    await rpc('chat.send', {
      chatId: NOTIFY_CHAT_ID,
      message,
    });
  } catch (e) {
    console.error('[Vision Notify] Failed to send completion:', e);
  }
}

// ---------- Version-shipped nudge (#1191) ----------

/**
 * Build the version-shipped nudge message.
 *
 * Pure helper, exposed for tests. Format per spec/2026-05-03 ticket G:
 *   "✅ v0.4.1 shipped on Org Studio. Approve next?"
 *
 * Versions are rendered as-is (already semver per the v0.16 migration).
 */
export function buildVersionShippedMessage(projectName: string, version: string): string {
  return `✅ v${version} shipped on ${projectName}. Approve next?`;
}

/**
 * Resolve the vision owner's agentId from a teammates list.
 * Display name OR agentId match (case-insensitive). Mirrors the
 * resolveTeammate helper in notification-router.
 */
export function resolveVisionOwnerAgentId(
  visionOwner: string | undefined,
  teammates: Array<{ name?: string; agentId?: string }> | undefined,
): string | null {
  if (!visionOwner) return null;
  const list = teammates || [];
  const lower = visionOwner.toLowerCase();
  const hit = list.find((t) => {
    return (
      t.agentId?.toLowerCase() === lower ||
      t.name?.toLowerCase() === lower
    );
  });
  return hit?.agentId || null;
}

/**
 * Send a Telegram nudge to the vision owner when a roadmap version flips
 * to status='shipped'. One per shipped version (idempotency key includes
 * project + version, so even if checkAndAutoAdvance runs twice on the
 * same flip the user only gets one ping).
 *
 * Failure is non-fatal — the version stays shipped, we just log.
 */
export async function sendVersionShippedNudge(
  project: { id: string; name: string; visionOwner?: string },
  version: string,
  teammates: Array<{ name?: string; agentId?: string }>,
): Promise<void> {
  try {
    const agentId = resolveVisionOwnerAgentId(project.visionOwner, teammates);
    if (!agentId) {
      console.log(
        `[VersionNudge] ${project.id}: no resolvable vision owner for "${project.visionOwner}" — skipping nudge for ${version}`,
      );
      return;
    }
    const message = buildVersionShippedMessage(project.name, version);
    await rpc('chat.send', {
      sessionKey: `agent:${agentId}:main`,
      message,
      idempotencyKey: `version-shipped:${project.id}:${version}`,
    });
    console.log(
      `[VersionNudge] ${project.id}: nudged ${agentId} for ${version}`,
    );
  } catch (e) {
    console.error('[Vision Notify] Failed to send version-shipped nudge:', e);
  }
}
