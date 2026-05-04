/**
 * #1218 — Canonicalize an assignee/author value against the teammates roster.
 *
 * Match keys (case-insensitive): teammate.id, teammate.agentId, teammate.name.
 * Canonical output is always teammate.name. The placeholder string "You"
 * (any case) maps to null so it never lands in storage. Empty/null input
 * also returns null. Unknown values pass through unchanged so external
 * humans (collaborators not in the roster) aren't rejected.
 */
export type TeammateLite = { id?: string; agentId?: string; name?: string };

export function canonicalizeTeammate(
  value: unknown,
  teammates: TeammateLite[] | null | undefined,
): string | null {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (raw.toLowerCase() === 'you') return null;

  const list = Array.isArray(teammates) ? teammates : [];
  const lc = raw.toLowerCase();
  for (const t of list) {
    if (!t) continue;
    if (
      t.id?.toLowerCase() === lc ||
      t.agentId?.toLowerCase() === lc ||
      t.name?.toLowerCase() === lc
    ) {
      return t.name || raw;
    }
  }
  // Pass-through: unknown values may be real humans not in the roster.
  return raw;
}
