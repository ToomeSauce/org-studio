/**
 * #1649 — metrics bulk comments query: bigint vs timestamptz guard.
 *
 * org_studio_comments.created_at is a BIGINT ms-epoch (like createdAt across
 * the whole store), NOT timestamptz. The #1524 bulk query compared it via
 * to_timestamp($n) → 'cannot compare bigint >= timestamp with time zone' on
 * EVERY run; a catch-all fallback masked it (silent internal degradation,
 * #1633/#1640/#1535 class).
 *
 * No query builder exists — the SQL is an inline template literal in
 * server.mjs. This test extracts it from source and pins:
 *   1. every org_studio_comments column ref exists in the real schema
 *      (reuses the #1647 guard + manifest, which now covers the table);
 *   2. no to_timestamp() coercion is applied to created_at comparisons —
 *      the bigint column must be compared to bigint params directly.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  extractSqlStatementsFromSource,
  validateSqlAgainstSchema,
  type SchemaManifest,
} from '@/lib/sql-schema-guard';

const manifestFile = JSON.parse(
  readFileSync(join(process.cwd(), 'schema', 'org-studio-schema.json'), 'utf-8'),
);
const MANIFEST: SchemaManifest = manifestFile.tables;

const serverSource = readFileSync(join(process.cwd(), 'server.mjs'), 'utf-8');
const commentStatements = extractSqlStatementsFromSource(serverSource).filter((s) =>
  /org_studio_comments/i.test(s.sql),
);

describe('metrics bulk comments query (#1649)', () => {
  it('manifest covers org_studio_comments and created_at is present', () => {
    expect(MANIFEST.org_studio_comments).toBeDefined();
    expect(MANIFEST.org_studio_comments).toContain('created_at');
    expect(MANIFEST.org_studio_comments).toContain('task_id');
    expect(MANIFEST.org_studio_comments).toContain('scope_kind');
  });

  it('finds the bulk comments SQL in server.mjs (extraction sanity)', () => {
    expect(commentStatements.length).toBeGreaterThanOrEqual(1);
  });

  it('every column ref in server.mjs org_studio_comments SQL exists in the real schema', () => {
    const violations: string[] = [];
    for (const s of commentStatements) {
      for (const v of validateSqlAgainstSchema(s.sql, MANIFEST)) {
        violations.push(`server.mjs:${s.line} — ${v.message}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('created_at (bigint ms-epoch) is never compared via to_timestamp()', () => {
    // The exact #1649 bug shape: created_at >= to_timestamp($1 / 1000.0).
    // created_at must be compared against bigint params directly.
    for (const s of commentStatements) {
      const bad = /created_at\s*(>=|<=|<|>|=)\s*to_timestamp/i.test(s.sql);
      expect(
        bad,
        `server.mjs:${s.line} compares bigint created_at against to_timestamp() — ` +
          `'cannot compare bigint >= timestamptz'. Pass ms-epoch params directly (#1649).`,
      ).toBe(false);
    }
  });

  it('regression: the original buggy shape would be caught', () => {
    const buggy = `SELECT id FROM org_studio_comments WHERE scope_kind = 'task' AND created_at >= to_timestamp($1 / 1000.0)`;
    expect(/created_at\s*(>=|<=|<|>|=)\s*to_timestamp/i.test(buggy)).toBe(true);
  });
});
