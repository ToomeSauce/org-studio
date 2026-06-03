/**
 * #1589 — Domain Steward sweep: pure-logic regression tests.
 * Mirrors the claim-contract.test.ts style: minimal fixtures, injected
 * `now`, no DB.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyForSteward,
  planStewardSweep,
  dependenciesResolved,
  onNudgeCooldown,
  isStale,
  buildOwnerNudge,
  buildHumanSummary,
  BLOCKED_STALE_MS,
  IN_PROGRESS_STALL_MS,
  NUDGE_COOLDOWN_MS,
  type StewardTaskLike,
} from '@/lib/domain-steward';

const NOW = 1_900_000_000_000;
const ago = (ms: number) => NOW - ms;

function task(p: Partial<StewardTaskLike>): StewardTaskLike {
  return { id: 't', assignee: 'Mikey', ...p };
}

describe('#1589 helpers', () => {
  it('dependenciesResolved: empty/absent → true', () => {
    expect(dependenciesResolved(undefined, new Set())).toBe(true);
    expect(dependenciesResolved([], new Set())).toBe(true);
  });
  it('dependenciesResolved: all done → true, any open → false', () => {
    expect(dependenciesResolved([1, 2], new Set([1, 2]))).toBe(true);
    expect(dependenciesResolved([1, 2], new Set([1]))).toBe(false);
  });
  it('onNudgeCooldown: within window true, outside false, never-nudged false', () => {
    expect(onNudgeCooldown(task({ lastStewardNudgeAt: ago(NUDGE_COOLDOWN_MS - 1000) }), NOW)).toBe(true);
    expect(onNudgeCooldown(task({ lastStewardNudgeAt: ago(NUDGE_COOLDOWN_MS + 1000) }), NOW)).toBe(false);
    expect(onNudgeCooldown(task({ lastStewardNudgeAt: null }), NOW)).toBe(false);
  });
  it('isStale: unknown timestamp never stale (no false positives)', () => {
    expect(isStale(undefined, NOW, 1000)).toBe(false);
    expect(isStale(0, NOW, 1000)).toBe(false);
    expect(isStale(ago(2000), NOW, 1000)).toBe(true);
  });
});

describe('#1589 classifyForSteward — blocked tickets', () => {
  it('reversible abdication left to rot → nudge owner', () => {
    const t = task({
      status: 'blocked',
      blockedReasonType: 'awaiting-review',
      statusChangedAt: ago(BLOCKED_STALE_MS + 1000),
      ticketNumber: 100,
    });
    const a = classifyForSteward(t, new Set(), NOW);
    expect(a.kind).toBe('nudge-owner');
    if (a.kind === 'nudge-owner') {
      expect(a.owner).toBe('Mikey');
      expect(a.reason).toBe('blocked-reversible-too-long');
    }
  });

  it('untyped block (empty reason) treated as reversible → nudge owner', () => {
    const t = task({ status: 'blocked', blockedReasonType: '', statusChangedAt: ago(BLOCKED_STALE_MS + 1) });
    expect(classifyForSteward(t, new Set(), NOW).kind).toBe('nudge-owner');
  });

  it('reversible block NOT yet stale → skip(not-stale)', () => {
    const t = task({ status: 'blocked', blockedReasonType: 'awaiting-review', statusChangedAt: ago(1000) });
    const a = classifyForSteward(t, new Set(), NOW);
    expect(a).toEqual({ kind: 'skip', why: 'not-stale' });
  });

  it('irreversible gate (stale) → escalate-human, NOT owner nudge', () => {
    const t = task({
      status: 'blocked',
      blockedReasonType: 'irreversible-decision',
      statusChangedAt: ago(BLOCKED_STALE_MS + 1),
      ticketNumber: 7,
    });
    const a = classifyForSteward(t, new Set(), NOW);
    expect(a.kind).toBe('escalate-human');
    if (a.kind === 'escalate-human') expect(a.reason).toBe('blocked-irreversible');
  });

  it('external-dependency + needs-human-judgment both escalate to human', () => {
    for (const type of ['external-dependency', 'needs-human-judgment']) {
      const t = task({ status: 'blocked', blockedReasonType: type, statusChangedAt: ago(BLOCKED_STALE_MS + 1) });
      expect(classifyForSteward(t, new Set(), NOW).kind).toBe('escalate-human');
    }
  });

  it('dependency block with deps still open → skip(dependency-unresolved)', () => {
    const t = task({ status: 'blocked', blockedBy: [1, 2], blockedReasonType: 'external-dependency' });
    const a = classifyForSteward(t, new Set([1]), NOW);
    expect(a).toEqual({ kind: 'skip', why: 'dependency-unresolved' });
  });

  it('dependency block with ALL deps shipped → nudge owner (no staleness needed)', () => {
    const t = task({ status: 'blocked', blockedBy: [1, 2], blockedReasonType: 'external-dependency', ticketNumber: 50 });
    const a = classifyForSteward(t, new Set([1, 2]), NOW);
    expect(a.kind).toBe('nudge-owner');
    if (a.kind === 'nudge-owner') expect(a.reason).toBe('blocked-dependency-resolved');
  });

  it('resolved-dependency nudge respects cooldown', () => {
    const t = task({
      status: 'blocked', blockedBy: [1], blockedReasonType: 'external-dependency',
      lastStewardNudgeAt: ago(NUDGE_COOLDOWN_MS - 1),
    });
    expect(classifyForSteward(t, new Set([1]), NOW)).toEqual({ kind: 'skip', why: 'on-cooldown' });
  });

  it('reversible-too-long nudge respects cooldown', () => {
    const t = task({
      status: 'blocked', blockedReasonType: 'awaiting-review',
      statusChangedAt: ago(BLOCKED_STALE_MS + 1), lastStewardNudgeAt: ago(NUDGE_COOLDOWN_MS - 1),
    });
    expect(classifyForSteward(t, new Set(), NOW)).toEqual({ kind: 'skip', why: 'on-cooldown' });
  });

  it('no owner → skip(no-owner) on reversible block', () => {
    const t = task({ status: 'blocked', assignee: '', blockedReasonType: 'awaiting-review', statusChangedAt: ago(BLOCKED_STALE_MS + 1) });
    expect(classifyForSteward(t, new Set(), NOW)).toEqual({ kind: 'skip', why: 'no-owner' });
  });
});

describe('#1589 classifyForSteward — in-progress stalls', () => {
  it('stalled past horizon → nudge owner', () => {
    const t = task({ status: 'in-progress', lastActivityAt: ago(IN_PROGRESS_STALL_MS + 1), ticketNumber: 9 });
    const a = classifyForSteward(t, new Set(), NOW);
    expect(a.kind).toBe('nudge-owner');
    if (a.kind === 'nudge-owner') expect(a.reason).toBe('in-progress-stalled');
  });
  it('recently active → skip(not-stale), never nudges a working agent', () => {
    const t = task({ status: 'in-progress', lastActivityAt: ago(1000) });
    expect(classifyForSteward(t, new Set(), NOW)).toEqual({ kind: 'skip', why: 'not-stale' });
  });
  it('non-candidate statuses skip', () => {
    for (const s of ['backlog', 'planning', 'done']) {
      expect(classifyForSteward(task({ status: s }), new Set(), NOW)).toEqual({ kind: 'skip', why: 'not-a-candidate-status' });
    }
  });
});

describe('#1589 planStewardSweep — bucketing + summarize-once', () => {
  it('buckets nudges, escalations, skips; done set derived from tasks', () => {
    const tasks: StewardTaskLike[] = [
      task({ id: 'd1', status: 'done', ticketNumber: 1 }),
      task({ id: 'a', status: 'blocked', blockedReasonType: 'awaiting-review', statusChangedAt: ago(BLOCKED_STALE_MS + 1), ticketNumber: 10 }),
      task({ id: 'b', status: 'blocked', blockedReasonType: 'irreversible-decision', statusChangedAt: ago(BLOCKED_STALE_MS + 1), ticketNumber: 11 }),
      task({ id: 'c', status: 'blocked', blockedBy: [1], blockedReasonType: 'external-dependency', ticketNumber: 12 }),
      task({ id: 'e', status: 'in-progress', lastActivityAt: ago(100) }), // fresh → skip
    ];
    const plan = planStewardSweep(tasks, NOW);
    expect(plan.nudges.map((n) => n.ticket.id).sort()).toEqual(['a', 'c']); // reversible + resolved-dep
    expect(plan.humanEscalations.map((h) => h.ticket.id)).toEqual(['b']);
    expect(plan.skipped.some((s) => s.ticket.id === 'e')).toBe(true);
  });

  it('buildHumanSummary returns null when no irreversible gates (no chatter)', () => {
    expect(buildHumanSummary([])).toBeNull();
  });

  it('buildHumanSummary folds multiple gates into ONE message', () => {
    const msg = buildHumanSummary([
      { reason: 'blocked-irreversible', ticket: task({ ticketNumber: 11, title: 'DDL drop', blockedReasonType: 'irreversible-decision' }) },
      { reason: 'blocked-irreversible', ticket: task({ ticketNumber: 12, title: 'vendor', blockedReasonType: 'external-dependency' }) },
    ])!;
    expect(msg).toContain('2 tickets');
    expect(msg).toContain('#11');
    expect(msg).toContain('#12');
    expect((msg.match(/Domain Steward/g) || []).length).toBe(1); // single header
  });

  it('owner nudge text pushes ownership, never does the work', () => {
    const t = task({ ticketNumber: 10, title: 'x', blockedReasonType: 'awaiting-review' });
    const msg = buildOwnerNudge('blocked-reversible-too-long', t);
    expect(msg).toMatch(/you own this/i);
    expect(msg).toMatch(/not doing the work for you/i);
  });
});
