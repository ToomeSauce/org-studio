/**
 * Direct Message helpers for v0.13
 *
 * Thread IDs are deterministic: sorted participant IDs joined with "::" prefix.
 * This means the same two people always produce the same thread ID, regardless
 * of who initiates the conversation.
 *
 * v0.13 constraints:
 * - 2-person DMs only (no group DMs)
 * - No real auth — hardcoded current user ID
 * - No read receipts, typing indicators
 */

// TODO: Replace with real auth integration. For v0.13, all DM threads include 'you'
// as one participant. This works for single-user access.
export const CURRENT_USER_ID = 'you';

/**
 * Compute a deterministic DM thread ID from participant IDs.
 * Always sorts participant IDs alphabetically so both sides compute the same ID.
 *
 * @param participantIds - Array of exactly 2 participant IDs
 * @returns Thread ID in format `dm::<id1>::<id2>` (sorted)
 * @throws if not exactly 2 participants
 */
export function computeDmThreadId(participantIds: string[]): string {
  if (participantIds.length !== 2) {
    throw new Error(`DM threads require exactly 2 participants, got ${participantIds.length}`);
  }
  const sorted = [...participantIds].sort();
  return `dm::${sorted[0]}::${sorted[1]}`;
}

/**
 * Extract participant IDs from a DM thread ID.
 *
 * @param threadId - Thread ID in format `dm::<id1>::<id2>`
 * @returns Array of 2 participant IDs
 */
export function extractParticipants(threadId: string): [string, string] {
  const parts = threadId.split('::');
  if (parts.length !== 3 || parts[0] !== 'dm') {
    throw new Error(`Invalid DM thread ID: ${threadId}`);
  }
  return [parts[1], parts[2]];
}

/**
 * Get the "other" participant in a DM thread (i.e., not the current user).
 *
 * @param threadId - Thread ID
 * @param currentUserId - The current user's ID
 * @returns The other participant's ID
 */
export function getOtherParticipant(threadId: string, currentUserId: string = CURRENT_USER_ID): string {
  const [a, b] = extractParticipants(threadId);
  return a === currentUserId ? b : a;
}
