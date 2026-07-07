/**
 * #1654 Phase A-3 — leash block renderer tests.
 */
import { describe, expect, it } from 'vitest';
import { renderLeashBlock } from '@/lib/leash-block';

const NOW = new Date(Date.UTC(2026, 6, 15)); // Jul 15 — mid-month, 31-day month

const fullProject = {
  id: 'p1',
  name: 'Org Studio',
  budget: { ceilingUsdMonth: 200, alertPct: 80 },
  boundaries: {
    freeToDecide: ['Any reversible decision', 'Tech stack', 'Copy & design'],
    mustAsk: ['Spending real money', 'Public-facing changes', 'Irreversible ops'],
  },
};

describe('renderLeashBlock (#1654)', () => {
  it('renders nothing for a project with no leash fields', () => {
    expect(renderLeashBlock({ id: 'p1', name: 'Bare' })).toBe('');
    expect(renderLeashBlock({ id: 'p1', budget: {} })).toBe('');
    expect(
      renderLeashBlock({ id: 'p1', boundaries: { freeToDecide: [], mustAsk: [] } }),
    ).toBe('');
    expect(renderLeashBlock(null)).toBe('');
  });

  it('renders full block with live spend + pace', () => {
    const block = renderLeashBlock(fullProject, { spendUsd: 62 }, NOW);
    expect(block).toContain('Autonomy leash — Org Studio');
    expect(block).toContain('$62.00 of $200.00/mo');
    expect(block).toContain('31%'); // 62/200
    // Pace: 62/15*31 ≈ 128
    expect(block).toContain('pace ~$128');
    expect(block).toContain('Free to decide');
    expect(block).toContain('Must ask BEFORE acting');
    expect(block).toContain('reversible decisions are yours by default');
  });

  it('renders static budget line without spend info', () => {
    const block = renderLeashBlock(fullProject);
    expect(block).toContain('$200.00/mo metered ceiling');
    expect(block).not.toContain('pace');
  });

  it('boundaries-only project renders without budget line', () => {
    const block = renderLeashBlock({
      id: 'p2',
      name: 'NoBudget',
      boundaries: { freeToDecide: ['X'], mustAsk: ['Y'] },
    });
    expect(block).toContain('Free to decide (no permission needed): X');
    expect(block).not.toContain('- Budget:');
  });

  it('budget-only project renders without boundary lines', () => {
    const block = renderLeashBlock({
      id: 'p3',
      budget: { ceilingUsdMonth: 50 },
    });
    expect(block).toContain('$50.00/mo');
    expect(block).not.toContain('Free to decide');
  });

  it('long boundary lists truncate at 3 with +N more', () => {
    const block = renderLeashBlock({
      id: 'p4',
      boundaries: { freeToDecide: ['a', 'b', 'c', 'd', 'e'], mustAsk: [] },
    });
    expect(block).toContain('a; b; c (+2 more)');
    expect(block).not.toContain('; d');
  });

  it('stays under 15 lines even fully loaded', () => {
    const block = renderLeashBlock(fullProject, { spendUsd: 150 }, NOW);
    expect(block.split('\n').length).toBeLessThanOrEqual(15);
  });

  it('ignores invalid ceiling values', () => {
    expect(renderLeashBlock({ id: 'p5', budget: { ceilingUsdMonth: -10 } })).toBe('');
    expect(renderLeashBlock({ id: 'p5', budget: { ceilingUsdMonth: NaN } })).toBe('');
  });
});
