/**
 * #1647 — real-schema guard for promote-path SQL.
 *
 * The launch-already-current-1594 fake-pg-client accepts ANY SQL shape, so
 * the #1535 bug (claim_started_at/claim_lease_expires_at written as typed
 * columns when they live in the `data` JSONB bag) passed tests and failed
 * per-row in prod, silently: launch returned ok:true movedTasks:0.
 *
 * Three layers here:
 *  1. Parser unit tests (extractColumnRefs) — the guard only guards what it
 *     can parse; pin what that is.
 *  2. THE regression: re-introduce the exact #1535 bug shape and assert the
 *     guard flags it (ticket doneWhen).
 *  3. Live guard: extract every SQL statement from src/lib/project-state.ts
 *     and validate against schema/org-studio-schema.json (generated from the
 *     real DB by scripts/refresh-schema-manifest.mjs). If this fails after a
 *     schema change, refresh the manifest in the same commit.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  extractColumnRefs,
  validateSqlAgainstSchema,
  extractSqlStatementsFromSource,
  type SchemaManifest,
} from '@/lib/sql-schema-guard';

const manifestFile = JSON.parse(
  readFileSync(join(process.cwd(), 'schema', 'org-studio-schema.json'), 'utf-8'),
);
const MANIFEST: SchemaManifest = manifestFile.tables;

// ── 1. Parser behavior ──────────────────────────────────────────────────

describe('extractColumnRefs parser (#1647)', () => {
  it('extracts UPDATE SET-clause columns', () => {
    const refs = extractColumnRefs(
      `UPDATE org_studio_tasks SET status = $1, version = $2 WHERE id = $3`,
    );
    const setCols = refs.filter((r) => r.clause === 'set').map((r) => r.column);
    expect(setCols).toEqual(['status', 'version']);
    const whereCols = refs.filter((r) => r.clause === 'where').map((r) => r.column);
    expect(whereCols).toEqual(['id']);
  });

  it('extracts INSERT column lists', () => {
    const refs = extractColumnRefs(
      `INSERT INTO org_studio_roadmap_versions (id, project_id, version) VALUES ($1,$2,$3)`,
    );
    expect(refs.map((r) => r.column)).toEqual(['id', 'project_id', 'version']);
  });

  it('handles multi-line SQL with comments and JSONB expressions without false refs', () => {
    const refs = extractColumnRefs(`
      UPDATE org_studio_tasks
      SET status = $1,
          -- claim fields live in the data bag
          data = (COALESCE(data, '{}'::jsonb) - 'claim_started_at' - 'claim_lease_expires_at')
      WHERE id = $2 AND workspace_id = $3 AND status = $4
    `);
    const cols = refs.map((r) => r.column);
    expect(cols).toContain('status');
    expect(cols).toContain('data');
    expect(cols).toContain('workspace_id');
    // string-literal JSONB keys must NOT be parsed as columns
    expect(cols).not.toContain('claim_started_at');
    expect(cols).not.toContain('claim_lease_expires_at');
  });

  it('ignores non-org_studio tables', () => {
    expect(extractColumnRefs(`UPDATE other_table SET foo = $1`)).toEqual([]);
  });

  it('skips function calls and casts in SELECT lists', () => {
    const refs = extractColumnRefs(
      `SELECT COUNT(*)::int AS n FROM org_studio_tasks WHERE project_id = $1`,
    );
    // COUNT(*)::int is not a bare identifier — only the WHERE ref extracted
    expect(refs.map((r) => r.column)).toEqual(['project_id']);
  });

  it('does not treat ORDER BY / LIMIT identifiers as WHERE refs', () => {
    const refs = extractColumnRefs(
      `SELECT version, sort_order FROM org_studio_roadmap_versions
       WHERE project_id = $1 AND status = $2 AND sort_order > $3
       ORDER BY sort_order ASC LIMIT 1`,
    );
    const whereCols = refs.filter((r) => r.clause === 'where').map((r) => r.column);
    expect(whereCols).toEqual(['project_id', 'status', 'sort_order']);
  });
});

// ── 2. THE regression: the #1535 bug shape must be caught ───────────────

describe('#1535 bug shape is caught (ticket doneWhen)', () => {
  it('flags claim_started_at / claim_lease_expires_at written as typed columns', () => {
    // This is (a condensed form of) the exact SQL that shipped in #1535 and
    // threw 'column "claim_started_at" does not exist' per-row in prod.
    const buggySql = `
      UPDATE org_studio_tasks
      SET status = $1,
          version = $2,
          claim_started_at = NULL,
          claim_lease_expires_at = NULL
      WHERE id = $3 AND workspace_id = $4 AND status = $5
    `;
    const violations = validateSqlAgainstSchema(buggySql, MANIFEST);
    const badCols = violations.map((v) => v.column).sort();
    expect(badCols).toEqual(['claim_lease_expires_at', 'claim_started_at']);
    expect(violations[0].message).toContain('does not exist in the real schema');
    expect(violations[0].message).toContain('data JSONB bag');
  });

  it('the FIXED shape (JSONB bag edit) passes clean', () => {
    const fixedSql = `
      UPDATE org_studio_tasks
      SET status = $1,
          version = $2,
          data = (COALESCE(data, '{}'::jsonb) - 'claim_started_at' - 'claim_lease_expires_at')
      WHERE id = $3 AND workspace_id = $4 AND status = $5
    `;
    expect(validateSqlAgainstSchema(fixedSql, MANIFEST)).toEqual([]);
  });

  it('flags a misspelled column in an INSERT', () => {
    const v = validateSqlAgainstSchema(
      `INSERT INTO org_studio_roadmap_versions (id, project_id, verzion) VALUES ($1,$2,$3)`,
      MANIFEST,
    );
    expect(v.map((x) => x.column)).toEqual(['verzion']);
  });
});

// ── 3. Live guard over project-state.ts ─────────────────────────────────

describe('promote-path SQL matches the real schema (live guard)', () => {
  const sourcePath = join(process.cwd(), 'src', 'lib', 'project-state.ts');
  const sourceText = readFileSync(sourcePath, 'utf-8');
  const statements = extractSqlStatementsFromSource(sourceText);

  it('finds the promote-path SQL statements (extraction sanity)', () => {
    // 15+ statements live in promoteProjectToNextVersion + helpers today.
    // If this drops sharply, extraction broke (e.g. SQL moved to interpolated
    // templates) — fix the extractor, don't delete the guard.
    expect(statements.length).toBeGreaterThanOrEqual(10);
  });

  it('project-state.ts SQL uses no ${} interpolation (extraction assumption)', () => {
    for (const s of statements) {
      expect(s.sql).not.toContain('${');
    }
  });

  it('every column reference exists in the real schema', () => {
    const allViolations: string[] = [];
    for (const s of statements) {
      for (const v of validateSqlAgainstSchema(s.sql, MANIFEST)) {
        allViolations.push(`project-state.ts:${s.line} — ${v.message}`);
      }
    }
    expect(allViolations, allViolations.join('\n')).toEqual([]);
  });

  it('manifest covers the tables promote-path SQL touches', () => {
    expect(MANIFEST.org_studio_tasks).toBeDefined();
    expect(MANIFEST.org_studio_projects).toBeDefined();
    expect(MANIFEST.org_studio_roadmap_versions).toBeDefined();
    // Spot-check known-real columns so we notice a corrupted manifest.
    expect(MANIFEST.org_studio_tasks).toContain('status');
    expect(MANIFEST.org_studio_tasks).toContain('data');
    expect(MANIFEST.org_studio_tasks).toContain('status_history');
    // And the #1535 offenders must NOT be typed columns.
    expect(MANIFEST.org_studio_tasks).not.toContain('claim_started_at');
    expect(MANIFEST.org_studio_tasks).not.toContain('claim_lease_expires_at');
  });
});
