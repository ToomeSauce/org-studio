#!/usr/bin/env node
/**
 * normalize-assignees.mjs (#1218)
 *
 * One-time backfill: walk every task and every comment in Postgres and
 * canonicalize the assignee/author field against settings.teammates.
 *
 * Why a script (not just the API): two ghost rows from #1217 (#1186, #1187)
 * couldn't be cleared via the API — repeated timeouts suggested a Postgres
 * lock or a LISTEN handler loop. So we go straight to the DB with UPDATE.
 *
 * Idempotent: re-running produces zero changes.
 *
 * Usage:
 *   node scripts/normalize-assignees.mjs           # apply
 *   node scripts/normalize-assignees.mjs --dry-run # preview
 */

import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

const DRY_RUN = process.argv.includes('--dry-run');

const DATABASE_URL = process.env.DATABASE_URL || (() => {
  try {
    const env = fs.readFileSync(path.resolve('.env.local'), 'utf8');
    return env.split('\n').find((l) => l.startsWith('DATABASE_URL='))?.split('=').slice(1).join('=');
  } catch {
    return undefined;
  }
})();

if (!DATABASE_URL) {
  console.error('DATABASE_URL not set (env or .env.local). Aborting.');
  process.exit(1);
}

// Inline copy of canonicalizeTeammate so this script has no TS-build dep.
function canonicalizeTeammate(value, teammates) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (raw.toLowerCase() === 'you') return null;
  const list = Array.isArray(teammates) ? teammates : [];
  const lc = raw.toLowerCase();
  for (const t of list) {
    if (!t) continue;
    if (
      t.id?.toLowerCase() === lc ||
      t.agentId?.toLowerCase() === lc ||
      t.name?.toLowerCase() === lc
    ) {
      return t.name || raw;
    }
  }
  return raw;
}

const pool = new Pool({ connectionString: DATABASE_URL });

async function loadTeammates(client) {
  const { rows } = await client.query(`SELECT data FROM org_studio_settings WHERE id = 'default'`);
  const data = rows[0]?.data || {};
  return Array.isArray(data.teammates) ? data.teammates : [];
}

async function main() {
  const client = await pool.connect();
  const summary = {
    tasks_scanned: 0,
    tasks_updated: 0,
    comments_scanned: 0,
    comments_updated_in_table: 0,
    tasks_with_comments_jsonb_updated: 0,
    failures: [],
    samples: { tasks: [], comments: [] },
  };

  try {
    const teammates = await loadTeammates(client);
    console.log(`Loaded ${teammates.length} teammates from settings.`);
    if (DRY_RUN) console.log('--- DRY RUN: no writes will happen. ---');

    // -------- Tasks: top-level assignee column --------
    const taskRows = await client.query(
      `SELECT id, ticket_number, assignee FROM org_studio_tasks`
    );
    summary.tasks_scanned = taskRows.rows.length;
    for (const r of taskRows.rows) {
      const before = r.assignee;
      const after = canonicalizeTeammate(before, teammates);
      // Only write when value actually changes (treat null===null as same).
      const changed = (before ?? null) !== (after ?? null);
      if (!changed) continue;
      summary.samples.tasks.push({ id: r.id, ticket: r.ticket_number, before, after });
      if (DRY_RUN) {
        summary.tasks_updated++;
        continue;
      }
      try {
        // Direct UPDATE — bypasses the API. Tight statement_timeout to surface
        // any lock contention quickly (the #1186/#1187 ghost rows from #1217).
        await client.query(`SET LOCAL statement_timeout = '5s'`);
        await client.query(
          `UPDATE org_studio_tasks SET assignee = $1, updated_at = NOW() WHERE id = $2`,
          [after, r.id]
        );
        summary.tasks_updated++;
      } catch (e) {
        summary.failures.push({ kind: 'task', id: r.id, ticket: r.ticket_number, error: e.message });
      }
    }

    // -------- Comments: dedicated table + tasks.comments JSONB --------

    // 1) org_studio_comments — top-level author column.
    let commentRows;
    try {
      commentRows = await client.query(
        `SELECT id, task_id, author FROM org_studio_comments`
      );
    } catch (e) {
      if (e.code === '42P01') {
        console.log('org_studio_comments table not present — skipping (comments live only in tasks.comments JSONB).');
        commentRows = { rows: [] };
      } else {
        throw e;
      }
    }
    summary.comments_scanned = commentRows.rows.length;
    for (const c of commentRows.rows) {
      const before = c.author;
      const after = canonicalizeTeammate(before, teammates);
      const changed = (before ?? null) !== (after ?? null);
      if (!changed) continue;
      // org_studio_comments.author is NOT NULL — if canonicalize returns null
      // (e.g. legacy "You"), fall back to a stable placeholder string instead
      // of nulling. That's the closest equivalent to "drop and re-resolve".
      const writeValue = after == null ? 'unknown' : after;
      summary.samples.comments.push({ id: c.id, task_id: c.task_id, before, after: writeValue });
      if (DRY_RUN) {
        summary.comments_updated_in_table++;
        continue;
      }
      try {
        await client.query(`SET LOCAL statement_timeout = '5s'`);
        await client.query(
          `UPDATE org_studio_comments SET author = $1 WHERE id = $2`,
          [writeValue, c.id]
        );
        summary.comments_updated_in_table++;
      } catch (e) {
        summary.failures.push({ kind: 'comment', id: c.id, task_id: c.task_id, error: e.message });
      }
    }

    // 2) tasks.comments JSONB — rewrite per-task if any embedded author drifts.
    const tasksWithComments = await client.query(
      `SELECT id, ticket_number, comments FROM org_studio_tasks
       WHERE comments IS NOT NULL AND comments::text != '[]'`
    );
    for (const t of tasksWithComments.rows) {
      const arr = typeof t.comments === 'string' ? JSON.parse(t.comments) : (t.comments || []);
      if (!Array.isArray(arr) || arr.length === 0) continue;
      let mutated = false;
      const next = arr.map((c) => {
        if (!c || typeof c !== 'object') return c;
        const before = c.author;
        const canon = canonicalizeTeammate(before, teammates);
        const writeValue = canon == null ? 'unknown' : canon;
        if ((before ?? null) !== writeValue) {
          mutated = true;
          return { ...c, author: writeValue };
        }
        return c;
      });
      if (!mutated) continue;
      if (DRY_RUN) {
        summary.tasks_with_comments_jsonb_updated++;
        continue;
      }
      try {
        await client.query(`SET LOCAL statement_timeout = '5s'`);
        await client.query(
          `UPDATE org_studio_tasks SET comments = $1::jsonb, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(next), t.id]
        );
        summary.tasks_with_comments_jsonb_updated++;
      } catch (e) {
        summary.failures.push({
          kind: 'task_comments_jsonb',
          id: t.id,
          ticket: t.ticket_number,
          error: e.message,
        });
      }
    }

    console.log('--- Summary ---');
    console.log(JSON.stringify({
      tasks_scanned: summary.tasks_scanned,
      tasks_updated: summary.tasks_updated,
      comments_scanned: summary.comments_scanned,
      comments_updated_in_table: summary.comments_updated_in_table,
      tasks_with_comments_jsonb_updated: summary.tasks_with_comments_jsonb_updated,
      failures: summary.failures,
    }, null, 2));
    if (summary.samples.tasks.length) {
      console.log('Sample task changes (up to first 10):');
      console.log(JSON.stringify(summary.samples.tasks.slice(0, 10), null, 2));
    }
    if (summary.samples.comments.length) {
      console.log('Sample comment changes (up to first 10):');
      console.log(JSON.stringify(summary.samples.comments.slice(0, 10), null, 2));
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
