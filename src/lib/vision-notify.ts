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

    const message = `🔮 **Version Proposal: ${project.name} v${versionPlan.version}**

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

    let message = `✅ **Version Complete: ${project.name} v${summary.version}**

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
