/**
 * #1513 — Tests for the recency-tracker helper used by the comment
 * notification bridge.
 *
 * The bridge route (/api/notify/comment) calls this to pre-compute a
 * Map<agentId, lastReplyCreatedAt> for the source task, which the
 * notification router uses to suppress stale-on-arrival deliveries
 * ("you already replied to this comment 8 minutes ago").
 */
import { describe, it, expect } from 'vitest';
import { computeRecipientLastReplies } from './notification-recency';
import type { RecencyTeammate, RecencyTask } from './notification-recency';

const teammates: RecencyTeammate[] = [
  { id: 'b', name: 'Basil', agentId: '', isHuman: true },
  { id: 'h', name: 'Henry', agentId: 'main', isHuman: false },
  { id: 'm', name: 'Mikey', agentId: 'mikey', isHuman: false },
  { id: 'a', name: 'Ana', agentId: 'ana', isHuman: false },
];

describe('#1513 — computeRecipientLastReplies', () => {
  it('returns undefined for a task with no comments', () => {
    const task: RecencyTask = { comments: [] };
    const out = computeRecipientLastReplies(task, teammates, { id: 'src' });
    expect(out).toBeUndefined();
  });

  it('returns undefined for null/undefined task input', () => {
    expect(computeRecipientLastReplies(null, teammates, null)).toBeUndefined();
    expect(computeRecipientLastReplies(undefined, teammates, null)).toBeUndefined();
  });

  it('builds map with one entry per agent author, latest timestamp wins', () => {
    const task: RecencyTask = {
      comments: [
        { id: 'c1', author: 'Mikey', createdAt: 1000 },
        { id: 'c2', author: 'Mikey', createdAt: 3000 }, // newer — should win
        { id: 'c3', author: 'Mikey', createdAt: 2000 }, // older — ignored
        { id: 'c4', author: 'Ana', createdAt: 1500 },
        { id: 'c5', author: 'Henry', createdAt: 2500 },
      ],
    };
    const out = computeRecipientLastReplies(task, teammates, { id: 'src' });
    expect(out).toBeDefined();
    expect(out!.get('mikey')).toBe(3000);
    expect(out!.get('ana')).toBe(1500);
    expect(out!.get('main')).toBe(2500);
    expect(out!.size).toBe(3);
  });

  it('excludes the source comment itself (by id)', () => {
    const task: RecencyTask = {
      comments: [
        { id: 'src', author: 'Mikey', createdAt: 5000 }, // source — must be excluded
        { id: 'c2', author: 'Mikey', createdAt: 2000 },
      ],
    };
    const out = computeRecipientLastReplies(task, teammates, { id: 'src' });
    expect(out!.get('mikey')).toBe(2000);
  });

  it('skips system comments (they are not "replies")', () => {
    const task: RecencyTask = {
      comments: [
        { id: 'c1', author: 'system', type: 'system', createdAt: 9000 },
        { id: 'c2', author: 'Mikey', createdAt: 1000 },
      ],
    };
    const out = computeRecipientLastReplies(task, teammates, { id: 'src' });
    expect(out!.get('mikey')).toBe(1000);
    expect(out!.size).toBe(1);
  });

  it('skips human authors (Basil — they don\'t get router-paged)', () => {
    const task: RecencyTask = {
      comments: [
        { id: 'c1', author: 'Basil', createdAt: 5000 },
        { id: 'c2', author: 'Mikey', createdAt: 1000 },
      ],
    };
    const out = computeRecipientLastReplies(task, teammates, { id: 'src' });
    expect(out!.has('b')).toBe(false);
    expect(out!.get('mikey')).toBe(1000);
  });

  it('skips comments missing createdAt or with createdAt <= 0', () => {
    const task: RecencyTask = {
      comments: [
        { id: 'c1', author: 'Mikey' /* no createdAt */ },
        { id: 'c2', author: 'Ana', createdAt: 0 },
        { id: 'c3', author: 'Henry', createdAt: 1234 },
      ],
    };
    const out = computeRecipientLastReplies(task, teammates, { id: 'src' });
    expect(out!.has('mikey')).toBe(false);
    expect(out!.has('ana')).toBe(false);
    expect(out!.get('main')).toBe(1234);
  });

  it('resolves authors case-insensitively', () => {
    const task: RecencyTask = {
      comments: [
        { id: 'c1', author: 'MIKEY', createdAt: 1000 },
        { id: 'c2', author: 'mikey', createdAt: 2000 },
      ],
    };
    const out = computeRecipientLastReplies(task, teammates, { id: 'src' });
    expect(out!.get('mikey')).toBe(2000);
  });

  it('resolves by agentId as well as name', () => {
    const task: RecencyTask = {
      comments: [
        { id: 'c1', author: 'ana', createdAt: 1000 }, // matches Ana.name OR Ana.agentId
        { id: 'c2', author: 'main', createdAt: 2000 }, // matches Henry.agentId
      ],
    };
    const out = computeRecipientLastReplies(task, teammates, { id: 'src' });
    expect(out!.get('ana')).toBe(1000);
    expect(out!.get('main')).toBe(2000);
  });

  it('returns undefined when no usable entries survive filtering', () => {
    const task: RecencyTask = {
      comments: [
        { id: 'c1', author: 'Basil', createdAt: 1000 }, // human
        { id: 'c2', author: 'system', type: 'system', createdAt: 2000 }, // system
        { id: 'c3', author: 'Unknown', createdAt: 3000 }, // unresolvable
      ],
    };
    const out = computeRecipientLastReplies(task, teammates, { id: 'src' });
    expect(out).toBeUndefined();
  });

  it('the requirement-5 case: 3 prior comments by different authors → map has all three latest', () => {
    const task: RecencyTask = {
      comments: [
        { id: 'c-old-mikey', author: 'Mikey', createdAt: 100 },
        { id: 'c-mikey', author: 'Mikey', createdAt: 1100 },
        { id: 'c-ana', author: 'Ana', createdAt: 1200 },
        { id: 'c-henry', author: 'Henry', createdAt: 1300 },
        { id: 'src', author: 'Basil', createdAt: 2000 }, // source — excluded
      ],
    };
    const out = computeRecipientLastReplies(task, teammates, { id: 'src' });
    expect(out!.size).toBe(3);
    expect(out!.get('mikey')).toBe(1100);
    expect(out!.get('ana')).toBe(1200);
    expect(out!.get('main')).toBe(1300);
  });
});
