/**
 * #1246 — Tests verifying that the task assignee is auto-notified on every
 * comment, regardless of whether they were @mentioned.
 *
 * Reported by Basil 2026-05-06: "@ mentions are required for notifications -
 * but should not be required for every subsequent comment. For every comment
 * added, the owner of ticket should be automatically notified."
 *
 * Confirms the existing notification-router behavior for the task scope:
 *   - assignee (owner) is added to recipients without an @mention,
 *   - @mentioned teammates are still notified (additive, not exclusive),
 *   - the owner is not double-notified when also @mentioned in the same comment,
 *   - the comment author is not self-notified (suppression),
 *   - human teammates remain skipped (they see comments in the UI / Telegram).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the delivery layer so tests don't reach out to runtimes.
const sentMessages: Array<{ agentId: string; message: string; idempotencyKey?: string }> = [];
vi.mock('@/lib/runtimes/registry', () => ({
  sendToAgent: vi.fn(async (agentId: string, message: string, opts: any) => {
    sentMessages.push({ agentId, message, idempotencyKey: opts?.idempotencyKey });
  }),
}));
vi.mock('@/lib/gateway-rpc', () => ({
  rpc: vi.fn(async () => undefined),
}));

import { routeCommentNotifications, _resetDedupCache } from './notification-router';
import type { Teammate } from './mentions';

const teammates: Teammate[] = [
  { id: 'b', name: 'Basil', agentId: '', isHuman: true },
  { id: 'h', name: 'Henry', agentId: 'main', isHuman: false },
  { id: 'm', name: 'Mikey', agentId: 'mikey', isHuman: false },
  { id: 'a', name: 'Ana', agentId: 'ana', isHuman: false },
];

const baseTask = { id: 't-1', title: 'Test task', projectId: 'proj-org-studio', assignee: 'Mikey' };

beforeEach(() => {
  sentMessages.length = 0;
  _resetDedupCache();
});

describe('#1246 — auto-notify ticket owner on every comment', () => {
  it('notifies the assignee when a human comments without any @mention', async () => {
    const res = await routeCommentNotifications({
      comment: { id: 'c-1', author: 'Basil', content: 'looks good, ship it' },
      scope: { kind: 'task', taskId: baseTask.id },
      teammates,
      context: { task: baseTask },
    });
    expect(res.notified).toContain('mikey');
    expect(sentMessages.map((m) => m.agentId)).toEqual(['mikey']);
  });

  it('notifies the assignee when another agent comments without an @mention', async () => {
    const res = await routeCommentNotifications({
      comment: { id: 'c-2', author: 'Henry', content: 'fyi rebased' },
      scope: { kind: 'task', taskId: baseTask.id },
      teammates,
      context: { task: baseTask },
    });
    expect(res.notified).toContain('mikey');
  });

  it('still notifies @mentioned teammates IN ADDITION to the owner', async () => {
    const res = await routeCommentNotifications({
      comment: { id: 'c-3', author: 'Basil', content: 'cc @ana for review' },
      scope: { kind: 'task', taskId: baseTask.id },
      teammates,
      context: { task: baseTask },
    });
    expect(new Set(res.notified)).toEqual(new Set(['mikey', 'ana']));
  });

  it('does NOT double-notify when the owner is also @mentioned (single delivery)', async () => {
    const res = await routeCommentNotifications({
      comment: { id: 'c-4', author: 'Basil', content: '@mikey thoughts?' },
      scope: { kind: 'task', taskId: baseTask.id },
      teammates,
      context: { task: baseTask },
    });
    expect(res.notified).toEqual(['mikey']);
    // Exactly one delivery call to mikey
    expect(sentMessages.filter((m) => m.agentId === 'mikey').length).toBe(1);
  });

  it('does NOT self-notify when the comment author is the owner', async () => {
    const res = await routeCommentNotifications({
      comment: { id: 'c-5', author: 'Mikey', content: 'self note while working' },
      scope: { kind: 'task', taskId: baseTask.id },
      teammates,
      context: { task: baseTask },
    });
    expect(res.notified).not.toContain('mikey');
    expect(res.skipped.find((s) => s.agentId === 'mikey')?.reason).toBe('self');
  });

  it('does NOT notify a human assignee via the agent router (Telegram path handles humans)', async () => {
    const humanAssigneeTask = { ...baseTask, assignee: 'Basil' };
    const res = await routeCommentNotifications({
      comment: { id: 'c-6', author: 'Mikey', content: 'pushed' },
      scope: { kind: 'task', taskId: humanAssigneeTask.id },
      teammates,
      context: { task: humanAssigneeTask },
    });
    expect(res.notified).toEqual([]);
    // Basil's empty agentId would resolve via the teammate; the human-skip path
    // should kick in. Either way, no agent delivery.
    expect(sentMessages).toEqual([]);
  });

  it('handles a task with no assignee gracefully (no recipients, no error)', async () => {
    const orphan = { ...baseTask, assignee: undefined };
    const res = await routeCommentNotifications({
      comment: { id: 'c-7', author: 'Basil', content: 'who owns this?' },
      scope: { kind: 'task', taskId: orphan.id },
      teammates,
      context: { task: orphan },
    });
    expect(res.notified).toEqual([]);
    expect(sentMessages).toEqual([]);
  });

  it('still resolves the assignee when the assignee field carries different casing', async () => {
    const lowerCased = { ...baseTask, assignee: 'mikey' };
    const res = await routeCommentNotifications({
      comment: { id: 'c-8', author: 'Basil', content: 'hey' },
      scope: { kind: 'task', taskId: lowerCased.id },
      teammates,
      context: { task: lowerCased },
    });
    expect(res.notified).toContain('mikey');
  });

  // #1262 — the assignee envelope must read like the rich "reply on the
  // task" mention envelope, not a one-line snippet, OR Basil keeps having
  // to @mention us to get a reply.
  it('uses the rich "reply on the task" envelope for assignee-only deliveries', async () => {
    sentMessages.length = 0;
    await routeCommentNotifications({
      comment: { id: 'c-rich-asg', author: 'Basil', content: 'follow-up question' },
      scope: { kind: 'task', taskId: baseTask.id },
      teammates,
      context: { task: baseTask },
    });
    const sent = sentMessages.find((m) => m.agentId === 'mikey');
    expect(sent, 'no delivery to mikey').toBeTruthy();
    expect(sent!.message).toMatch(/commented on your task/);
    expect(sent!.message).toMatch(/Reply on the task, not in chat/);
    expect(sent!.message).toMatch(/Task ID: t-1/);
  });

  it('uses "mentioned you" wording when the recipient is also @mentioned', async () => {
    sentMessages.length = 0;
    await routeCommentNotifications({
      comment: { id: 'c-rich-mnt', author: 'Basil', content: '@mikey thoughts?' },
      scope: { kind: 'task', taskId: baseTask.id },
      teammates,
      context: { task: baseTask },
    });
    const sent = sentMessages.find((m) => m.agentId === 'mikey');
    expect(sent, 'no delivery to mikey').toBeTruthy();
    expect(sent!.message).toMatch(/mentioned you on task/);
    expect(sent!.message).not.toMatch(/commented on your task/);
  });

  it('reproduces the #1246 follow-up case: 2nd comment without @mention still notifies owner', async () => {
    // First comment with @mention — works today.
    await routeCommentNotifications({
      comment: { id: 'c-9a', author: 'Basil', content: 'started @mikey' },
      scope: { kind: 'task', taskId: baseTask.id },
      teammates,
      context: { task: baseTask },
    });
    // Second comment WITHOUT @mention — Basil's bug report says owner went silent.
    // Expected (post-fix): owner is still notified.
    const second = await routeCommentNotifications({
      comment: { id: 'c-9b', author: 'Basil', content: 'follow-up question — what about edge X?' },
      scope: { kind: 'task', taskId: baseTask.id },
      teammates,
      context: { task: baseTask },
    });
    expect(second.notified).toContain('mikey');
  });
});

/**
 * #1268 — cross-process auto-notify (the cousin of #1246).
 *
 * The router-level contract was already covered by #1246 tests above; this
 * block locks in the two NEW behaviors added in #1268:
 *   1. System comments (auto-generated, e.g. status-rewind reasons) MUST
 *      NOT trigger any agent notifications.
 *   2. Done-when #5: addComment with no @mention results in a chat.send
 *      call to the assignee — reasserted at the unit-test layer because
 *      the bridge endpoint /api/notify/comment is just a thin wrapper
 *      around the same `routeCommentNotifications` call.
 */
describe('#1268 — auto-notify dev owner on every (non-system) ticket comment', () => {
  it('done-when #5: addComment with no @mention triggers chat.send to the assignee', async () => {
    sentMessages.length = 0;
    const res = await routeCommentNotifications({
      comment: { id: '1268-a', author: 'Basil', content: 'how is this coming along?' },
      scope: { kind: 'task', taskId: baseTask.id },
      teammates,
      context: { task: baseTask },
    });
    expect(res.notified).toEqual(['mikey']);
    expect(sentMessages.filter((m) => m.agentId === 'mikey').length).toBe(1);
    // Same envelope shape Basil already gets for @mention notifications.
    expect(sentMessages[0].message).toMatch(/Reply on the task, not in chat/);
  });

  it('done-when #2: system comments do NOT trigger any notification', async () => {
    sentMessages.length = 0;
    const res = await routeCommentNotifications({
      comment: {
        id: '1268-sys',
        author: 'system',
        content: 'Reopened by Basil: scope changed',
        type: 'system',
      },
      scope: { kind: 'task', taskId: baseTask.id },
      teammates,
      context: { task: baseTask },
    });
    expect(res.notified).toEqual([]);
    expect(res.skipped).toEqual([]);
    expect(sentMessages).toEqual([]);
  });

  it('done-when #2 (regression): non-system comments still notify when type is explicit "comment"', async () => {
    sentMessages.length = 0;
    const res = await routeCommentNotifications({
      comment: {
        id: '1268-explicit',
        author: 'Basil',
        content: 'ping',
        type: 'comment',
      },
      scope: { kind: 'task', taskId: baseTask.id },
      teammates,
      context: { task: baseTask },
    });
    expect(res.notified).toContain('mikey');
  });
});
