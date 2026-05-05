const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const envPath = path.resolve(__dirname, '..', '.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const r = await c.query(
    `SELECT data::text FROM org_studio_projects WHERE id = 'proj-garage'`,
  );
  const row = r.rows[0];
  const data = JSON.parse(row.data);
  const comps = data.components || data.sections || [];
  console.log('autonomy.approvedThrough:', data.autonomy?.approvedThrough);
  console.log('has components:', !!data.components, 'len:', (data.components||[]).length);
  console.log('has sections:', !!data.sections, 'len:', (data.sections||[]).length);
  for (const c of (data.sections || [])) {
    console.log('  sections[]:', c.id, 'approvedThrough=', c.approvedThrough, 'approvedVersionsLen=', (c.approvedVersions||[]).length);
  }
  for (const cmp of comps) {
    console.log({
      id: cmp.id,
      approvedThrough: cmp.approvedThrough,
      approvedVersionsLen: Array.isArray(cmp.approvedVersions) ? cmp.approvedVersions.length : 'n/a',
    });
  }
  await c.end();
})();
