/**
 * add-comment-validation.ts
 *
 * Pure validation helper for the `addComment` mutation. Extracted so we can
 * unit-test the rules without booting Next's request machinery.
 *
 * Covers two #1217 bugs:
 *   - Bug A (empty body): reject submissions where content/body/text are all
 *     missing or whitespace-only.
 *   - Bug B (author mis-attribution): when the request is authenticated via
 *     API key, require an explicit non-empty `comment.author` (no silent
 *     fallback to a hardcoded user) and never rewrite the placeholder 'You'.
 *
 * Pattern matches src/lib/update-task-validation.ts (#1195).
 */

export type AuthMethod = 'session' | 'apikey' | 'noauth' | 'agent-token';

export interface AddCommentInput {
  comment?: {
    author?: string;
    content?: string;
    body?: string;
    text?: string;
    [k: string]: any;
  };
}

export interface ValidationError {
  ok: false;
  status: number;
  error: string;
}

export interface ValidationOk {
  ok: true;
}

export type ValidationResult = ValidationError | ValidationOk;

/** Trim a value if it's a string; return '' otherwise. */
function trimOrEmpty(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** True iff at least one of content/body/text has non-whitespace text. */
export function hasNonEmptyContent(comment: AddCommentInput['comment'] | undefined): boolean {
  if (!comment) return false;
  return (
    trimOrEmpty(comment.content).length > 0 ||
    trimOrEmpty(comment.body).length > 0 ||
    trimOrEmpty(comment.text).length > 0
  );
}

/**
 * Validate addComment payload + auth context. Returns {ok:true} or a 400 with
 * an explanatory message. Does NOT mutate the payload; the route handler is
 * responsible for resolving the final `author` string after this passes.
 */
export function validateAddComment(
  payload: AddCommentInput,
  authMethod: AuthMethod | undefined,
): ValidationResult {
  if (!payload.comment) {
    return { ok: false, status: 400, error: 'comment payload required' };
  }

  if (!hasNonEmptyContent(payload.comment)) {
    return {
      ok: false,
      status: 400,
      error: 'comment must have non-empty content',
    };
  }

  // #1217 Bug B: API-key callers must specify an explicit author. The global
  // API key has no human owner, so we refuse to silently substitute one.
  // #1383: per-agent tokens DO carry a real userId (the token owner), so they
  // are NOT subject to this rule — the route handler resolves author from
  // the token's userId the same way it does for sessions.
  if (authMethod === 'apikey') {
    const author = trimOrEmpty(payload.comment.author);
    if (!author) {
      return {
        ok: false,
        status: 400,
        error: 'comment.author required when posting via API key',
      };
    }
  }

  return { ok: true };
}

/**
 * Resolve the final `author` string for a comment, given the validated payload
 * and auth context. Mirrors the route handler's old inline logic, but with
 * #1217 Bug B fix: only the `session` auth method may rewrite a missing /
 * placeholder author into the logged-in user's teammate name.
 */
export function resolveCommentAuthor(
  rawAuthor: string | undefined,
  authMethod: AuthMethod | undefined,
  requestUserId: string | null | undefined,
  teammates: Array<{ id?: string; agentId?: string; name?: string; email?: string }>,
): string {
  // For apikey/noauth, trust the payload exactly. Validation should have
  // already required a non-empty author for apikey.
  // For session and agent-token, both have a real userId we can fall back to.
  if (authMethod !== 'session' && authMethod !== 'agent-token') {
    return rawAuthor || 'Unknown';
  }

  // session auth: keep explicit non-placeholder author
  if (rawAuthor && rawAuthor !== 'You') return rawAuthor;

  // resolve 'You' / missing author via teammate lookup keyed on session userId
  if (requestUserId) {
    const lower = String(requestUserId).toLowerCase();
    const match = teammates.find((t) =>
      t.id === requestUserId ||
      t.agentId === requestUserId ||
      t.name?.toLowerCase() === lower ||
      t.email?.toLowerCase() === lower,
    );
    if (match?.name) return match.name;
    return String(requestUserId);
  }

  return 'Unknown';
}
