#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const envPath = path.resolve(__dirname, '..', '.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const c = await pool.connect();
  try {
    const r1 = await c.query('SELECT COUNT(*) FROM org_studio_comments');
    console.log('comments_in_table:', r1.rows[0].count);
    const r2 = await c.query("SELECT COUNT(*) AS tasks_with_comments, SUM(jsonb_array_length(comments)) AS total_inline FROM org_studio_tasks WHERE comments IS NOT NULL AND comments::text != '[]'");
    console.log('tasks_with_inline:', r2.rows[0].tasks_with_comments, 'total_inline:', r2.rows[0].total_inline);
    // Investigate skips: comments missing required fields
    const r3 = await c.query("SELECT id AS task_id, comments FROM org_studio_tasks WHERE comments IS NOT NULL AND comments::text != '[]'");
    let missingId = 0, missingAuthor = 0, missingContent = 0;
    const samples = [];
    for (const row of r3.rows) {
      const cs = typeof row.comments === 'string' ? JSON.parse(row.comments) : row.comments;
      for (const cm of cs) {
        if (!cm.id || !cm.author || !cm.content) {
          if (!cm.id) missingId++;
          if (!cm.author) missingAuthor++;
          if (!cm.content) missingContent++;
          if (samples.length < 3) samples.push({ task: row.task_id, c: cm });
        }
      }
    }
    console.log('missingId:', missingId, 'missingAuthor:', missingAuthor, 'missingContent:', missingContent);
    console.log('samples:', JSON.stringify(samples, null, 2));
    // Verify a known-good comment exists
    const r4 = await c.query("SELECT id, scope_kind, task_id, scope_key, author, LEFT(content, 60) AS content_preview FROM org_studio_comments ORDER BY created_at DESC LIMIT 3");
    console.log('recent_rows:', JSON.stringify(r4.rows, null, 2));
  } finally { c.release(); await pool.end(); }
})().catch(e => { console.error('err:', e.message); process.exit(1); });
