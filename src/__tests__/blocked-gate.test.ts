import { describe, it, expect } from 'vitest';
import {
  evaluateBlockedGate,
  buildBounceMantra,
  BLOCK_TYPES,
} from '@/lib/blocked-gate';

// #1588 — Blocked Gate. Pure decision logic for transitions INTO `blocked`.
// The route applies the decision; this exercises every branch.
describe('evaluateBlockedGate (#1588)', () => {
  const base = { id: 'task-1', ticketNumber: 1588, status: 'in-progress', assignee: 'Mikey' };

  describe('self-guard', () => {
    it('allows when not transitioning into blocked', () => {
      const d = evaluateBlockedGate({ task: base, updates: { status: 'done' } });
      expect(d.kind).toBe('allow');
    });

    it('allows when already blocked (no real transition)', () => {
      const d = evaluateBlockedGate({
        task: { ...base, status: 'blocked' },
        updates: { status: 'blocked' },
      });
      expect(d.kind).toBe('allow');
    });
  });

  describe('dependency blocks (#1102 case-a) pass through untouched', () => {
    it('allows a blockedBy[] dependency block even with no reason/type', () => {
      const d = evaluateBlockedGate({
        task: base,
        updates: { status: 'blocked', blockedBy: [1600] },
      });
      expect(d.kind).toBe('allow');
    });

    it('allows when blockedBy[] is already present on the task', () => {
      const d = evaluateBlockedGate({
        task: { ...base, blockedBy: [1601] },
        updates: { status: 'blocked' },
      });
      expect(d.kind).toBe('allow');
    });

    it('does NOT treat an empty blockedBy[] as a dependency block', () => {
      const d = evaluateBlockedGate({
        task: { ...base, blockedBy: [] },
        updates: { status: 'blocked' },
      });
      // empty array → falls through to reason/type gate → reject (no reason)
      expect(d.kind).toBe('reject');
    });
  });

  describe('reason requirement (#1138)', () => {
    it('rejects (400) when no blockedReason anywhere', () => {
      const d = evaluateBlockedGate({
        task: base,
        updates: { status: 'blocked', blockedReasonType: 'irreversible-decision' },
      });
      expect(d.kind).toBe('reject');
      if (d.kind === 'reject') {
        expect(d.status).toBe(400);
        expect(d.error).toMatch(/non-empty blockedReason/);
      }
    });

    it('accepts an existing blockedReason already on the task', () => {
      const d = evaluateBlockedGate({
        task: { ...base, blockedReason: 'waiting on legal' },
        updates: { status: 'blocked', blockedReasonType: 'external-dependency' },
      });
      expect(d.kind).toBe('allow');
    });
  });

  describe('type requirement (#1588)', () => {
    it('rejects (400) when blockedReasonType is missing', () => {
      const d = evaluateBlockedGate({
        task: base,
        updates: { status: 'blocked', blockedReason: 'need a call' },
      });
      expect(d.kind).toBe('reject');
      if (d.kind === 'reject') {
        expect(d.status).toBe(400);
        expect(d.error).toMatch(/blockedReasonType to be one of/);
      }
    });

    it('rejects (400) when blockedReasonType is not in the enum', () => {
      const d = evaluateBlockedGate({
        task: base,
        updates: { status: 'blocked', blockedReason: 'x', blockedReasonType: 'because-i-said-so' },
      });
      expect(d.kind).toBe('reject');
      if (d.kind === 'reject') expect(d.status).toBe(400);
    });
  });

  describe('abdication bounce — awaiting-review', () => {
    it('bounces (409) with the ownership mantra and owner', () => {
      const d = evaluateBlockedGate({
        task: base,
        updates: { status: 'blocked', blockedReason: 'PR ready, want a look', blockedReasonType: 'awaiting-review' },
      });
      expect(d.kind).toBe('bounce');
      if (d.kind === 'bounce') {
        expect(d.status).toBe(409);
        expect(d.owner).toBe('Mikey');
        expect(d.mantra).toBe(buildBounceMantra());
        expect(d.mantra).toMatch(/you own this/);
        expect(d.error).toMatch(/ownership call, not a blocker/);
      }
    });

    it('bounces even if awaiting-review was only set on the task previously', () => {
      const d = evaluateBlockedGate({
        task: { ...base, blockedReason: 'pending', blockedReasonType: 'awaiting-review' },
        updates: { status: 'blocked' },
      });
      expect(d.kind).toBe('bounce');
    });

    it('does NOT bounce an awaiting-review when a real dependency block exists', () => {
      // blockedBy[] wins — a dependency block is legitimate regardless of type.
      const d = evaluateBlockedGate({
        task: base,
        updates: { status: 'blocked', blockedBy: [1700], blockedReasonType: 'awaiting-review' },
      });
      expect(d.kind).toBe('allow');
    });
  });

  describe('legitimate human-queue blocks pass through', () => {
    for (const t of ['irreversible-decision', 'external-dependency', 'needs-human-judgment'] as const) {
      it(`allows '${t}' with a reason`, () => {
        const d = evaluateBlockedGate({
          task: base,
          updates: { status: 'blocked', blockedReason: 'genuine', blockedReasonType: t },
        });
        expect(d.kind).toBe('allow');
      });
    }
  });

  it('enum constant lists all four types', () => {
    expect(BLOCK_TYPES).toEqual([
      'irreversible-decision',
      'external-dependency',
      'needs-human-judgment',
      'awaiting-review',
    ]);
  });
});
