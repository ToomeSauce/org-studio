/**
 * scripts/rename-proj-mc-to-proj-org-studio.mjs
 *
 * One-shot migration: rename the legacy "proj-mc" project ID (Mission
 * Control vintage) to "proj-org-studio" across all canonical Postgres
 * tables. Done because:
 *   1. The user-facing project name has been "Org Studio" for a while.
 *   2. Agents kept (incorrectly) creating tasks with projectId="proj-org-studio"
 *      under the assumption it matched the display name. Those tasks then
 *      silently failed dispatch because no project with that ID existed.
 *   3. We're hardening the addTask validator to reject unknown projectId
 *      in a follow-up commit; this migration aligns the data so the
 *      validator's natural behaviour matches user intuition.
 *
 * What this rewrites (one transaction):
 *   - org_studio_projects.id: 'proj-mc' → 'proj-org-studio'
 *   - org_studio_tasks.project_id: both 'proj-mc' and the existing
 *       orphans 'proj-org-studio' converge on 'proj-org-studio'
 *   - org_studio_roadmap_versions.project_id and id (rv-proj-mc-* → rv-proj-org-studio-*)
 *   - org_studio_vision_docs.project_id
 *   - JSONB rewrites: sectionId 'sec-main-proj-mc' → 'sec-main-proj-org-studio'
 *     in projects.data + tasks.data
 *   - JSONB rewrites: rv id strings inside projects.data sections[].versions[].id
 *   - JSONB rewrite: settings.data Telegram topic routing entry
 *
 * NOT rewritten:
 *   - org_studio_incidents (108k rows, 580 mention proj-mc): historical
 *     audit log. Past events stay as recorded; future incidents will use
 *     the new ID.
 *
 * Modes:
 *   node scripts/rename-proj-mc-to-proj-org-studio.mjs --dry-run
 *   node scripts/rename-proj-mc-to-proj-org-studio.mjs --execute
 *
 * Pre-flight:
 *   - Writes a backup JSON to backups/pre-rename-proj-mc-<ts>.json.
 *   - Counts every target row before/after.
 *   - Aborts the transaction on any count drift.
 */

import pg from 'pg';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const args = new Set(process.argv.slice(2));
const DRY_RUN = !args.has('--execute');

function loadDbUrl() {
  const env = readFileSync(resolve(ROOT, '.env.local'), 'utf8');
  const m = env.match(/DATABASE_URL=(.+)/);
  if (!m) throw new Error('DATABASE_URL not found in .env.local');
  return m[1].trim().replace(/^["']|["']$/g, '');
}

const OLD = 'proj-mc';
const NEW = 'proj-org-studio';
const OLD_SEC = `sec-main-${OLD}`;
const NEW_SEC = `sec-main-${NEW}`;
const OLD_RV_PREFIX = `rv-${OLD}-`;
const NEW_RV_PREFIX = `rv-${NEW}-`;

async function main() {
  const dbUrl = loadDbUrl();
  const pool = new pg.Pool({ connectionString: dbUrl });
  const client = await pool.connect();

  console.log(`mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'EXECUTE'}`);

  try {
    // ---------- 1. Backup ----------
    const backup = {};
    const backupTables = [
      ['org_studio_projects', `WHERE id = '${OLD}' OR id = '${NEW}'`],
      ['org_studio_tasks', `WHERE project_id = '${OLD}' OR project_id = '${NEW}'`],
      ['org_studio_roadmap_versions', `WHERE project_id = '${OLD}' OR project_id = '${NEW}'`],
      ['org_studio_vision_docs', `WHERE project_id = '${OLD}' OR project_id = '${NEW}'`],
      ['org_studio_settings', `WHERE data::text LIKE '%${OLD}%'`],
    ];
    for (const [t, where] of backupTables) {
      const r = await client.query(`SELECT * FROM ${t} ${where}`);
      backup[t] = r.rows;
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = resolve(ROOT, `backups/pre-rename-proj-mc-${ts}.json`);
    mkdirSync(dirname(backupPath), { recursive: true });
    writeFileSync(backupPath, JSON.stringify(backup, null, 2));
    console.log(`✓ backup: ${backupPath}`);
    for (const [t] of backupTables) {
      console.log(`    ${t}: ${backup[t].length} rows`);
    }

    // ---------- 2. Pre counts ----------
    const pre = await counts(client);
    console.log('\nPRE counts:'); printCounts(pre);

    // ---------- 3. Transaction ----------
    await client.query('BEGIN');

    // 3a. projects.id
    await client.query(
      `UPDATE org_studio_projects SET id = $1 WHERE id = $2`,
      [NEW, OLD],
    );

    // 3b. tasks.project_id (both old and the existing orphans land on NEW)
    await client.query(
      `UPDATE org_studio_tasks SET project_id = $1 WHERE project_id IN ($2, $1)`,
      [NEW, OLD],
    );

    // 3c. roadmap_versions.project_id + id
    await client.query(
      `UPDATE org_studio_roadmap_versions
       SET project_id = $1,
           id = REPLACE(id, $2, $3)
       WHERE project_id = $4`,
      [NEW, OLD_RV_PREFIX, NEW_RV_PREFIX, OLD],
    );

    // 3d. vision_docs.project_id
    await client.query(
      `UPDATE org_studio_vision_docs SET project_id = $1 WHERE project_id = $2`,
      [NEW, OLD],
    );

    // 3e. JSONB rewrites — projects.data
    //   - sectionId 'sec-main-proj-mc' → 'sec-main-proj-org-studio'
    //   - rv ids embedded in sections[].versions[].id
    //   - any stray reference to OLD in autonomy/etc. (cast-to-text replace)
    await client.query(
      `UPDATE org_studio_projects
       SET data = REPLACE(REPLACE(REPLACE(data::text, $1, $2), $3, $4), $5, $6)::jsonb
       WHERE id = $6`,
      [OLD_SEC, NEW_SEC, OLD_RV_PREFIX, NEW_RV_PREFIX, OLD, NEW],
    );

    // 3f. JSONB rewrites — tasks.data
    //   - sectionId only. Don't rewrite OLD literal in tasks.data (would risk
    //     hitting historic comment text mentioning "proj-mc").
    await client.query(
      `UPDATE org_studio_tasks
       SET data = REPLACE(data::text, $1, $2)::jsonb
       WHERE data::text LIKE '%' || $1 || '%'`,
      [OLD_SEC, NEW_SEC],
    );

    // 3g. JSONB rewrites — settings.data (Telegram topic routing only)
    //   Single known reference: a topic-config row with projectId="proj-mc".
    //   Use targeted REPLACE on the JSON text — safer than jsonb_set traversal
    //   because the path varies.
    await client.query(
      `UPDATE org_studio_settings
       SET data = REPLACE(data::text, $1, $2)::jsonb
       WHERE data::text LIKE '%' || $3 || '%'`,
      [`"projectId":"${OLD}"`, `"projectId":"${NEW}"`, OLD],
    );

    // ---------- 4. Post counts ----------
    const post = await counts(client);
    console.log('\nPOST counts (in-tx):'); printCounts(post);

    // ---------- 5. Sanity ----------
    const errs = sanityCheck(pre, post);
    if (errs.length > 0) {
      console.error('\n✗ sanity-check failures:');
      for (const e of errs) console.error('  -', e);
      console.error('\nROLLBACK');
      await client.query('ROLLBACK');
      process.exit(2);
    }
    console.log('\n✓ sanity-check OK');

    if (DRY_RUN) {
      console.log('\n--dry-run: ROLLBACK (no changes persisted)');
      await client.query('ROLLBACK');
    } else {
      console.log('\n--execute: COMMIT');
      await client.query('COMMIT');
    }
  } catch (err) {
    console.error('error:', err.message);
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

async function counts(client) {
  const o = {};
  o.projects_old = (await client.query(`SELECT COUNT(*)::int AS n FROM org_studio_projects WHERE id=$1`, [OLD])).rows[0].n;
  o.projects_new = (await client.query(`SELECT COUNT(*)::int AS n FROM org_studio_projects WHERE id=$1`, [NEW])).rows[0].n;
  o.tasks_old = (await client.query(`SELECT COUNT(*)::int AS n FROM org_studio_tasks WHERE project_id=$1`, [OLD])).rows[0].n;
  o.tasks_new = (await client.query(`SELECT COUNT(*)::int AS n FROM org_studio_tasks WHERE project_id=$1`, [NEW])).rows[0].n;
  o.rv_old = (await client.query(`SELECT COUNT(*)::int AS n FROM org_studio_roadmap_versions WHERE project_id=$1`, [OLD])).rows[0].n;
  o.rv_new = (await client.query(`SELECT COUNT(*)::int AS n FROM org_studio_roadmap_versions WHERE project_id=$1`, [NEW])).rows[0].n;
  o.rv_id_old = (await client.query(`SELECT COUNT(*)::int AS n FROM org_studio_roadmap_versions WHERE id LIKE $1`, [`${OLD_RV_PREFIX}%`])).rows[0].n;
  o.rv_id_new = (await client.query(`SELECT COUNT(*)::int AS n FROM org_studio_roadmap_versions WHERE id LIKE $1`, [`${NEW_RV_PREFIX}%`])).rows[0].n;
  o.vd_old = (await client.query(`SELECT COUNT(*)::int AS n FROM org_studio_vision_docs WHERE project_id=$1`, [OLD])).rows[0].n;
  o.vd_new = (await client.query(`SELECT COUNT(*)::int AS n FROM org_studio_vision_docs WHERE project_id=$1`, [NEW])).rows[0].n;
  o.task_data_old_sec = (await client.query(`SELECT COUNT(*)::int AS n FROM org_studio_tasks WHERE data::text LIKE $1`, [`%${OLD_SEC}%`])).rows[0].n;
  o.task_data_new_sec = (await client.query(`SELECT COUNT(*)::int AS n FROM org_studio_tasks WHERE data::text LIKE $1`, [`%${NEW_SEC}%`])).rows[0].n;
  o.settings_old = (await client.query(`SELECT COUNT(*)::int AS n FROM org_studio_settings WHERE data::text LIKE $1`, [`%"projectId":"${OLD}"%`])).rows[0].n;
  o.settings_new = (await client.query(`SELECT COUNT(*)::int AS n FROM org_studio_settings WHERE data::text LIKE $1`, [`%"projectId":"${NEW}"%`])).rows[0].n;
  return o;
}

function printCounts(o) {
  for (const [k, v] of Object.entries(o)) console.log(`  ${k}: ${v}`);
}

function sanityCheck(pre, post) {
  const errs = [];
  if (post.projects_old !== 0) errs.push(`projects.id=${OLD} should be 0, got ${post.projects_old}`);
  if (post.projects_new !== 1) errs.push(`projects.id=${NEW} should be 1, got ${post.projects_new}`);
  if (post.tasks_old !== 0) errs.push(`tasks.project_id=${OLD} should be 0, got ${post.tasks_old}`);
  // tasks_new must equal pre tasks_old + pre tasks_new (orphans absorbed)
  const expectedTasksNew = pre.tasks_old + pre.tasks_new;
  if (post.tasks_new !== expectedTasksNew) {
    errs.push(`tasks.project_id=${NEW} should be ${expectedTasksNew} (pre old ${pre.tasks_old} + pre new ${pre.tasks_new}), got ${post.tasks_new}`);
  }
  if (post.rv_old !== 0) errs.push(`rv.project_id=${OLD} should be 0, got ${post.rv_old}`);
  if (post.rv_new !== pre.rv_old) errs.push(`rv.project_id=${NEW} should be ${pre.rv_old}, got ${post.rv_new}`);
  if (post.rv_id_old !== 0) errs.push(`rv.id LIKE ${OLD_RV_PREFIX}% should be 0, got ${post.rv_id_old}`);
  if (post.rv_id_new !== pre.rv_id_old + pre.rv_id_new) errs.push(`rv.id LIKE ${NEW_RV_PREFIX}% should be ${pre.rv_id_old + pre.rv_id_new}, got ${post.rv_id_new}`);
  if (post.vd_old !== 0) errs.push(`vd.project_id=${OLD} should be 0, got ${post.vd_old}`);
  if (post.vd_new !== pre.vd_old + pre.vd_new) errs.push(`vd.project_id=${NEW} should be ${pre.vd_old + pre.vd_new}, got ${post.vd_new}`);
  if (post.task_data_old_sec !== 0) errs.push(`task.data references ${OLD_SEC} should be 0, got ${post.task_data_old_sec}`);
  if (post.settings_old !== 0) errs.push(`settings ref to ${OLD} should be 0, got ${post.settings_old}`);
  return errs;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
