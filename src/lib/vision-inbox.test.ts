import { describe, it, expect } from 'vitest';
import {
  buildVisionInbox,
  resolveVisionOwner,
  resolveComponents,
  validateReplyRoute,
  type InboxProject,
  type InboxTask,
} from './vision-inbox';

const projects: InboxProject[] = [
  { id: 'proj-mc', name: 'Org Studio', visionOwner: 'Mikey', owner: 'Mikey', components: [{ name: 'Platform' }, { name: 'Tools' }] },
  { id: 'proj-voice', name: 'Voice', owner: 'Mikey', sections: [{ name: 'Calling' }] },
];

const tasks: InboxTask[] = [
  {
    id: 't1', projectId: 'proj-mc', ticketNumber: 1561, title: 'Version guard', status: 'done',
    comments: [
      { id: 'c1', author: 'Mikey', content: 'first', createdAt: 100 },
      { id: 'c2', author: 'Ana', content: 'second', createdAt: 300, mentions: ['Basil'] },
      { id: 'cs', author: 'system', content: 'reopened', createdAt: 200, type: 'system' },
    ],
  },
  {
    id: 't2', projectId: 'proj-mc', ticketNumber: 1555, title: 'Onboarding', status: 'in-progress',
    comments: [{ id: 'c3', author: 'Henry', content: 'routed to Sam', createdAt: 400 }],
  },
  // belongs to a DIFFERENT vision — must never appear in proj-mc feed
  {
    id: 't3', projectId: 'proj-voice', ticketNumber: 9, title: 'PSTN', status: 'blocked',
    comments: [{ id: 'c9', author: 'Mikey', content: 'other vision', createdAt: 999 }],
  },
  // malformed rows — must be skipped without throwing
  { id: '', projectId: 'proj-mc', comments: [{ id: 'x', author: 'z', content: 'orphan', createdAt: 1 }] } as any,
  { id: 't4', projectId: 'proj-mc', comments: 'not-an-array' as any },
];

describe('buildVisionInbox', () => {
  it('aggregates comments across all tickets of the vision, newest-first', () => {
    const r = buildVisionInbox('proj-mc', projects, tasks);
    expect(r.visionName).toBe('Org Studio');
    expect(r.owner).toBe('Mikey');
    expect(r.components).toEqual(['Platform', 'Tools']);
    // c3(400) > c2(300) > cs(200) > c1(100); c9 excluded (other vision)
    expect(r.items.map((i) => i.commentId)).toEqual(['c3', 'c2', 'cs', 'c1']);
    expect(r.items.find((i) => i.commentId === 'c9')).toBeUndefined();
  });

  it('stamps each feed item with its ticket metadata for reply-routing', () => {
    const r = buildVisionInbox('proj-mc', projects, tasks);
    const c2 = r.items.find((i) => i.commentId === 'c2')!;
    expect(c2.taskId).toBe('t1');
    expect(c2.ticketNumber).toBe(1561);
    expect(c2.ticketTitle).toBe('Version guard');
    expect(c2.mentions).toEqual(['Basil']);
  });

  it('can exclude system comments', () => {
    const r = buildVisionInbox('proj-mc', projects, tasks, { includeSystem: false });
    expect(r.items.find((i) => i.type === 'system')).toBeUndefined();
    expect(r.items.map((i) => i.commentId)).toEqual(['c3', 'c2', 'c1']);
  });

  it('summarizes tickets by recent activity and counts only contributing tickets', () => {
    const r = buildVisionInbox('proj-mc', projects, tasks);
    expect(r.ticketCount).toBe(2); // t1 + t2 contributed; t4 had no comments
    // t2 last activity 400 > t1 last activity 300 → t2 first
    expect(r.tickets.map((t) => t.taskId)).toEqual(['t2', 't1']);
    expect(r.tickets.find((t) => t.taskId === 't1')!.commentCount).toBe(3);
  });

  it('does not throw on malformed rows', () => {
    expect(() => buildVisionInbox('proj-mc', projects, tasks)).not.toThrow();
  });

  it('respects limit', () => {
    const r = buildVisionInbox('proj-mc', projects, tasks, { limit: 2 });
    expect(r.items.map((i) => i.commentId)).toEqual(['c3', 'c2']);
  });
});

describe('resolveVisionOwner / resolveComponents', () => {
  it('prefers visionOwner then owner', () => {
    expect(resolveVisionOwner(projects[0])).toBe('Mikey');
    expect(resolveVisionOwner({ id: 'x', owner: 'Ana' })).toBe('Ana');
    expect(resolveVisionOwner(undefined)).toBeNull();
  });
  it('falls back to sections when no components', () => {
    expect(resolveComponents(projects[1])).toEqual(['Calling']);
  });
});

describe('validateReplyRoute', () => {
  it('accepts a reply that names a ticket in the vision', () => {
    expect(validateReplyRoute('proj-mc', 't1', 'hi', tasks)).toEqual({ ok: true, taskId: 't1' });
  });
  it('rejects missing taskId', () => {
    const r = validateReplyRoute('proj-mc', undefined, 'hi', tasks);
    expect(r.ok).toBe(false);
  });
  it('rejects empty content', () => {
    const r = validateReplyRoute('proj-mc', 't1', '   ', tasks);
    expect(r.ok).toBe(false);
  });
  it('rejects a ticket from a different vision (cross-vision leak guard)', () => {
    const r = validateReplyRoute('proj-mc', 't3', 'hi', tasks);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/does not belong/);
  });
  it('rejects unknown ticket', () => {
    const r = validateReplyRoute('proj-mc', 'nope', 'hi', tasks);
    expect(r.ok).toBe(false);
  });
});
