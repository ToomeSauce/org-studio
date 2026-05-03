#!/usr/bin/env node
/**
 * #1181 — One-shot backfill: copy item.done flags from
 * org_studio_roadmap_versions (canonical) into the project document's
 * embedded sections[].versions[].items[] copy.
 *
 * Background: syncRoadmapItemForTask used to only write the canonical
 * table. The project doc embedded copy drifted whenever a task flipped
 * to/from done. RoadmapWithApprovalHorizon renders from the project doc
 * (passed via prop), so the UI showed stale state.
 *
 * The forward fix is in src/lib/roadmap-sync.ts (sync now writes both
 * places in one transaction). This script clears the existing drift.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/backfill-project-doc-items.mjs [--dry]
 */

import pg from 'pg';

const DRY = process.argv.includes('--dry');
const WORKSPACE = process.env.WORKSPACE_ID || 'default-workspace';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url });

async function main() {
  const client = await pool.connect();
  let projectsTouched = 0;
  let itemsFlipped = 0;
  let itemsAlreadyAligned = 0;

  try {
    const projects = await client.query(
      `SELECT id, data FROM org_studio_projects WHERE workspace_id = $1`,
      [WORKSPACE],
    );

    for (const p of projects.rows) {
      const data = typeof p.data === 'string' ? JSON.parse(p.data) : p.data;
      if (!data?.sections?.length) continue;

      // Build canonical map: {version -> {taskId -> done}}
      const canonRows = await client.query(
        `SELECT version, items FROM org_studio_roadmap_versions
         WHERE project_id = $1 AND workspace_id = $2`,
        [p.id, WORKSPACE],
      );
      const canonByVersion = new Map();
      for (const r of canonRows.rows) {
        const map = new Map();
        for (const it of r.items || []) {
          if (it.taskId) map.set(it.taskId, it.done === true);
        }
        canonByVersion.set(r.version, map);
      }

      let docChanged = false;
      for (const section of data.sections) {
        for (const v of section.versions || []) {
          const canon = canonByVersion.get(v.version);
          if (!canon) continue;
          for (const item of v.items || []) {
            if (!item.taskId) continue;
            const canonDone = canon.has(item.taskId)
              ? canon.get(item.taskId)
              : item.done === true; // not in canonical → leave alone
            if ((item.done === true) !== canonDone) {
              item.done = canonDone;
              itemsFlipped++;
              docChanged = true;
            } else {
              itemsAlreadyAligned++;
            }
          }
        }
      }

      if (docChanged) {
        projectsTouched++;
        if (!DRY) {
          await client.query(
            `UPDATE org_studio_projects SET data = $1 WHERE id = $2 AND workspace_id = $3`,
            [JSON.stringify(data), p.id, WORKSPACE],
          );
        }
        console.log(`${DRY ? '[DRY] ' : ''}${p.id}: items reconciled`);
      }
    }

    console.log('---');
    console.log(`Projects touched: ${projectsTouched}`);
    console.log(`Items flipped:    ${itemsFlipped}`);
    console.log(`Items already OK: ${itemsAlreadyAligned}`);
    if (DRY) console.log('(dry run — no writes)');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
