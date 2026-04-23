/**
 * Single source of truth for Postgres typed-column ↔ JS-field mapping.
 *
 * Why this exists
 * ===============
 * Before this module, every Postgres write path in `store-provider.ts` had
 * to re-state the same column list four times: once in the destructure,
 * once in the INSERT/UPDATE column list, once as placeholder numbers, and
 * once in the values array. Reconstruction (row → object) had its own
 * hand-written fifth copy. We also had separate copies of each of those
 * across `write()`, `createTask/Project()`, `updateTask/Project()`.
 *
 * Drift was inevitable. When the `version` column was added, it was
 * forgotten in `write()` AND `createTask()` — resulting in silent data
 * loss: the value fell into the `data` JSONB overflow, the typed column
 * stayed NULL, and the old reconstructor hid it by letting `data` win the
 * merge. Flipping the reconstructor to prefer the column exposed the bug
 * as Garage's "No active sprint" regression on 2026-04-23.
 *
 * How it works
 * ============
 * Each `ColumnDef` entry maps one JS field name to one SQL column, with a
 * small policy hint (is it JSON? is it BIGINT? what's the default for
 * NULL-ish values? is it the primary key?). `buildInsert`, `buildUpdate`,
 * and `rowToObject` all derive their behaviour from the same list.
 *
 * Adding a new typed column = one entry in this file. No other changes
 * to write paths required.
 */

export type ColumnDef = {
  /** JS/TS field name (camelCase) */
  field: string;
  /** Postgres column name (snake_case) */
  col: string;
  /** Treat as JSON: stringify on write, parse on read */
  json?: boolean;
  /** Treat as BIGINT: coerce to number on read, pass through on write */
  bigint?: boolean;
  /** Default value applied on write when the field is null/undefined */
  defaultOnWrite?: any;
  /** Also treat 0/'' as missing when applying defaultOnWrite (old `||` semantics) */
  falsyIsMissing?: boolean;
  /** Mark as primary key (used by UPDATE WHERE clauses) */
  pk?: boolean;
  /** Whether to skip in UPDATE SET (e.g. id is never updated) */
  skipInUpdate?: boolean;
};

/**
 * Task columns. Order here defines INSERT column order and $N placeholders.
 * Any field NOT listed here falls into the `data` JSONB overflow.
 *
 * When adding a new typed column:
 *   1. Add a migration that ALTERs the table.
 *   2. Add an entry here.
 *   3. That's it.
 */
export const TASK_COLUMNS: ColumnDef[] = [
  { field: 'id',              col: 'id',                pk: true, skipInUpdate: true },
  { field: 'ticketNumber',    col: 'ticket_number' },
  { field: 'title',           col: 'title' },
  { field: 'status',          col: 'status',            defaultOnWrite: 'backlog', falsyIsMissing: true },
  { field: 'projectId',       col: 'project_id' },
  { field: 'assignee',        col: 'assignee' },
  { field: 'priority',        col: 'priority' },
  { field: 'testType',        col: 'test_type' },
  { field: 'testAssignee',    col: 'test_assignee' },
  { field: 'initiatedBy',     col: 'initiated_by' },
  { field: 'description',     col: 'description' },
  { field: 'doneWhen',        col: 'done_when' },
  { field: 'constraints',     col: 'constraints' },
  { field: 'testPlan',        col: 'test_plan' },
  { field: 'reviewNotes',     col: 'review_notes' },
  { field: 'loopCount',       col: 'loop_count',        defaultOnWrite: 0,      falsyIsMissing: true },
  { field: 'loopPausedAt',    col: 'loop_paused_at',    bigint: true },
  { field: 'loopPauseReason', col: 'loop_pause_reason' },
  { field: 'lastActivityAt',  col: 'last_activity_at',  bigint: true },
  { field: 'createdAt',       col: 'created_at',        bigint: true },
  { field: 'version',         col: 'version' },
  { field: 'statusHistory',   col: 'status_history',    json: true,  defaultOnWrite: [] },
  { field: 'comments',        col: 'comments',          json: true,  defaultOnWrite: [] },
];

/**
 * Project columns. Same rules as tasks.
 */
export const PROJECT_COLUMNS: ColumnDef[] = [
  { field: 'id',          col: 'id',            pk: true, skipInUpdate: true },
  { field: 'name',        col: 'name' },
  { field: 'description', col: 'description' },
  { field: 'phase',       col: 'phase',         defaultOnWrite: 'active', falsyIsMissing: true },
  { field: 'owner',       col: 'owner' },
  { field: 'priority',    col: 'priority' },
  { field: 'sortOrder',   col: 'sort_order',    defaultOnWrite: 5000, falsyIsMissing: true },
  { field: 'createdAt',   col: 'created_at',    bigint: true },
  { field: 'createdBy',   col: 'created_by' },
];

// ───────────────────────────────────────────────────────────────────────
// Row → object (reconstruct)
// ───────────────────────────────────────────────────────────────────────

function parseBigint(val: any): number | null {
  if (val === null || val === undefined) return null;
  const n = Number(val);
  return isNaN(n) ? null : n;
}

function parseJsonMaybe(val: any, fallback: any): any {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return fallback; }
  }
  return val;
}

/**
 * Reconstruct a JS object from a raw Postgres row using a column map.
 * Typed columns always win over the overflow `data` blob — never the other
 * way around (the "shadow keys" bug).
 *
 * Keys with `undefined` values are stripped so the shape matches the file
 * store. Keys with `null` values are preserved — `null` is valid data.
 */
export function rowToObject(row: any, columns: ColumnDef[]): Record<string, any> {
  const overflow = parseJsonMaybe(row.data, {});
  const typed: Record<string, any> = {};

  for (const def of columns) {
    const raw = row[def.col];
    if (def.bigint) {
      typed[def.field] = parseBigint(raw);
    } else if (def.json) {
      typed[def.field] = parseJsonMaybe(raw, def.defaultOnWrite ?? null);
    } else {
      typed[def.field] = raw;
    }
  }

  // Typed columns win over overflow (don't let stale `data.version`
  // shadow a fresh column value).
  const merged = { ...overflow, ...typed };
  return Object.fromEntries(Object.entries(merged).filter(([_, v]) => v !== undefined));
}

// ───────────────────────────────────────────────────────────────────────
// Object → row parts (for INSERT and UPDATE)
// ───────────────────────────────────────────────────────────────────────

/**
 * Compute the `data` JSONB overflow: every key on `obj` NOT claimed by a
 * typed column. This is deterministic — the column map is the only thing
 * that decides what's typed vs overflow.
 */
export function computeOverflow(obj: Record<string, any>, columns: ColumnDef[]): Record<string, any> {
  const typedFields = new Set(columns.map(c => c.field));
  const overflow: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!typedFields.has(k)) overflow[k] = v;
  }
  return overflow;
}

/**
 * Compute the value a typed column should receive on write, applying the
 * `defaultOnWrite` policy for null/undefined values and JSON-stringifying
 * when appropriate. Falsy-non-null values are preserved exactly (e.g. 0).
 */
function valueForWrite(obj: Record<string, any>, def: ColumnDef): any {
  const raw = obj[def.field];
  const useDefault = def.falsyIsMissing
    ? !raw
    : raw === null || raw === undefined;

  if (def.json) {
    const v = useDefault ? (def.defaultOnWrite ?? null) : raw;
    return JSON.stringify(v);
  }

  if (useDefault && def.defaultOnWrite !== undefined) return def.defaultOnWrite;
  if (useDefault) return null;

  // For non-JSON columns with a falsy defaultOnWrite, only substitute on
  // null/undefined (which we've already handled above). We don't want to
  // e.g. turn loopCount=0 into 0 via `|| 0` — that's the original bug
  // pattern we're replacing. Here 0 is preserved as 0.
  return raw;
}

export type InsertPlan = {
  sql: string;
  values: any[];
};

/**
 * Build an `INSERT INTO <table> (...) VALUES ($1, ...)` statement from a
 * column map, plus the `data` overflow column and `workspace_id` trailer.
 *
 * Caller supplies the table name and workspace id. The column list and
 * placeholder numbers are derived from `columns` — impossible for them to
 * drift out of sync.
 */
export function buildInsert(
  table: string,
  columns: ColumnDef[],
  obj: Record<string, any>,
  workspaceId: string,
): InsertPlan {
  const cols = columns.map(c => c.col);
  const values = columns.map(c => valueForWrite(obj, c));

  // Append data + workspace_id
  cols.push('data', 'workspace_id');
  values.push(JSON.stringify(computeOverflow(obj, columns)));
  values.push(workspaceId);

  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;
  return { sql, values };
}

export type UpdatePlan = {
  sql: string;
  values: any[];
};

/**
 * Build an `UPDATE <table> SET ... WHERE id = $N AND workspace_id = $M`
 * statement. The pk column is excluded from SET (you don't update primary
 * keys); pk + workspace_id go into the WHERE and become the final two
 * bound parameters.
 */
export function buildUpdate(
  table: string,
  columns: ColumnDef[],
  obj: Record<string, any>,
  workspaceId: string,
): UpdatePlan {
  const setCols = columns.filter(c => !c.skipInUpdate);
  const assignments: string[] = [];
  const values: any[] = [];

  let n = 1;
  for (const def of setCols) {
    assignments.push(`${def.col} = $${n++}`);
    values.push(valueForWrite(obj, def));
  }

  // data overflow
  assignments.push(`data = $${n++}`);
  values.push(JSON.stringify(computeOverflow(obj, columns)));

  // WHERE binds
  const pk = columns.find(c => c.pk);
  if (!pk) throw new Error(`buildUpdate: column map for ${table} has no pk`);
  const pkBind = n++;
  const wsBind = n++;
  values.push(obj[pk.field]);
  values.push(workspaceId);

  const sql = `UPDATE ${table} SET ${assignments.join(', ')} WHERE ${pk.col} = $${pkBind} AND workspace_id = $${wsBind}`;
  return { sql, values };
}
