/**
 * Mentions module — shared helpers for @mention parsing, resolution, and autocomplete.
 *
 * Extracted from mention-notifier.ts to serve both the notification router
 * and the (future) UI autocomplete scaffold.
 */

export interface Teammate {
  id: string;
  agentId: string;
  name: string;
  emoji?: string;
  isHuman?: boolean;
  runtime?: string;
  role?: string;
}

export interface MentionMatch {
  raw: string;       // "@Ana" as written
  teammate: Teammate;
}

/**
 * Parse @mentions from comment text.
 * Matches @Name (case-insensitive) against the teammate roster.
 * Returns MentionMatch[] with resolved teammate objects.
 * Output teammate.agentId can be treated as the canonical agent ID.
 */
export function parseMentions(text: string, teammates: Teammate[]): MentionMatch[] {
  if (!text || !teammates?.length) return [];

  const mentionPattern = /(?<![\w.])@([\w][\w-]*)/g;
  const matches: MentionMatch[] = [];
  const seen = new Set<string>();
  let match;

  while ((match = mentionPattern.exec(text)) !== null) {
    const raw = match[0];
    const mention = match[1].toLowerCase();

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
 * Resolve a list of display-name mentions to agent IDs.
 * Useful when comment.mentions is stored as display names.
 */
export function resolveToAgentIds(mentions: string[], teammates: Teammate[]): string[] {
  const ids: string[] = [];
  for (const m of mentions) {
    const lower = m.toLowerCase();
    const t = teammates.find(tm =>
      tm.name?.toLowerCase() === lower ||
      tm.agentId?.toLowerCase() === lower ||
      tm.id?.toLowerCase() === lower
    );
    if (t) ids.push(t.agentId);
  }
  return ids;
}

/**
 * Build the set of project teammates for a given project.
 * Includes owners (devOwner, visionOwner, qaOwner, owner) + assignees from project tasks.
 */
export function getProjectTeammateNames(
  project: { devOwner?: string; visionOwner?: string; qaOwner?: string; owner?: string },
  projectTasks: { assignee?: string }[],
): Set<string> {
  const names = new Set<string>();
  if (project.devOwner) names.add(project.devOwner);
  if (project.visionOwner) names.add(project.visionOwner);
  if (project.qaOwner) names.add(project.qaOwner);
  if (project.owner) names.add(project.owner);
  for (const t of projectTasks) {
    if (t.assignee) names.add(t.assignee);
  }
  return names;
}

// ---------- Autocomplete scaffold ----------

export interface MentionCandidate {
  agentId: string;
  name: string;
  emoji?: string;
}

export interface MentionScope {
  kind: 'task' | 'board' | 'section' | 'dm';
  taskId?: string;
  boardProjectId?: string;
  sectionId?: string;
  dmThreadId?: string;
}

export interface MentionContext {
  project?: { devOwner?: string; visionOwner?: string; qaOwner?: string; owner?: string };
  projectTasks?: { assignee?: string }[];
  taskAssignee?: string;
  dmParticipantIds?: string[];
}

/**
 * Get mention autocomplete candidates for a given scope + context.
 *
 * - `task`: project teammates + task assignee
 * - `board`/`section`: project teammates
 * - `dm`: the two DM participants only
 *
 * TODO(v0.14): Wire this into a UI autocomplete dropdown component.
 * This is a scaffold — the helper is ready, no UI yet.
 */
export function getMentionCandidates(
  scope: MentionScope,
  context: MentionContext,
  allTeammates: Teammate[],
): MentionCandidate[] {
  const candidateSet = new Set<string>(); // agentId dedup
  const candidates: MentionCandidate[] = [];

  const add = (nameOrId: string) => {
    const lower = nameOrId.toLowerCase();
    const t = allTeammates.find(tm =>
      tm.name?.toLowerCase() === lower ||
      tm.agentId?.toLowerCase() === lower ||
      tm.id?.toLowerCase() === lower
    );
    if (t && !candidateSet.has(t.agentId)) {
      candidateSet.add(t.agentId);
      candidates.push({ agentId: t.agentId, name: t.name, emoji: t.emoji });
    }
  };

  if (scope.kind === 'dm') {
    // DM: only the two participants
    for (const pid of context.dmParticipantIds || []) {
      add(pid);
    }
  } else {
    // task / board / section: project teammates
    if (context.project && context.projectTasks) {
      const names = getProjectTeammateNames(context.project, context.projectTasks);
      for (const n of names) add(n);
    }
    // For task scope, also include the task assignee explicitly
    if (scope.kind === 'task' && context.taskAssignee) {
      add(context.taskAssignee);
    }
  }

  return candidates;
}
