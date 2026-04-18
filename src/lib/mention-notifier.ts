/**
 * @mention detection + cross-runtime notification for task comments.
 *
 * DEPRECATED: This module's individual dispatchers are now thin wrappers
 * around routeCommentNotifications() in notification-router.ts.
 * Kept for backward compatibility — existing imports still work.
 *
 * Use routeCommentNotifications() for new code.
 */
import { routeCommentNotifications } from '@/lib/notification-router';
import type { Teammate, MentionMatch } from '@/lib/mentions';
export { parseMentions } from '@/lib/mentions';
export type { Teammate, MentionMatch } from '@/lib/mentions';

interface Task {
  id: string;
  title: string;
  projectId?: string;
  assignee?: string;
}

interface Comment {
  author: string;
  content: string;
  id?: string;
}

/**
 * Notify mentioned agents about a task-scoped comment.
 * @deprecated Use routeCommentNotifications() instead.
 */
export async function notifyMentionedAgents(
  task: Task,
  comment: Comment,
  mentions: MentionMatch[],
  allTeammates: Teammate[],
): Promise<{ sent: string[]; failed: string[] }> {
  const result = await routeCommentNotifications({
    comment: {
      id: comment.id,
      author: comment.author,
      content: comment.content,
    },
    scope: { kind: 'task', taskId: task.id },
    teammates: allTeammates,
    context: {
      task: {
        id: task.id,
        title: task.title,
        projectId: task.projectId,
        assignee: task.assignee,
      },
    },
  });

  return {
    sent: result.notified,
    failed: result.skipped.filter(s => s.reason === 'delivery-failed').map(s => s.agentId),
  };
}

/**
 * Board-scoped mention notifications.
 * @deprecated Use routeCommentNotifications() instead.
 */
export async function notifyBoardMentions(
  boardProjectId: string,
  comment: Comment,
  allTeammates: Teammate[],
  projectTeammateNames: string[],
): Promise<{ sent: string[]; failed: string[] }> {
  // Build a minimal project context from the teammate names
  const result = await routeCommentNotifications({
    comment: {
      id: comment.id,
      author: comment.author,
      content: comment.content,
    },
    scope: { kind: 'board', boardProjectId },
    teammates: allTeammates,
    context: {
      project: {
        id: boardProjectId,
        name: 'Board Chat',
      },
      projectTasks: projectTeammateNames.map(n => ({ assignee: n })),
    },
  });

  return {
    sent: result.notified,
    failed: result.skipped.filter(s => s.reason === 'delivery-failed').map(s => s.agentId),
  };
}

/**
 * Section-scoped mention notifications.
 * @deprecated Use routeCommentNotifications() instead.
 */
export async function notifySectionMentions(
  boardProjectId: string,
  sectionId: string,
  sectionName: string,
  sectionOwner: string | undefined,
  comment: Comment,
  allTeammates: Teammate[],
  projectTeammateNames: string[],
): Promise<{ sent: string[]; failed: string[] }> {
  const result = await routeCommentNotifications({
    comment: {
      id: comment.id,
      author: comment.author,
      content: comment.content,
    },
    scope: { kind: 'section', sectionId, boardProjectId },
    teammates: allTeammates,
    context: {
      project: {
        id: boardProjectId,
        name: 'Project',
      },
      section: {
        id: sectionId,
        name: sectionName,
        owner: sectionOwner,
      },
      projectTasks: projectTeammateNames.map(n => ({ assignee: n })),
    },
  });

  return {
    sent: result.notified,
    failed: result.skipped.filter(s => s.reason === 'delivery-failed').map(s => s.agentId),
  };
}

/**
 * DM-scoped recipient notification.
 * @deprecated Use routeCommentNotifications() instead.
 */
export async function notifyDmRecipient(
  comment: Comment,
  dmThreadId: string,
  allTeammates: Teammate[],
): Promise<{ sent: string[]; failed: string[] }> {
  const result = await routeCommentNotifications({
    comment: {
      id: comment.id,
      author: comment.author,
      content: comment.content,
    },
    scope: { kind: 'dm', dmThreadId },
    teammates: allTeammates,
    context: {},
  });

  return {
    sent: result.notified,
    failed: result.skipped.filter(s => s.reason === 'delivery-failed').map(s => s.agentId),
  };
}
