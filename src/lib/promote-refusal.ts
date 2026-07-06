/**
 * #1646 — decide whether a promote/launch refusal should be surfaced to the
 * user who just changed a component's approval set.
 *
 * Background (2026-07-06 forensics): Basil approved 2026.09.01 via the
 * approval checkbox; `updateComponent` fired promoteProjectToNextVersion
 * fire-and-forget, the promote refused with `project inactive`, and the UI
 * showed nothing — silent no-op. The store route now awaits the promote and
 * returns its result; this helper is the single place that decides which
 * refusals are worth interrupting the user for.
 *
 * Rules:
 *  - Only surface when the user ADDED an approval (removing approvals is an
 *    intentional retraction — a refusal after that is expected).
 *  - Benign/expected refusals stay quiet:
 *      · 'no next planned version'  — approving ahead of time is normal;
 *        nothing is launchable yet and that's fine.
 *      · 'no versions approved'     — only reachable when the list is empty
 *        (a retraction), guarded above anyway.
 *  - Everything else is actionable and surfaces with the reason verbatim:
 *      · 'project inactive'                       (the #1646 incident)
 *      · 'not approved (...)'                      (approved a non-next version)
 *      · 'current version metric not met'          (#1263 outcome gate)
 *      · 'N items without taskId'                  (draft items)
 *      · 'No roadmap items in target version ...'
 *      · 'promote check failed: ...'               (substrate error)
 */

export interface PromoteOutcome {
  promoted: boolean;
  reason?: string | null;
  to?: string | null;
  movedTasks?: number;
}

const QUIET_REASONS = new Set([
  'no next planned version',
  'no versions approved',
]);

export interface SurfaceDecision {
  surface: boolean;
  message?: string;
}

export function shouldSurfacePromoteRefusal(
  previousApproved: string[],
  nextApproved: string[],
  outcome: PromoteOutcome | null | undefined,
): SurfaceDecision {
  // No promote ran (e.g. horizon unchanged) — nothing to say.
  if (!outcome) return { surface: false };
  // Promote succeeded — nothing to warn about.
  if (outcome.promoted) return { surface: false };

  // Only warn when the user ADDED an approval. Compare as sets so reorders
  // don't count as additions.
  const prev = new Set(previousApproved);
  const added = nextApproved.some((v) => !prev.has(v));
  if (!added) return { surface: false };

  const reason = (outcome.reason || '').trim();
  if (!reason || QUIET_REASONS.has(reason)) return { surface: false };

  return {
    surface: true,
    message: `Approved, but launch did not start: ${reason}`,
  };
}
