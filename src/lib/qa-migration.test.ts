import { describe, it, expect } from 'vitest';
import { detectQaProjects } from './qa-migration';

describe('detectQaProjects', () => {
  it('detects "Thrivor QA" with parent "Thrivor"', () => {
    const projects = [
      { id: 'p1', name: 'Thrivor', devOwner: 'Trevor', qaOwner: '' },
      { id: 'p2', name: 'Thrivor QA', devOwner: 'Billy', qaOwner: 'Trevor' },
    ];
    const matches = detectQaProjects(projects);
    expect(matches).toHaveLength(1);
    expect(matches[0].qaProject.id).toBe('p2');
    expect(matches[0].parentProject.id).toBe('p1');
    expect(matches[0].sectionId).toBe('sec-qa-p1');
    expect(matches[0].sectionOwner).toBe('Trevor'); // qaOwner on the QA project
  });

  it('does not detect "QA Metrics" (no matching parent)', () => {
    const projects = [
      { id: 'p1', name: 'Thrivor' },
      { id: 'p3', name: 'QA Metrics' },
    ];
    const matches = detectQaProjects(projects);
    expect(matches).toHaveLength(0);
  });

  it('skips already-archived qa-fold projects', () => {
    const projects = [
      { id: 'p1', name: 'Thrivor' },
      {
        id: 'p2',
        name: 'Thrivor QA',
        isArchived: true,
        archivedReason: 'qa-fold',
        migratedTo: { projectId: 'p1', sectionId: 'sec-qa-p1' },
      },
    ];
    const matches = detectQaProjects(projects);
    expect(matches).toHaveLength(0);
  });

  it('handles case-insensitive matching', () => {
    const projects = [
      { id: 'p1', name: 'thrivor' },
      { id: 'p2', name: 'THRIVOR QA', qaOwner: 'Trevor' },
    ];
    const matches = detectQaProjects(projects);
    expect(matches).toHaveLength(1);
    expect(matches[0].parentProject.id).toBe('p1');
  });

  it('falls back to devOwner then parent qaOwner for section owner', () => {
    const projects = [
      { id: 'p1', name: 'Alpha', qaOwner: 'Zara' },
      { id: 'p2', name: 'Alpha QA', devOwner: 'Dev1' }, // no qaOwner
    ];
    const matches = detectQaProjects(projects);
    expect(matches).toHaveLength(1);
    expect(matches[0].sectionOwner).toBe('Dev1'); // devOwner fallback
  });

  it('falls back to parent qaOwner when QA project has neither', () => {
    const projects = [
      { id: 'p1', name: 'Beta', qaOwner: 'Zara' },
      { id: 'p2', name: 'Beta QA' }, // no qaOwner, no devOwner
    ];
    const matches = detectQaProjects(projects);
    expect(matches).toHaveLength(1);
    expect(matches[0].sectionOwner).toBe('Zara');
  });

  it('returns empty for empty array', () => {
    expect(detectQaProjects([])).toHaveLength(0);
  });

  it('returns empty for null / undefined', () => {
    expect(detectQaProjects(null as any)).toHaveLength(0);
    expect(detectQaProjects(undefined as any)).toHaveLength(0);
  });
});
