// #1192 \u2014 home Blockers filter: \"is this ticket waiting on a human?\"
//
// The home page Blockers section should only surface tickets that need
// attention from the human owner (currently Basil). Tickets that are blocked
// agent-on-agent (e.g. Billy QA-failed something to Trevor for a fix) live
// in the project board, not the home view.
//
// Authoritative signals on a Task:
//   - needsUserResponse: true  \u2192 needs the user, period
//   - awaitingResponseFrom: 'basil'  \u2192 explicit user mention
//   - awaitingResponseFrom: ['basil', \u2026]  \u2192 string[] form, same idea
//
// We match case-insensitively against a list of \"user names\" so this
// stays single-tenant-friendly today and easy to multi-tenant later.

export const DEFAULT_HUMAN_OWNERS = ['basil'];

function asArray(v: string | string[] | undefined | null): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

export function isAwaitingHumanResponse(
  task: { needsUserResponse?: boolean; awaitingResponseFrom?: string | string[] | null },
  humanOwners: string[] = DEFAULT_HUMAN_OWNERS
): boolean {
  if (task.needsUserResponse === true) return true;
  const targets = asArray(task.awaitingResponseFrom).map(s => s.toLowerCase().trim());
  if (targets.length === 0) return false;
  const owners = humanOwners.map(s => s.toLowerCase().trim());
  return targets.some(t => owners.includes(t));
}
