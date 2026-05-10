#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
for (const line of fs.readFileSync(path.resolve(__dirname,'..','.env.local'),'utf8').split('\n')) {
  const m=line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/); if (m) process.env[m[1]]=m[2].replace(/^["']|["']$/g,'');
}
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ID = process.argv[2];
(async () => {
  const c = await pool.connect();
  try {
    const r1 = await c.query('SELECT id, scope_key, author, LEFT(content, 80) AS content FROM org_studio_comments WHERE id = $1', [ID]);
    console.log('in_normalized_table:', r1.rows.length, JSON.stringify(r1.rows, null, 2));
    const r2 = await c.query("SELECT id FROM org_studio_tasks t, jsonb_array_elements(t.comments) c WHERE c->>'id' = $1", [ID]);
    console.log('in_inline_jsonb:', r2.rows.length, 'rows');
  } finally { c.release(); await pool.end(); }
})().catch(e => { console.error(e.message); process.exit(1); });
