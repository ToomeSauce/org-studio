/**
 * #1586 — Assisted metric capture (Phase C of experiment-loop legibility).
 *
 * Lets a version owner wire `metricCurrent` to a real SOURCE instead of
 * hand-entering vibes. Min-viable source: an HTTP endpoint that returns
 * JSON; the owner gives a URL + a dot-path to the number. Manual entry
 * stays as an always-available fallback (this module never removes it).
 *
 * Source config is stored per-version in the rv `meta` jsonb (no migration).
 *
 * This module is PURE: it validates config and extracts a number from an
 * already-fetched payload. The actual fetch (network IO) is injected by the
 * caller (the poll route), so the parser/validator is unit-testable with no
 * network. Designed runtime-neutral — lives in Org Studio, not a runtime.
 *
 * Forward-compatible: `kind` is an enum so query/uploaded-report sources can
 * be added later without breaking stored configs. Only 'endpoint' is wired
 * now.
 */

export type MetricSourceKind = 'endpoint';

export interface MetricSource {
  kind: MetricSourceKind;
  /** HTTP(S) URL returning JSON. */
  url: string;
  /**
   * Dot/bracket path to the numeric value in the JSON, e.g.
   * "data.activation_rate" or "results[0].value". Empty/"." = the root
   * (when the endpoint returns a bare number).
   */
  jsonPath?: string;
  /** Optional multiplier applied after extraction (e.g. 100 for a 0..1 rate). */
  scale?: number;
}

export type MetricSourceValidation =
  | { ok: true; source: MetricSource }
  | { ok: false; error: string };

/**
 * Validate an owner-supplied source config. Returns a normalized source or a
 * 400-able error. Strict on purpose — a bad source must never corrupt meta.
 */
export function validateMetricSource(input: any): MetricSourceValidation {
  if (input == null) return { ok: false, error: 'metricSource must be an object' };
  if (typeof input !== 'object') return { ok: false, error: 'metricSource must be an object' };
  if (input.kind !== 'endpoint') {
    return { ok: false, error: "metricSource.kind must be 'endpoint' (only endpoint poll is supported)" };
  }
  if (typeof input.url !== 'string' || !/^https?:\/\//i.test(input.url.trim())) {
    return { ok: false, error: 'metricSource.url must be an http(s) URL' };
  }
  if (input.jsonPath != null && typeof input.jsonPath !== 'string') {
    return { ok: false, error: 'metricSource.jsonPath must be a string' };
  }
  if (input.scale != null && (typeof input.scale !== 'number' || !Number.isFinite(input.scale))) {
    return { ok: false, error: 'metricSource.scale must be a finite number' };
  }
  const source: MetricSource = {
    kind: 'endpoint',
    url: input.url.trim(),
    ...(input.jsonPath != null ? { jsonPath: String(input.jsonPath).trim() } : {}),
    ...(input.scale != null ? { scale: input.scale } : {}),
  };
  return { ok: true, source };
}

/**
 * Read a dot/bracket path out of a parsed JSON value. Supports:
 *   "a.b.c", "a[0].b", "results[2]". Empty / "." → the value itself.
 * Returns undefined if any segment is missing.
 */
export function readJsonPath(payload: any, path?: string): unknown {
  const p = (path || '').trim();
  if (p === '' || p === '.') return payload;
  // Normalize [n] → .n, then split on dots.
  const segments = p.replace(/\[(\d+)\]/g, '.$1').split('.').filter((s) => s.length > 0);
  let cur: any = payload;
  for (const seg of segments) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

export type MetricExtraction =
  | { ok: true; value: number }
  | { ok: false; error: string };

/**
 * Extract the numeric metric from an already-fetched, already-parsed JSON
 * payload, applying the source's jsonPath + scale. Pure.
 *
 * Accepts a raw number, or a numeric string (so "42" or "0.4" work). Rejects
 * NaN / non-finite / non-coercible values with a clear error.
 */
export function extractMetricValue(source: MetricSource, payload: any): MetricExtraction {
  const raw = readJsonPath(payload, source.jsonPath);
  if (raw === undefined) {
    return { ok: false, error: `jsonPath '${source.jsonPath || '(root)'}' not found in response` };
  }
  let num: number;
  if (typeof raw === 'number') {
    num = raw;
  } else if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) {
    num = Number(raw);
  } else {
    return { ok: false, error: `value at '${source.jsonPath || '(root)'}' is not numeric (got ${typeof raw})` };
  }
  if (!Number.isFinite(num)) return { ok: false, error: 'extracted value is not finite' };
  const scaled = typeof source.scale === 'number' ? num * source.scale : num;
  if (!Number.isFinite(scaled)) return { ok: false, error: 'scaled value is not finite' };
  return { ok: true, value: scaled };
}

/**
 * Minimal shape of a fetcher the poll route injects. Returning the parsed
 * JSON keeps this module free of any HTTP client dependency.
 */
export type JsonFetcher = (url: string) => Promise<any>;

export type PollResult =
  | { ok: true; value: number }
  | { ok: false; error: string };

/**
 * Poll one endpoint source end-to-end: fetch → extract. The caller supplies
 * `fetchJson` (so tests inject a fake and the route injects a real fetch with
 * timeout/SSRF guards). This module never touches the network itself.
 */
export async function pollMetricSource(source: MetricSource, fetchJson: JsonFetcher): Promise<PollResult> {
  let payload: any;
  try {
    payload = await fetchJson(source.url);
  } catch (e: any) {
    return { ok: false, error: `fetch failed: ${e?.message || e}` };
  }
  const extracted = extractMetricValue(source, payload);
  if (!extracted.ok) return extracted;
  return { ok: true, value: extracted.value };
}
