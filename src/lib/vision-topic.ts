/**
 * @deprecated — Topic posting removed from active flow (2026-03-31).
 * Org Studio context board is now the single source of sprint status.
 * Agents work in their persistent main sessions — no topic routing needed.
 * 
 * vision-topic.ts
 *
 * Creates and manages Telegram topics for vision projects.
 * Each project gets ONE persistent topic — all version updates post there.
 * Status updates for tasks in the current version auto-post to the topic.
 */

import { Project } from './store';
import { getStoreProvider } from './store-provider';

/** The supergroup where project topics are created */
const TEAM_GROUP_ID = process.env.VISION_TOPIC_GROUP_ID || '';

/** Telegram bot token — read from env */
const BOT_TOKEN = process.env.VISION_TOPIC_BOT_TOKEN || '';

export interface ProjectTopic {
  topicId: string;         // Telegram message_thread_id
  projectId: string;
  groupId: string;
  createdAt: number;
  currentVersion?: string; // Latest version being tracked
}

/**
 * Get or create the Telegram topic for a project.
 * Reuses existing topic if one exists — one topic per project, not per version.
 */
export async function getOrCreateProjectTopic(
  project: Project,
): Promise<string | null> {
  if (!TEAM_GROUP_ID || !BOT_TOKEN) {
    return null;
  }

  // Check if we already have a topic for this project
  const existing = await getProjectTopic(project.id);
  if (existing) return existing.topicId;

  // Create a new topic — named after the project (not the version)
  const topicName = `📍 ${project.name}`;

  try {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createForumTopic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TEAM_GROUP_ID,
        name: topicName,
      }),
    });

    const result = await response.json();
    if (!result.ok) {
      console.error('[Vision Topic] Telegram API error:', result.description);
      return null;
    }

    const topicId = String(result.result.message_thread_id);

    // Store the topic mapping in settings
    await saveProjectTopicMapping({
      topicId,
      projectId: project.id,
      groupId: TEAM_GROUP_ID,
      createdAt: Date.now(),
    });

    console.log(`[Vision Topic] Created project topic "${topicName}" (ID: ${topicId})`);
    return topicId;

  } catch (e: any) {
    console.error('[Vision Topic] Failed to create topic:', e?.message || e);
    return null;
  }
}

/**
 * Create a version topic (or reuse existing project topic) and post kickoff message.
 * Called when a version is approved.
 */
export async function createVersionTopic(
  project: Project,
  version: string,
  taskCount: number,
): Promise<string | null> {
  const topicId = await getOrCreateProjectTopic(project);
  if (!topicId) return null;

  // Post version kickoff message to the existing project topic
  const leads = buildLeadsList(project);
  const kickoffMessage = [
    `🚀 **${project.name} v${version} — Sprint Started**`,
    ``,
    `**Tasks:** ${taskCount}`,
    `**Dev:** ${project.devOwner || project.owner || 'Unassigned'}`,
    `**QA:** ${project.qaOwner || 'Unassigned'}`,
    `**Vision Owner:** ${project.visionOwner || 'Unassigned'}`,
    ``,
    leads.length > 0 ? `**Leads:** ${leads.join(', ')}` : '',
    ``,
    `Task updates for v${version} will post here.`,
  ].filter(Boolean).join('\n');

  try {
    await sendToTopic(TEAM_GROUP_ID, topicId, kickoffMessage);

    // Update the current version in the topic mapping
    const existing = await getProjectTopic(project.id);
    if (existing) {
      await saveProjectTopicMapping({ ...existing, currentVersion: version });
    }
  } catch (e) {
    console.error('[Vision Topic] Failed to post kickoff:', e);
  }

  return topicId;
}

/**
 * Post a task status update to the project's topic (if one exists).
 */
export async function postTaskUpdateToTopic(
  task: { id: string; title: string; assignee: string; projectId: string; reviewNotes?: string },
  newStatus: string,
): Promise<void> {
  const topic = await getProjectTopic(task.projectId);
  if (!topic) return;

  const statusEmoji: Record<string, string> = {
    'in-progress': '⚙️',
    'review': '👀',
    'done': '✅',
    'blocked': '🚫',
    'qa': '🧪',
    'backlog': '📋',
  };

  const emoji = statusEmoji[newStatus] || '📋';
  let message = `${emoji} **${task.title}**\n↳ ${task.assignee} → **${newStatus}**`;
  if (task.reviewNotes?.trim()) {
    message += `\n\n💬 ${task.reviewNotes.trim()}`;
  }

  try {
    await sendToTopic(topic.groupId, topic.topicId, message);
  } catch (e) {
    console.error('[Vision Topic] Failed to post update:', e);
  }
}

/**
 * Post a blocker/handoff alert to the project's topic.
 */
export async function postHandoffToTopic(
  task: { id: string; title: string; projectId: string },
  author: string,
  handoffMessage: string,
): Promise<void> {
  const topic = await getProjectTopic(task.projectId);
  if (!topic) return;

  const message = [
    `🔧 **Handoff: ${task.title}**`,
    `↳ ${author} resolved a blocker:`,
    ``,
    handoffMessage,
  ].join('\n');

  try {
    await sendToTopic(topic.groupId, topic.topicId, message);
  } catch (e) {
    console.error('[Vision Topic] Failed to post handoff:', e);
  }
}

/**
 * Post a version completion summary to the project's topic.
 */
export async function closeVersionTopic(
  projectId: string,
  version: string,
  summary: { tasksShipped: number; retrospective?: string },
): Promise<void> {
  const topic = await getProjectTopic(projectId);
  if (!topic) return;

  let message = `🏁 **v${version} Complete!**\n\n`;
  message += `✅ ${summary.tasksShipped} tasks shipped`;
  if (summary.retrospective) {
    message += `\n\n📊 **Retrospective:**\n${summary.retrospective}`;
  }

  try {
    await sendToTopic(topic.groupId, topic.topicId, message);
  } catch (e) {
    console.error('[Vision Topic] Failed to post completion:', e);
  }
}

// --- Internal helpers ---

async function sendToTopic(groupId: string, topicId: string, message: string): Promise<void> {
  if (!BOT_TOKEN) return;

  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: groupId,
      message_thread_id: Number(topicId),
      text: message,
      parse_mode: 'Markdown',
    }),
  });

  const result = await response.json();
  if (!result.ok) {
    console.error('[Vision Topic] sendMessage error:', result.description);
  }
}

/** Map of agentId → Telegram bot username for @mentions */
const AGENT_BOT_USERNAMES: Record<string, string> = {
  main: 'henrytoum_bot',
  ana: 'ana_cat_bot',
  mikey: 'mikey_labs_bot',
  sam: 'sam_pro_se_bot',
  billy: 'billy_bobby_bot',
};

function resolveLeadMention(displayName: string): string {
  if (!displayName) return 'Unassigned';
  // Simple lookup — could be enhanced with store read if needed
  const lower = displayName.toLowerCase();
  for (const [agentId, username] of Object.entries(AGENT_BOT_USERNAMES)) {
    if (lower.includes(agentId) || lower === agentId) {
      return `@${username}`;
    }
  }
  return displayName;
}

function buildLeadsList(project: Project): string[] {
  const leads: string[] = [];
  const seen = new Set<string>();
  for (const owner of [project.visionOwner, project.devOwner, project.qaOwner]) {
    if (!owner || seen.has(owner.toLowerCase())) continue;
    seen.add(owner.toLowerCase());
    leads.push(resolveLeadMention(owner));
  }
  return leads;
}

/** Get the topic for a project from settings (Postgres-backed) */
async function getProjectTopic(projectId: string): Promise<ProjectTopic | null> {
  try {
    const store = await getStoreProvider().read();
    const topics: ProjectTopic[] = store.settings?.projectTopics || [];
    return topics.find(t => t.projectId === projectId) || null;
  } catch {
    return null;
  }
}

/** Save/update a project topic mapping in settings */
async function saveProjectTopicMapping(topic: ProjectTopic): Promise<void> {
  try {
    const store = await getStoreProvider().read();
    const settings = store.settings || {};
    const topics: ProjectTopic[] = settings.projectTopics || [];

    const idx = topics.findIndex(t => t.projectId === topic.projectId);
    if (idx >= 0) {
      topics[idx] = topic;
    } else {
      topics.push(topic);
    }

    await getStoreProvider().updateSettings({ ...settings, projectTopics: topics });
  } catch (e) {
    console.error('[Vision Topic] Failed to save topic mapping:', e);
  }
}

/** Get topic for a specific project (exported for external use) */
export function getVersionTopic(projectId: string, version: string): null {
  // Deprecated — use getProjectTopic instead. Kept for backward compat.
  return null;
}
