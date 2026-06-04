/**
 * #1592 — Memory search: pure helper tests (limit clamp, citation links).
 * The SQL/embedding path is covered by a live smoke against staging in the PR.
 */
import { describe, it, expect } from 'vitest';
import { normalizeLimit, buildLink } from '@/lib/embedding/search';
import { defaultProvider } from '@/lib/embedding/provider';

describe('#1592 normalizeLimit', () => {
  it('defaults when missing/invalid', () => {
    expect(normalizeLimit(undefined)).toBe(8);
    expect(normalizeLimit('abc')).toBe(8);
    expect(normalizeLimit(0)).toBe(8);
    expect(normalizeLimit(-5)).toBe(8);
  });
  it('passes through valid', () => {
    expect(normalizeLimit(3)).toBe(3);
    expect(normalizeLimit('12')).toBe(12);
  });
  it('clamps to max 50', () => {
    expect(normalizeLimit(9999)).toBe(50);
  });
});

describe('#1597 defaultProvider tier selection', () => {
  it('falls back to hashing when Azure env vars are absent', () => {
    delete process.env.AZURE_EMBEDDING_ENDPOINT;
    delete process.env.AZURE_EMBEDDING_KEY;
    delete process.env.AZURE_EMBEDDING_DEPLOYMENT;
    expect(defaultProvider().id).toMatch(/^hashing-v1-d/);
  });
});

describe('#1592 buildLink citations', () => {
  it('task → board deep link with project + task', () => {
    expect(buildLink({ task_id: 't1', project_id: 'p1' })).toBe('/board?projectId=p1&task=t1');
  });
  it('task without project still links', () => {
    expect(buildLink({ task_id: 't1' })).toBe('/board?task=t1');
  });
  it('vision-doc → vision page', () => {
    expect(buildLink({ source_type: 'vision-doc', project_id: 'p1' })).toBe('/vision/p1');
  });
  it('project-only → board', () => {
    expect(buildLink({ project_id: 'p1' })).toBe('/board?projectId=p1');
  });
  it('nothing to link → undefined', () => {
    expect(buildLink({})).toBeUndefined();
  });
  it('url-encodes ids', () => {
    expect(buildLink({ task_id: 'a b', project_id: 'p/1' })).toBe('/board?projectId=p%2F1&task=a%20b');
  });
});
