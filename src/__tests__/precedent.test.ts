/**
 * #1593 — Precedent-aware enrichment: pure-logic tests (injected search).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  stewardQuery,
  renderPrecedentBlock,
  enrichStewardNudge,
  enrichProposePrompt,
  MIN_PRECEDENT_SCORE,
  type MemoryHit,
} from '@/lib/embedding/precedent';

const hit = (p: Partial<MemoryHit>): MemoryHit => ({
  id: 'task-description:t9', sourceType: 'task-description', score: 0.4,
  text: 'Prior abdication on the same reversible call.',
  citation: { ticketNumber: 99, taskId: 't9', link: '/board?task=t9' },
  ...p,
});

describe('#1593 stewardQuery', () => {
  it('abdication reason biases to owner + blocked/status sources', () => {
    const q = stewardQuery('blocked-reversible-too-long', { id: 't1', title: 'Pick a vendor', assignee: 'Mikey' } as any);
    expect(q.query).toMatch(/abdication/);
    expect(q.filters.owner).toBe('Mikey');
    expect(q.filters.sourceTypes).toContain('blocked-reason');
  });
  it('other reasons just search the subject, no owner bias', () => {
    const q = stewardQuery('in-progress-stalled', { id: 't1', title: 'Refactor router' } as any);
    expect(q.query).toMatch(/Refactor router/);
    expect(q.filters.owner).toBeUndefined();
  });
});

describe('#1593 renderPrecedentBlock', () => {
  it('renders top hits with refs + links, filters weak scores', () => {
    const block = renderPrecedentBlock(
      [hit({ score: 0.4 }), hit({ score: MIN_PRECEDENT_SCORE - 0.01, id: 'weak' })],
      'Prior context',
    );
    expect(block).toMatch(/Prior context/);
    expect(block).toMatch(/#99/);
    expect(block).toMatch(/\/board\?task=t9/);
    expect(block).not.toMatch(/weak/);
  });
  it('returns empty string when nothing strong enough', () => {
    expect(renderPrecedentBlock([hit({ score: 0.01 })], 'X')).toBe('');
    expect(renderPrecedentBlock([], 'X')).toBe('');
  });
  it('caps at 3 citations', () => {
    const many = Array.from({ length: 6 }, (_, i) => hit({ id: 'h' + i, citation: { ticketNumber: i } }));
    const block = renderPrecedentBlock(many, 'X');
    expect((block.match(/•/g) || []).length).toBe(3);
  });
});

describe('#1593 enrichStewardNudge', () => {
  it('appends precedent and excludes the triggering ticket', async () => {
    const search = vi.fn().mockResolvedValue([
      hit({ citation: { taskId: 'self', ticketNumber: 1 } }), // excluded (self)
      hit({ citation: { taskId: 'other', ticketNumber: 42, link: '/board?task=other' } }),
    ]);
    const out = await enrichStewardNudge('BASE', 'blocked-reversible-too-long', { id: 'self', assignee: 'Mikey' } as any, search);
    expect(out).toMatch(/^BASE/);
    expect(out).toMatch(/#42/);
    expect(out).not.toMatch(/#1\b/);
  });
  it('search failure → base nudge unchanged (never throws)', async () => {
    const search = vi.fn().mockRejectedValue(new Error('down'));
    const out = await enrichStewardNudge('BASE', 'in-progress-stalled', { id: 't1' } as any, search);
    expect(out).toBe('BASE');
  });
  it('no hits → base unchanged', async () => {
    const out = await enrichStewardNudge('BASE', 'in-progress-stalled', { id: 't1' } as any, vi.fn().mockResolvedValue([]));
    expect(out).toBe('BASE');
  });
});

describe('#1593 enrichProposePrompt', () => {
  it('appends prior experiments toward the goal', async () => {
    const search = vi.fn().mockResolvedValue([hit({ text: 'Tried banner copy A/B; +2% only.', citation: { ticketNumber: 7, link: '/board?task=t7' } })]);
    const out = await enrichProposePrompt('PROMPT', { version: '2026.08.01', successCriteria: 'activation ≥ 40%', projectId: 'p' }, search);
    expect(out).toMatch(/^PROMPT/);
    expect(out).toMatch(/Prior experiments/);
    expect(out).toMatch(/#7/);
    // confirms it filtered by project + experiment sources
    expect(search).toHaveBeenCalledWith(expect.stringMatching(/experiment/), expect.objectContaining({ projectId: 'p' }), 5);
  });
  it('search failure → base prompt unchanged', async () => {
    const out = await enrichProposePrompt('PROMPT', { version: '2026.08.01' }, vi.fn().mockRejectedValue(new Error('x')));
    expect(out).toBe('PROMPT');
  });
});
