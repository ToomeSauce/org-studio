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
  // Strip approvedThrough from every section / component on every project.
  const r = await c.query(`SELECT id, data FROM org_studio_projects`);
  let touched = 0;
  for (const row of r.rows) {
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    let changed = false;
    for (const key of ['sections', 'components']) {
      if (Array.isArray(data[key])) {
        for (const cmp of data[key]) {
          if ('approvedThrough' in cmp) {
            delete cmp.approvedThrough;
            changed = true;
          }
        }
      }
    }
    // Also strip stale autonomy.approvedThrough.
    if (data.autonomy && 'approvedThrough' in data.autonomy) {
      delete data.autonomy.approvedThrough;
      changed = true;
    }
    if (changed) {
      await c.query(`UPDATE org_studio_projects SET data = $1 WHERE id = $2`, [JSON.stringify(data), row.id]);
      console.log(`✓ stripped ${row.id}`);
      touched++;
    }
  }
  console.log(`Done. ${touched} project rows updated.`);
  await c.end();
})();
