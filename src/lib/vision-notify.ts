/**
 * vision-notify.ts
 *
 * Telegram nudge helpers for the version-shipped flow (#1191).
 *
 * History: this file used to host `sendVersionProposal` and
 * `sendVersionComplete`, which drove a Telegram-based approve/reject loop
 * for AI-generated version proposals. That flow was retired in favor of
 * roadmap-level approvedVersions[] checkboxes in the Org Studio UI; the
 * dead helpers were removed in #1230.
 */

import { rpc } from './gateway-rpc';

// ---------- Version-shipped nudge (#1191) ----------

/**
 * Build the version-shipped nudge message.
 *
 * Pure helper, exposed for tests. Format per spec/2026-05-03 ticket G:
 *   "✅ v0.4.1 shipped on Org Studio. Approve next?"
 *
 * Versions are rendered as-is (already semver per the v0.16 migration).
 */
export function buildVersionShippedMessage(projectName: string, version: string): string {
  return `✅ v${version} shipped on ${projectName}. Approve next?`;
}

/**
 * Resolve the vision owner's agentId from a teammates list.
 * Display name OR agentId match (case-insensitive). Mirrors the
 * resolveTeammate helper in notification-router.
 */
export function resolveVisionOwnerAgentId(
  visionOwner: string | undefined,
  teammates: Array<{ name?: string; agentId?: string }> | undefined,
): string | null {
  if (!visionOwner) return null;
  const list = teammates || [];
  const lower = visionOwner.toLowerCase();
  const hit = list.find((t) => {
    return (
      t.agentId?.toLowerCase() === lower ||
      t.name?.toLowerCase() === lower
    );
  });
  return hit?.agentId || null;
}

/**
 * Send a Telegram nudge to the vision owner when a roadmap version flips
 * to status='shipped'. One per shipped version (idempotency key includes
 * project + version, so even if checkAndAutoAdvance runs twice on the
 * same flip the user only gets one ping).
 *
 * Failure is non-fatal — the version stays shipped, we just log.
 */
export async function sendVersionShippedNudge(
  project: { id: string; name: string; visionOwner?: string },
  version: string,
  teammates: Array<{ name?: string; agentId?: string }>,
): Promise<void> {
  try {
    const agentId = resolveVisionOwnerAgentId(project.visionOwner, teammates);
    if (!agentId) {
      console.log(
        `[VersionNudge] ${project.id}: no resolvable vision owner for "${project.visionOwner}" — skipping nudge for ${version}`,
      );
      return;
    }
    const message = buildVersionShippedMessage(project.name, version);
    await rpc('chat.send', {
      sessionKey: `agent:${agentId}:main`,
      message,
      idempotencyKey: `version-shipped:${project.id}:${version}`,
    });
    console.log(
      `[VersionNudge] ${project.id}: nudged ${agentId} for ${version}`,
    );
  } catch (e) {
    console.error('[Vision Notify] Failed to send version-shipped nudge:', e);
  }
}
