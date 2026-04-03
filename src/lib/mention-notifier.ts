/**
 * @mention detection + cross-runtime notification for task comments.
 *
 * When an agent posts a comment containing @AgentName, this module:
 * 1. Parses the comment text for @mentions
 * 2. Resolves each mention against the teammate roster
 * 3. Sends a notification to the mentioned agent via the runtime registry
 *
 * This turns the task board into a cross-runtime message board.
 * A Hermes agent can @mention an OpenClaw agent and vice versa.
 */
import { sendToAgent } from '@/lib/runtimes/registry';
import { rpc } from '@/lib/gateway-rpc';

interface Teammate {
  id: string;
  agentId: string;
  name: string;
  emoji?: string;
  isHuman?: boolean;
  runtime?: string;
}

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

interface MentionMatch {
  raw: string;       // "@Ana" as written
  teammate: Teammate;
}

/**
 * Parse @mentions from comment text.
 * Matches @Name (case-insensitive) against the teammate roster.
 * Supports: @Ana, @henry, @Billy, @hermes-agent
 */
export function parseMentions(text: string, teammates: Teammate[]): MentionMatch[] {
  if (!text || !teammates?.length) return [];

  // Match @word patterns (supports hyphens for agent IDs like hermes-127.0.0.1)
  const mentionPattern = /@([\w][\w-]*)/g;
  const matches: MentionMatch[] = [];
  const seen = new Set<string>();
  let match;

  while ((match = mentionPattern.exec(text)) !== null) {
    const raw = match[0];
    const mention = match[1].toLowerCase();

    // Match against name or agentId (case-insensitive)
    const teammate = teammates.find(t =>
      t.name?.toLowerCase() === mention ||
      t.agentId?.toLowerCase() === mention ||
      t.id?.toLowerCase() === mention
    );

    if (teammate && !seen.has(teammate.id)) {
      seen.add(teammate.id);
      matches.push({ raw, teammate });
    }
  }

  return matches;
}

/**
 * Notify mentioned agents about a comment.
 * Routes through the runtime registry so it works cross-runtime.
 */
export async function notifyMentionedAgents(
  task: Task,
  comment: Comment,
  mentions: MentionMatch[],
  allTeammates: Teammate[],
): Promise<{ sent: string[]; failed: string[] }> {
  const sent: string[] = [];
  const failed: string[] = [];

  for (const { teammate } of mentions) {
    // Don't notify the comment author about their own mention
    if (
      teammate.name?.toLowerCase() === comment.author?.toLowerCase() ||
      teammate.agentId?.toLowerCase() === comment.author?.toLowerCase()
    ) {
      continue;
    }

    // Don't notify humans (they see it in the UI)
    if (teammate.isHuman) continue;

    const message = formatMentionNotification(task, comment, teammate);

    try {
      // Try runtime registry first (works for both OpenClaw and Hermes)
      await sendToAgent(teammate.agentId, message, {
        sessionKey: `agent:${teammate.agentId}:main`,
        idempotencyKey: `mention-${task.id}-${comment.id || Date.now()}-${teammate.agentId}`,
      });
      sent.push(teammate.agentId);
    } catch (primaryErr) {
      // Fallback: try direct OpenClaw RPC (agent might not be in registry yet)
      try {
        await rpc('chat.send', {
          sessionKey: `agent:${teammate.agentId}:main`,
          message,
          idempotencyKey: `mention-${task.id}-${comment.id || Date.now()}-${teammate.agentId}`,
        });
        sent.push(teammate.agentId);
      } catch {
        console.error(`[mentions] Failed to notify ${teammate.agentId}:`, primaryErr);
        failed.push(teammate.agentId);
      }
    }
  }

  return { sent, failed };
}

/**
 * Format the notification message sent to a mentioned agent.
 */
function formatMentionNotification(task: Task, comment: Comment, mentioned: Teammate): string {
  const lines: string[] = [];
  lines.push(`💬 **${comment.author}** mentioned you on task: **${task.title}**`);
  lines.push('');
  lines.push(`> ${comment.content}`);
  lines.push('');
  lines.push(`Task ID: ${task.id}`);
  lines.push('');
  lines.push('To reply, post a comment on this task via the API:');
  lines.push('```');
  lines.push(`curl -s http://localhost:4501/api/store -X POST \\`);
  lines.push(`  -H "Content-Type: application/json" \\`);
  lines.push(`  -H "Authorization: Bearer YOUR_ORG_STUDIO_API_KEY" \\`);
  lines.push(`  -d '{"action":"addComment","taskId":"${task.id}","comment":{"author":"${mentioned.name}","content":"your reply here","type":"comment"}}'`);
  lines.push('```');

  return lines.join('\n');
}
