/**
 * #1590 — Embedding provider + corpus extraction: pure-logic tests.
 */
import { describe, it, expect } from 'vitest';
import {
  HashingEmbeddingProvider,
  EMBEDDING_DIM,
  tokenize,
  l2normalize,
  cosineSimilarity,
  toPgVectorLiteral,
  fromPgVectorLiteral,
  defaultProvider,
} from '@/lib/embedding/provider';
import {
  contentHash,
  docsFromTask,
  docFromVision,
  docFromChangeHistory,
  buildCorpus,
  type TaskLike,
} from '@/lib/embedding/corpus';

describe('#1590 HashingEmbeddingProvider', () => {
  const p = new HashingEmbeddingProvider();
  it('emits a unit vector of the right dim', () => {
    const v = p.embedOne('pgvector setup and embedding pipeline');
    expect(v.length).toBe(EMBEDDING_DIM);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });
  it('is deterministic — same text → identical vector', async () => {
    const [a, b] = await p.embed(['decision corpus indexer', 'decision corpus indexer']);
    expect(a).toEqual(b);
  });
  it('similar texts score higher than unrelated ones', () => {
    const q = p.embedOne('semantic search over decisions');
    const near = p.embedOne('semantic retrieval of decision snippets');
    const far = p.embedOne('twilio phone call audio streaming realtime');
    expect(cosineSimilarity(q, near)).toBeGreaterThan(cosineSimilarity(q, far));
  });
  it('empty text → zero vector (norm 0), cosine 0 vs anything', () => {
    const z = p.embedOne('');
    expect(z.every((x) => x === 0)).toBe(true);
    expect(cosineSimilarity(z, p.embedOne('anything'))).toBe(0);
  });
  it('stable provider id encodes dim', () => {
    expect(p.id).toBe(`hashing-v1-d${EMBEDDING_DIM}`);
    expect(defaultProvider().id).toBe(p.id);
  });
});

describe('#1590 vector helpers', () => {
  it('tokenize lowercases + splits on non-alnum', () => {
    expect(tokenize('Foo, BAR_baz-99!')).toEqual(['foo', 'bar', 'baz', '99']);
  });
  it('l2normalize of zero vector stays zero', () => {
    expect(l2normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });
  it('cosine throws on dim mismatch', () => {
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow(/dim mismatch/);
  });
  it('pgvector literal round-trips', () => {
    const v = [0.5, -0.25, 0];
    expect(toPgVectorLiteral(v)).toBe('[0.5,-0.25,0]');
    expect(fromPgVectorLiteral(' [0.5, -0.25, 0] ')).toEqual(v);
    expect(fromPgVectorLiteral('[]')).toEqual([]);
  });
});

describe('#1590 contentHash (idempotency key)', () => {
  it('stable + changes with content', () => {
    expect(contentHash('abc')).toBe(contentHash('abc'));
    expect(contentHash('abc')).not.toBe(contentHash('abd'));
    expect(contentHash('abc')).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('#1590 corpus extraction', () => {
  const task: TaskLike = {
    id: 'tk1', ticketNumber: 1590, projectId: 'proj-org-studio', assignee: 'Mikey',
    title: 'pgvector setup', description: 'Add pgvector + embedding pipeline.',
    reviewNotes: 'Shipped idempotent backfill.',
    blockedReasonType: 'external-dependency', blockedReason: 'awaiting embedding key',
    comments: [
      { id: 'c1', content: 'Decided to ship a hashing default.', type: 'comment' },
      { id: 'c2', content: 'auto reopened', type: 'system' }, // skipped
    ],
    statusHistory: [
      { status: 'done', note: 'Closed after CI green.', timestamp: 111 },
      { status: 'in-progress', timestamp: 222 }, // no note → skipped
    ],
  };
  it('extracts description, review-notes, blocked-reason, human comment, noted status', () => {
    const docs = docsFromTask(task);
    const types = docs.map((d) => d.sourceType).sort();
    expect(types).toEqual(['blocked-reason', 'status-history', 'task-comment', 'task-description', 'task-review-notes']);
  });
  it('skips system comments and note-less status entries', () => {
    const docs = docsFromTask(task);
    expect(docs.find((d) => d.text === 'auto reopened')).toBeUndefined();
    expect(docs.filter((d) => d.sourceType === 'status-history').length).toBe(1);
  });
  it('carries citation scope + stable ids', () => {
    const desc = docsFromTask(task).find((d) => d.sourceType === 'task-description')!;
    expect(desc.id).toBe('task-description:tk1');
    expect(desc.projectId).toBe('proj-org-studio');
    expect(desc.ticketNumber).toBe(1590);
    expect(desc.contentHash).toMatch(/^[0-9a-f]{8}$/);
  });
  it('empty text fields produce no docs', () => {
    expect(docsFromTask({ id: 'x' })).toEqual([]);
    expect(docFromVision({ projectId: 'p', content: '' })).toBeNull();
    expect(docFromChangeHistory({ projectId: 'p', text: '' })).toBeNull();
  });
  it('buildCorpus aggregates all sources', () => {
    const corpus = buildCorpus({
      tasks: [task],
      visionDocs: [{ projectId: 'p', title: 'V', content: 'north star' }],
      changeHistory: [{ projectId: 'p', version: '2026.08.01', text: 'launched memory' }],
    });
    expect(corpus.some((d) => d.sourceType === 'vision-doc')).toBe(true);
    expect(corpus.some((d) => d.sourceType === 'change-history')).toBe(true);
    expect(corpus.some((d) => d.sourceType === 'task-description')).toBe(true);
  });
});
