/**
 * #1230 — buildLaunchMessage no longer drives the legacy Telegram
 * "Version Proposal" flow.
 *
 * These tests lock down the wake-message contract:
 *   - mentions project name + version
 *   - tells the agent to use the roadmap UI, not Telegram
 *   - does NOT instruct vision_approve/vision_reject button payloads
 *   - does NOT call /api/vision/{id}/propose or /complete
 *   - does NOT contain the legacy "Version Proposal" header
 */
import { describe, it, expect } from 'vitest';
import { buildLaunchMessage } from '@/lib/vision-cron';

function mkProject(overrides: any = {}) {
  return {
    id: 'proj-x',
    name: 'Project X',
    devOwner: 'Henry',
    owner: 'Henry',
    currentVersion: '0.2.0',
    sections: [],
    ...overrides,
  };
}

describe('buildLaunchMessage (#1230)', () => {
  // We don't set DATABASE_URL here, so loadVersionItemSummary returns []
  // and the message is the no-rv-row variant. That's the worst case and
  // the most important thing to lock down — the prompt mustn't drift back
  // into the old proposal flow even when there's no item context.

  it('mentions the project name and version', async () => {
    const msg = await buildLaunchMessage(mkProject());
    expect(msg).toContain('Project X');
    expect(msg).toContain('0.2.0');
  });

  it('does not contain the legacy "Version Proposal" header', async () => {
    const msg = await buildLaunchMessage(mkProject());
    expect(msg).not.toMatch(/Version Proposal/i);
  });

  it('does not instruct approve/reject Telegram callback payloads', async () => {
    const msg = await buildLaunchMessage(mkProject());
    expect(msg).not.toContain('vision_approve');
    expect(msg).not.toContain('vision_reject');
  });

  it('does not tell the agent to call /propose or /complete', async () => {
    const msg = await buildLaunchMessage(mkProject());
    expect(msg).not.toContain('/api/vision/proj-x/propose');
    expect(msg).not.toContain('/api/vision/proj-x/complete');
  });

  it('does not instruct sending Telegram side-channel messages', async () => {
    const msg = await buildLaunchMessage(mkProject());
    // The old prompt told the agent to call message(action="send", channel="telegram", ...)
    expect(msg).not.toMatch(/channel=["']telegram["']/);
    expect(msg).not.toMatch(/NOTIFY_CHAT_ID/);
  });

  it('points the agent at the Org Studio roadmap UI', async () => {
    const msg = await buildLaunchMessage(mkProject());
    expect(msg.toLowerCase()).toContain('roadmap');
    expect(msg).toContain('Org Studio');
  });

  it('handles missing currentVersion gracefully (no crash, marks unset)', async () => {
    const msg = await buildLaunchMessage(mkProject({ currentVersion: undefined }));
    expect(msg).toContain('(unset)');
  });
});
