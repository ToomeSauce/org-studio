// #1381 — server-rendered (#NNN) suffix on roadmap items.
//
// Background: historically callers manually appended `(#NNN)` to the stored
// item.title string whenever they linked a planning ticket. That's
// client-side denormalization — every integration has to remember to do it,
// and if a ticketNumber ever changed (it shouldn't but) the stored title
// goes stale.
//
// GET /api/roadmap/{projectId} now returns items with two derived fields:
//   - taskTicketNumber: number — the ticketNumber of the linked task
//   - displayTitle: string — title with `(#NNN)` rendered, stripping any
//     already-baked `(#NNN)` suffix from the stored title to avoid double-
//     rendering during the migration window
//
// UI render sites should call `roadmapItemDisplayTitle(item)` instead of
// reading `item.title` directly. This helper is the single source of truth
// for the display string and gracefully falls back to the stored title for
// older API responses that don't yet include the derived fields.

export type RoadmapItemLike = {
  title?: string;
  taskId?: string | null;
  taskTicketNumber?: number;
  displayTitle?: string;
};

/**
 * Returns the display string for a roadmap item title, including the
 * `(#NNN)` suffix when a ticket is linked.
 *
 * Order of preference:
 *   1. `displayTitle` from the API (server-rendered, suffix-stripped)
 *   2. stored `title` + ` (#NNN)` if we have `taskTicketNumber` (client-side
 *      fallback in case an older API response didn't include displayTitle)
 *   3. stored `title` as-is (no ticket linked, or no number available)
 *
 * Step 2 also strips any already-baked `(#NNN)` from the stored title so
 * we don't render `Foo (#577) (#577)` for legacy items.
 */
export function roadmapItemDisplayTitle(item: RoadmapItemLike | null | undefined): string {
  if (!item) return '';
  if (typeof item.displayTitle === 'string' && item.displayTitle.length > 0) {
    return item.displayTitle;
  }
  const raw = typeof item.title === 'string' ? item.title : '';
  if (typeof item.taskTicketNumber === 'number') {
    const base = raw.replace(/\s*\(#\d+\)\s*$/, '');
    return base ? `${base} (#${item.taskTicketNumber})` : `(#${item.taskTicketNumber})`;
  }
  return raw;
}

/**
 * Returns the stored title with any `(#NNN)` suffix stripped. Used by edit
 * UIs (inputs, modals) so the user is editing the raw title, not the
 * rendered string.
 */
export function roadmapItemEditableTitle(item: RoadmapItemLike | null | undefined): string {
  if (!item || typeof item.title !== 'string') return '';
  return item.title.replace(/\s*\(#\d+\)\s*$/, '');
}
