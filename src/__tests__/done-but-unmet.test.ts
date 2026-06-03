/**
 * #1585 — Done-but-unmet nudge: pure-logic regression tests.
 */
import { describe, it, expect } from 'vitest';
import {
  isDoneButUnmet,
  classifyProposeNext,
  planProposeSweep,
  onProposeCooldown,
  buildProposeNextPrompt,
  PROPOSE_COOLDOWN_MS,
  type DoneUnmetVersionLike,
} from '@/lib/done-but-unmet';

const NOW = 1_900_000_000_000;
const ago = (ms: number) => NOW - ms;

function ver(p: Partial<DoneUnmetVersionLike>): DoneUnmetVersionLike {
  return {
    id: 'v1', version: '2026.07.01', status: 'current', owner: 'Mikey',
    successCriteria: 'activation ≥ 40%', metricTarget: 40, metricCurrent: 25, metricComparator: 'gte',
    items: [{ done: true }, { done: true }],
    ...p,
  };
}

describe('#1585 isDoneButUnmet', () => {
  it('true: all items done + metric unmet + outcome-bound + not paused', () => {
    expect(isDoneButUnmet(ver({}))).toBe(true);
  });
  it('false: metric IS met', () => {
    expect(isDoneButUnmet(ver({ metricCurrent: 40 }))).toBe(false);
  });
  it('false: not all items done', () => {
    expect(isDoneButUnmet(ver({ items: [{ done: true }, { done: false }] }))).toBe(false);
  });
  it('false: no items (nothing shipped)', () => {
    expect(isDoneButUnmet(ver({ items: [] }))).toBe(false);
  });
  it('false: not outcome-bound (no successCriteria)', () => {
    expect(isDoneButUnmet(ver({ successCriteria: '' }))).toBe(false);
  });
  it('false: loop paused (human kill-switch)', () => {
    expect(isDoneButUnmet(ver({ loopPaused: true }))).toBe(false);
  });
  it('respects comparator: lte unmet when current above target', () => {
    expect(isDoneButUnmet(ver({ successCriteria: 'errors ≤ 1', metricComparator: 'lte', metricTarget: 1, metricCurrent: 5 }))).toBe(true);
    expect(isDoneButUnmet(ver({ successCriteria: 'errors ≤ 1', metricComparator: 'lte', metricTarget: 1, metricCurrent: 0 }))).toBe(false);
  });
  it('null/undefined → false', () => {
    expect(isDoneButUnmet(null)).toBe(false);
    expect(isDoneButUnmet(undefined)).toBe(false);
  });
});

describe('#1585 classifyProposeNext', () => {
  it('done-but-unmet, current, has owner, no cooldown → nudge', () => {
    const a = classifyProposeNext(ver({}), NOW);
    expect(a.kind).toBe('nudge-owner');
    if (a.kind === 'nudge-owner') expect(a.owner).toBe('Mikey');
  });
  it('shipped version is never chased', () => {
    expect(classifyProposeNext(ver({ status: 'shipped' }), NOW)).toEqual({ kind: 'skip', why: 'not-done-but-unmet' });
  });
  it('no owner → skip', () => {
    expect(classifyProposeNext(ver({ owner: '' }), NOW)).toEqual({ kind: 'skip', why: 'no-owner' });
  });
  it('within cooldown → skip', () => {
    const a = classifyProposeNext(ver({ lastProposeNudgeAt: ago(PROPOSE_COOLDOWN_MS - 1) }), NOW);
    expect(a).toEqual({ kind: 'skip', why: 'on-cooldown' });
  });
  it('past cooldown → nudge again', () => {
    expect(classifyProposeNext(ver({ lastProposeNudgeAt: ago(PROPOSE_COOLDOWN_MS + 1) }), NOW).kind).toBe('nudge-owner');
  });
  it('metric met → skip', () => {
    expect(classifyProposeNext(ver({ metricCurrent: 40 }), NOW).kind).toBe('skip');
  });
});

describe('#1585 onProposeCooldown', () => {
  it('never-nudged → false', () => {
    expect(onProposeCooldown(ver({ lastProposeNudgeAt: null }), NOW)).toBe(false);
  });
});

describe('#1585 planProposeSweep — summarize-once / bucketing', () => {
  it('buckets nudges vs skips', () => {
    const versions = [
      ver({ id: 'a' }),                                  // nudge
      ver({ id: 'b', metricCurrent: 40 }),               // met → skip
      ver({ id: 'c', status: 'shipped' }),               // shipped → skip
      ver({ id: 'd', items: [{ done: false }] }),        // not done → skip
    ];
    const plan = planProposeSweep(versions, NOW);
    expect(plan.nudges.map((n) => n.version.id)).toEqual(['a']);
    expect(plan.skipped.map((s) => s.version.id).sort()).toEqual(['b', 'c', 'd']);
  });
});

describe('#1585 buildProposeNextPrompt', () => {
  it('frames an owner choice, never auto-spawns', () => {
    const msg = buildProposeNextPrompt(ver({}));
    expect(msg).toMatch(/propose the next experiment/i);
    expect(msg).toMatch(/not spawning anything/i);
    expect(msg).toContain('2026.07.01');
    expect(msg).toContain('25'); // current
    expect(msg).toContain('40'); // target
  });
});
