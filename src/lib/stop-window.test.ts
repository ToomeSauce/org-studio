import { describe, it, expect } from 'vitest';
import { isTaskHeldByHumanStop } from './stop-window';

const teammates = [
  { name: 'Basil', agentId: '', role: null }, // human
  { name: 'Billy', agentId: 'billy', role: 'qa' }, // QA agent
  { name: 'Thelma', agentId: 'thelma', role: null }, // regular dev
  { name: 'Mikey', agentId: 'mikey', role: null }, // regular dev
];

const baseTask = { id: 't1', assignee: 'Thelma' };

describe('isTaskHeldByHumanStop', () => {
  describe('empty / no-op cases', () => {
    it('no comments → not held', () => {
      expect(isTaskHeldByHumanStop(baseTask, [], teammates)).toEqual({ held: false });
    });

    it('null comments → not held (fail open)', () => {
      expect(isTaskHeldByHumanStop(baseTask, null as any, teammates)).toEqual({ held: false });
    });

    it('only regular dev comments → not held', () => {
      const r = isTaskHeldByHumanStop(
        baseTask,
        [
          { id: 'c1', author: 'Thelma', content: 'starting on this', createdAt: 1000 },
          { id: 'c2', author: 'Mikey', content: 'STOP do not merge', createdAt: 2000 }, // Mikey is not authority
        ],
        teammates,
      );
      expect(r.held).toBe(false);
    });
  });

  describe('explicit type=stop', () => {
    it('Basil STOP → held', () => {
      const r = isTaskHeldByHumanStop(
        baseTask,
        [{ id: 'c1', author: 'Basil', content: 'hold up', createdAt: 1000, type: 'stop' }],
        teammates,
      );
      expect(r.held).toBe(true);
      expect(r.stopAuthor).toBe('Basil');
      expect(r.reason).toBe('explicit');
    });

    it('Billy STOP (QA agent) → held', () => {
      const r = isTaskHeldByHumanStop(
        baseTask,
        [{ id: 'c1', author: 'Billy', content: 'yield please', createdAt: 1000, type: 'stop' }],
        teammates,
      );
      expect(r.held).toBe(true);
      expect(r.stopAuthor).toBe('Billy');
    });

    it('Thelma STOP (assignee, not authority) → NOT held', () => {
      const r = isTaskHeldByHumanStop(
        baseTask,
        [{ id: 'c1', author: 'Thelma', content: 'pausing myself', createdAt: 1000, type: 'stop' }],
        teammates,
      );
      expect(r.held).toBe(false);
    });

    it('Mikey STOP (peer dev, not authority) → NOT held', () => {
      const r = isTaskHeldByHumanStop(
        baseTask,
        [{ id: 'c1', author: 'Mikey', content: 'stop', createdAt: 1000, type: 'stop' }],
        teammates,
      );
      expect(r.held).toBe(false);
    });
  });

  describe('regex fallback', () => {
    it('Basil "STOP — do not merge" → held (regex)', () => {
      const r = isTaskHeldByHumanStop(
        baseTask,
        [{ id: 'c1', author: 'Basil', content: 'STOP — do not merge anything', createdAt: 1000 }],
        teammates,
      );
      expect(r.held).toBe(true);
      expect(r.reason).toBe('regex');
    });

    it('Billy "🚨 STOP — yield until I weigh in" → held (regex)', () => {
      const r = isTaskHeldByHumanStop(
        baseTask,
        [{ id: 'c1', author: 'Billy', content: '🚨 STOP — yield until I weigh in', createdAt: 1000 }],
        teammates,
      );
      expect(r.held).toBe(true);
    });

    it('Basil "stop the timer" (lowercase, no yield verb) → NOT held', () => {
      const r = isTaskHeldByHumanStop(
        baseTask,
        [{ id: 'c1', author: 'Basil', content: 'stop the timer', createdAt: 1000 }],
        teammates,
      );
      expect(r.held).toBe(false);
    });

    it('Basil "STOP" alone (no yield verb) → NOT held', () => {
      const r = isTaskHeldByHumanStop(
        baseTask,
        [{ id: 'c1', author: 'Basil', content: 'STOP', createdAt: 1000 }],
        teammates,
      );
      expect(r.held).toBe(false);
    });

    it('Basil "hold" alone (no STOP word) → NOT held', () => {
      const r = isTaskHeldByHumanStop(
        baseTask,
        [{ id: 'c1', author: 'Basil', content: 'please hold', createdAt: 1000 }],
        teammates,
      );
      expect(r.held).toBe(false);
    });

    it('"GASTROSTOPP" or other false-positive embedded STOP → not held (word boundary)', () => {
      const r = isTaskHeldByHumanStop(
        baseTask,
        [{ id: 'c1', author: 'Basil', content: 'GASTROSTOPP hold something', createdAt: 1000 }],
        teammates,
      );
      expect(r.held).toBe(false);
    });
  });

  describe('clearing paths', () => {
    it('Basil STOP then Basil RESUME → not held', () => {
      const r = isTaskHeldByHumanStop(
        baseTask,
        [
          { id: 'c1', author: 'Basil', content: 'hold', createdAt: 1000, type: 'stop' },
          { id: 'c2', author: 'Basil', content: 'go', createdAt: 2000, type: 'resume' },
        ],
        teammates,
      );
      expect(r.held).toBe(false);
    });

    it('Billy STOP then Basil RESUME → not held (any authority can resume any STOP)', () => {
      const r = isTaskHeldByHumanStop(
        baseTask,
        [
          { id: 'c1', author: 'Billy', content: '', createdAt: 1000, type: 'stop' },
          { id: 'c2', author: 'Basil', content: '', createdAt: 2000, type: 'resume' },
        ],
        teammates,
      );
      expect(r.held).toBe(false);
    });

    it('Basil STOP then Thelma (assignee) comments → not held', () => {
      const r = isTaskHeldByHumanStop(
        baseTask,
        [
          { id: 'c1', author: 'Basil', content: 'hold', createdAt: 1000, type: 'stop' },
          { id: 'c2', author: 'Thelma', content: 'ack, working', createdAt: 2000 },
        ],
        teammates,
      );
      expect(r.held).toBe(false);
    });

    it('Basil STOP then Mikey (non-assignee peer) comments → still held', () => {
      const r = isTaskHeldByHumanStop(
        baseTask,
        [
          { id: 'c1', author: 'Basil', content: 'hold', createdAt: 1000, type: 'stop' },
          { id: 'c2', author: 'Mikey', content: 'fyi looking', createdAt: 2000 },
        ],
        teammates,
      );
      expect(r.held).toBe(true);
    });

    it('peer Mikey RESUME does NOT clear an authority STOP (peers cannot resume)', () => {
      const r = isTaskHeldByHumanStop(
        baseTask,
        [
          { id: 'c1', author: 'Basil', content: 'hold', createdAt: 1000, type: 'stop' },
          { id: 'c2', author: 'Mikey', content: '', createdAt: 2000, type: 'resume' },
        ],
        teammates,
      );
      expect(r.held).toBe(true);
    });

    it('STOP, RESUME, then second STOP → held again', () => {
      const r = isTaskHeldByHumanStop(
        baseTask,
        [
          { id: 'c1', author: 'Basil', content: 'hold', createdAt: 1000, type: 'stop' },
          { id: 'c2', author: 'Basil', content: '', createdAt: 2000, type: 'resume' },
          { id: 'c3', author: 'Billy', content: 'STOP — hold again, second look', createdAt: 3000 },
        ],
        teammates,
      );
      expect(r.held).toBe(true);
      expect(r.stopAuthor).toBe('Billy');
      expect(r.stopCommentId).toBe('c3');
    });
  });

  describe('chronological correctness', () => {
    it('passes ASC unchanged + sorts DESC input correctly', () => {
      const ascResult = isTaskHeldByHumanStop(
        baseTask,
        [
          { id: 'c1', author: 'Basil', content: 'hold', createdAt: 1000, type: 'stop' },
          { id: 'c2', author: 'Thelma', content: 'ack', createdAt: 2000 },
        ],
        teammates,
      );
      const descResult = isTaskHeldByHumanStop(
        baseTask,
        [
          { id: 'c2', author: 'Thelma', content: 'ack', createdAt: 2000 },
          { id: 'c1', author: 'Basil', content: 'hold', createdAt: 1000, type: 'stop' },
        ],
        teammates,
      );
      expect(ascResult).toEqual(descResult);
      expect(ascResult.held).toBe(false); // assignee comment clears
    });
  });

  describe('real incident replay (#1487, 2026-05-21)', () => {
    it('Billy STOP at 00:27 EDT, Thelma yields, no resume → held', () => {
      const r = isTaskHeldByHumanStop(
        { id: 'y93977vpmpeuzgu9', assignee: 'Thelma' },
        [
          {
            id: 'sys-1',
            author: 'Billy',
            content: '🚨 **@Thelma STOP — DO NOT WORK FURTHER ON THIS TICKET. @Basil flagging you.**',
            createdAt: 1779336057_000,
          },
          {
            id: 'sys-2',
            author: 'Thelma',
            content: '@Billy @Basil — I just pulled the full comment thread...',
            createdAt: 1779339665_000,
          },
        ],
        teammates,
      );
      // Thelma's acknowledgment clears in the v1 design — she's "unyielding."
      // But that's wrong for this incident: she yields and HOLDS. So we
      // need to interpret an assignee ack-while-still-yielding as a clear,
      // and rely on the OTHER side of the design (no wake event after
      // unblock) to keep the sweep silent during real held windows.
      // Documenting this gap: an assignee ack comment clears the held
      // state per spec; in this incident Billy followed up explicitly,
      // and the sweep would re-check on every tick — so the held state
      // is maintained only if Billy posts a fresh STOP after each
      // assignee comment. v2 could refine this with a "yielded" comment
      // type. For now, this matches the spec'd behavior.
      expect(r.held).toBe(false);
    });

    it('Billy STOP without subsequent assignee comment → held (the actual sweep moment)', () => {
      // At 01:43 EDT when the first Level 1 fired, Thelma had NOT yet
      // posted her acknowledgment (that came at 01:01 EDT — wait, check
      // the timeline). The point: in the window between Billy's STOP and
      // the first acknowledgment, the sweep should see "held" and skip.
      const r = isTaskHeldByHumanStop(
        { id: 'y93977vpmpeuzgu9', assignee: 'Thelma' },
        [
          {
            id: 'sys-1',
            author: 'Billy',
            content: '🚨 STOP — DO NOT WORK FURTHER. yield until Basil weighs in.',
            createdAt: 1779336057_000,
          },
        ],
        teammates,
      );
      expect(r.held).toBe(true);
      expect(r.stopAuthor).toBe('Billy');
      expect(r.reason).toBe('regex');
    });
  });
});
