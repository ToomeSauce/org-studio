/**
 * #1586 — Assisted metric capture: pure-logic regression tests.
 */
import { describe, it, expect } from 'vitest';
import {
  validateMetricSource,
  readJsonPath,
  extractMetricValue,
  pollMetricSource,
  type MetricSource,
} from '@/lib/metric-source';

describe('#1586 validateMetricSource', () => {
  it('accepts a minimal endpoint source', () => {
    const r = validateMetricSource({ kind: 'endpoint', url: 'https://x.test/m' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.source.url).toBe('https://x.test/m');
  });
  it('normalizes jsonPath + scale', () => {
    const r = validateMetricSource({ kind: 'endpoint', url: 'http://x.test', jsonPath: ' data.v ', scale: 100 });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.source.jsonPath).toBe('data.v'); expect(r.source.scale).toBe(100); }
  });
  it('rejects non-endpoint kind', () => {
    expect(validateMetricSource({ kind: 'query', url: 'http://x' }).ok).toBe(false);
  });
  it('rejects non-http url', () => {
    expect(validateMetricSource({ kind: 'endpoint', url: 'ftp://x' }).ok).toBe(false);
    expect(validateMetricSource({ kind: 'endpoint', url: 'not a url' }).ok).toBe(false);
  });
  it('rejects bad jsonPath / scale types', () => {
    expect(validateMetricSource({ kind: 'endpoint', url: 'http://x', jsonPath: 5 }).ok).toBe(false);
    expect(validateMetricSource({ kind: 'endpoint', url: 'http://x', scale: 'big' }).ok).toBe(false);
  });
  it('rejects null/non-object', () => {
    expect(validateMetricSource(null).ok).toBe(false);
    expect(validateMetricSource('x').ok).toBe(false);
  });
});

describe('#1586 readJsonPath', () => {
  const obj = { data: { activation_rate: 0.42, list: [{ value: 7 }, { value: 9 }] }, n: 3 };
  it('dot path', () => expect(readJsonPath(obj, 'data.activation_rate')).toBe(0.42));
  it('bracket index', () => expect(readJsonPath(obj, 'data.list[1].value')).toBe(9));
  it('root on empty / dot', () => {
    expect(readJsonPath(5, '')).toBe(5);
    expect(readJsonPath(5, '.')).toBe(5);
  });
  it('missing → undefined', () => {
    expect(readJsonPath(obj, 'data.nope')).toBeUndefined();
    expect(readJsonPath(obj, 'a.b.c')).toBeUndefined();
  });
});

describe('#1586 extractMetricValue', () => {
  const src = (p: Partial<MetricSource> = {}): MetricSource => ({ kind: 'endpoint', url: 'http://x', ...p });
  it('extracts a raw number', () => {
    expect(extractMetricValue(src({ jsonPath: 'v' }), { v: 41 })).toEqual({ ok: true, value: 41 });
  });
  it('coerces a numeric string', () => {
    expect(extractMetricValue(src({ jsonPath: 'v' }), { v: '41' })).toEqual({ ok: true, value: 41 });
  });
  it('applies scale (0..1 rate → percent)', () => {
    expect(extractMetricValue(src({ jsonPath: 'r', scale: 100 }), { r: 0.4 })).toEqual({ ok: true, value: 40 });
  });
  it('root payload as bare number', () => {
    expect(extractMetricValue(src({}), 42)).toEqual({ ok: true, value: 42 });
  });
  it('missing path → error', () => {
    const r = extractMetricValue(src({ jsonPath: 'nope' }), { v: 1 });
    expect(r.ok).toBe(false);
  });
  it('non-numeric value → error', () => {
    expect(extractMetricValue(src({ jsonPath: 'v' }), { v: 'abc' }).ok).toBe(false);
    expect(extractMetricValue(src({ jsonPath: 'v' }), { v: {} }).ok).toBe(false);
  });
});

describe('#1586 pollMetricSource (injected fetcher)', () => {
  const src: MetricSource = { kind: 'endpoint', url: 'https://x.test/m', jsonPath: 'data.value', scale: 100 };
  it('happy path: fetch → extract → scale', async () => {
    const r = await pollMetricSource(src, async () => ({ data: { value: 0.37 } }));
    expect(r).toEqual({ ok: true, value: 37 });
  });
  it('fetch throws → error result, no throw', async () => {
    const r = await pollMetricSource(src, async () => { throw new Error('timeout'); });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/fetch failed: timeout/);
  });
  it('bad payload shape → extraction error', async () => {
    const r = await pollMetricSource(src, async () => ({ data: {} }));
    expect(r.ok).toBe(false);
  });
});
