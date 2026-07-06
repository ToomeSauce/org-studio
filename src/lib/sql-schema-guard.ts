/**
 * #1647 — SQL ↔ real-schema guard.
 *
 * Fake-pg-client tests (launch-already-current-1594) accept ANY SQL shape —
 * they pattern-match on substrings, so a statement referencing a nonexistent
 * column passes tests and then throws per-row in prod (the #1535 promote-
 * sweep bug: claim_started_at/claim_lease_expires_at written as typed
 * columns when they live in the `data` JSONB bag; every UPDATE threw
 * 'column does not exist', was caught per item, and launch reported
 * ok:true movedTasks:0).
 *
 * This module extracts column references from SQL statements and validates
 * them against a schema manifest generated from the REAL database
 * (schema/org-studio-schema.json, refreshed via
 * scripts/refresh-schema-manifest.mjs).
 *
 * Scope — deliberately conservative to avoid false positives:
 *   - UPDATE <table> SET a = ..., b = ...   → validates SET-clause LHS names
 *   - INSERT INTO <table> (a, b, c)         → validates the column list
 *   - WHERE a = $1 AND b = $2               → validates simple `ident op` refs
 *   - SELECT a, b FROM <table>              → validates bare top-level idents
 * Function calls, casts, string literals, JSONB path ops, aliases and
 * subquery internals are skipped, not guessed at. A guard that cries wolf
 * gets deleted; one that only checks what it can check reliably survives.
 */

export interface SchemaManifest {
  [tableName: string]: string[];
}

export interface ColumnRef {
  table: string;
  column: string;
  clause: 'set' | 'insert' | 'where' | 'select';
}

export interface Violation extends ColumnRef {
  message: string;
}

const SQL_KEYWORDS = new Set([
  'select', 'from', 'where', 'and', 'or', 'not', 'null', 'is', 'in', 'as',
  'order', 'by', 'asc', 'desc', 'limit', 'offset', 'group', 'having',
  'coalesce', 'nullif', 'count', 'sum', 'min', 'max', 'avg', 'now',
  'jsonb', 'int', 'text', 'bigint', 'boolean', 'true', 'false',
  'values', 'insert', 'into', 'update', 'set', 'delete', 'on', 'conflict',
  'do', 'nothing', 'returning', 'distinct', 'case', 'when', 'then', 'else',
  'end', 'exists', 'between', 'like', 'ilike',
]);

/** Strip string literals ('...') and $n placeholders so their contents never look like identifiers. */
function stripLiterals(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")   // string literals (incl. escaped '')
    .replace(/\$\d+/g, '$?');
}

/** Split on commas at parenthesis depth 0. */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function isPlainIdent(tok: string): boolean {
  return /^[a-z_][a-z0-9_]*$/.test(tok) && !SQL_KEYWORDS.has(tok);
}

/** Remove SQL comments (-- to end of line). */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

/**
 * Extract column references from one SQL statement. Returns refs only for
 * org_studio_* tables (others are out of manifest scope).
 */
export function extractColumnRefs(rawSql: string): ColumnRef[] {
  const sql = stripLiterals(stripComments(rawSql)).replace(/\s+/g, ' ').trim();
  const refs: ColumnRef[] = [];

  // ── UPDATE <table> SET <assignments> [WHERE ...] ──
  const upd = sql.match(/^update\s+([a-z_][a-z0-9_]*)\s+set\s+(.*?)(\s+where\s+(.*))?$/i);
  if (upd) {
    const table = upd[1].toLowerCase();
    if (table.startsWith('org_studio_')) {
      for (const assignment of splitTopLevel(upd[2])) {
        const lhs = assignment.split('=')[0]?.trim().toLowerCase();
        if (lhs && isPlainIdent(lhs)) refs.push({ table, column: lhs, clause: 'set' });
      }
      if (upd[4]) refs.push(...extractWhereRefs(table, upd[4]));
    }
    return refs;
  }

  // ── INSERT INTO <table> (cols) ──
  const ins = sql.match(/^insert\s+into\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)/i);
  if (ins) {
    const table = ins[1].toLowerCase();
    if (table.startsWith('org_studio_')) {
      for (const col of ins[2].split(',')) {
        const c = col.trim().toLowerCase();
        if (isPlainIdent(c)) refs.push({ table, column: c, clause: 'insert' });
      }
    }
    return refs;
  }

  // ── SELECT <list> FROM <table> [WHERE ...] ──
  const sel = sql.match(/^select\s+(.*?)\s+from\s+([a-z_][a-z0-9_]*)(\s+where\s+(.*))?$/i);
  if (sel) {
    const table = sel[2].toLowerCase();
    if (table.startsWith('org_studio_')) {
      for (const item of splitTopLevel(sel[1])) {
        const tok = item.trim().toLowerCase();
        // only bare identifiers — skip *, functions, casts, aliases
        if (isPlainIdent(tok)) refs.push({ table, column: tok, clause: 'select' });
      }
      if (sel[4]) refs.push(...extractWhereRefs(table, sel[4]));
    }
    return refs;
  }

  return refs;
}

/** Extract `ident <op>` refs from a WHERE clause (simple comparisons only). */
function extractWhereRefs(table: string, whereClause: string): ColumnRef[] {
  const refs: ColumnRef[] = [];
  // Strip trailing ORDER BY / LIMIT so their identifiers aren't parsed as WHERE refs.
  const w = whereClause.replace(/\s+(order\s+by|limit|group\s+by)\s.*$/i, '');
  // identifiers immediately followed by a comparison operator or IS
  const re = /\b([a-z_][a-z0-9_]*)\s*(=|!=|<>|<=|>=|<|>|\bis\b)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(w)) !== null) {
    const c = m[1].toLowerCase();
    if (isPlainIdent(c)) refs.push({ table, column: c, clause: 'where' });
  }
  return refs;
}

/**
 * Validate one SQL statement against the manifest. Unknown tables (not in
 * the manifest) are skipped — the manifest defines the guard's scope.
 */
export function validateSqlAgainstSchema(
  sql: string,
  manifest: SchemaManifest,
): Violation[] {
  const violations: Violation[] = [];
  for (const ref of extractColumnRefs(sql)) {
    const cols = manifest[ref.table];
    if (!cols) continue; // table out of manifest scope
    if (!cols.includes(ref.column)) {
      violations.push({
        ...ref,
        message: `${ref.table}.${ref.column} (${ref.clause} clause) does not exist in the real schema — #1535 class bug. If the field lives in the data JSONB bag, use data->>'${ref.column}' or edit the bag; if the schema legitimately changed, refresh the manifest: node scripts/refresh-schema-manifest.mjs`,
      });
    }
  }
  return violations;
}

/**
 * Extract every SQL template literal that references an org_studio_* table
 * from a TypeScript/JS source file's text. Anchors matches at template
 * literals that BEGIN with a SQL verb, so backtick pairing stays correct in
 * files that also contain interpolated (non-SQL) template literals. Extracted
 * SQL must not use ${} interpolation (true for the audited files — unit
 * tests pin that assumption).
 */
export function extractSqlStatementsFromSource(sourceText: string): Array<{ sql: string; line: number }> {
  const out: Array<{ sql: string; line: number }> = [];
  const re = /`(\s*(?:SELECT|UPDATE|INSERT|DELETE)\b[^`]*)`/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sourceText)) !== null) {
    const sql = m[1];
    if (/org_studio_/i.test(sql)) {
      out.push({ sql, line: sourceText.slice(0, m.index).split('\n').length });
    }
  }
  return out;
}
