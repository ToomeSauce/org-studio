/**
 * launch-prep.ts
 *
 * Plumbing-only auto-mint helpers for the launch path. Bridges the gap
 * between project-create and project-launchable: a project in `state=active`
 * with a `sections[].versions[]` JSON roadmap may still be missing the
 * out-of-band rows that the launch + promote pipeline needs (a vision doc
 * row in `org_studio_vision_docs`, and one row per version in
 * `org_studio_roadmap_versions`).
 *
 * On launch attempt, mirror the in-store JSON into those tables. Don't
 * auto-mint *content* (roadmap items, approvals) — that's a planning step,
 * not plumbing. If the embedded roadmap has zero items, surface a clear
 * error rather than papering over the missing planning.
 *
 * Filed as #1229.
 */

import type { Pool } from 'pg';

export interface LaunchPrepResult {
  ok: boolean;
  reason?: string;
  mintedDoc?: boolean;
  mintedVersions?: string[];
}

interface PrepDeps {
  /** pg Pool; if omitted and DATABASE_URL is set we'll lazy-import and create one */
  pool?: Pool;
  /** workspace id (defaults to 'default-workspace' until v0.17 multi-workspace lands) */
  workspaceId?: string;
}

/**
 * Build a stub vision doc from a project record. Intentionally short — the
 * owner is expected to flesh it out during their first version. The point
 * is just to unblock launch.
 */
export function buildStubVisionDoc(project: any): string {
  const name = project?.name || project?.id || 'Untitled Project';
  const owner = project?.owner || project?.devOwner || 'TBD';
  const description = project?.description?.trim() || '_No description provided._';

  // Pick a target version to mention. Prefer currentVersion, otherwise the
  // first planned version we can find, otherwise a placeholder.
  const componentsList: any[] = Array.isArray(project?.components) && project.components.length > 0
    ? project.components
    : Array.isArray(project?.sections) ? project.sections : [];
  const firstVersion =
    project?.currentVersion ||
    componentsList[0]?.versions?.[0]?.version ||
    '0.1.0';

  return `# ${name} — Vision

## North Star

${description}

> _Auto-generated stub — owner to expand._

## Owner

**${owner}**

## ${firstVersion}

Goal for ${firstVersion} not yet defined. Owner to fill in during planning.

## Change history

- ${new Date().toISOString().slice(0, 10)} — Auto-minted stub vision doc on first launch attempt (#1229).
`;
}

async function getPool(deps: PrepDeps): Promise<Pool | null> {
  if (deps.pool) return deps.pool;
  if (!process.env.DATABASE_URL) return null;
  const pg = await import('pg');
  return new pg.Pool({ connectionString: process.env.DATABASE_URL });
}

function versionSortKeyLocal(version: string): number {
  // Mirror lib/version-utils' sort key behavior at a coarse level. The
  // value only needs to be monotonic-ish per project for the dispatcher.
  // CalVer YYYY.MM.DD → integer-ish, SemVer → 1000*major + 10*minor + patch.
  const calver = version.match(/^(\d{4})\.(\d{1,2})\.(\d{1,3})$/);
  if (calver) {
    const [, y, m, d] = calver;
    return Number(y) * 10000 + Number(m) * 100 + Number(d);
  }
  const semver = version.match(/^(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (semver) {
    const [, maj, min, pat] = semver;
    return Number(maj) * 1_000_000 + Number(min) * 1_000 + Number(pat || 0);
  }
  return 0;
}

/**
 * Mirror missing rows for a project's embedded roadmap into
 * `org_studio_roadmap_versions`. Idempotent — only inserts when no row
 * exists for `(project_id, version)`. Does NOT touch existing rows.
 */
export async function mirrorMissingRoadmapVersions(
  projectId: string,
  project: any,
  pool: Pool,
  workspaceId: string,
): Promise<string[]> {
  const componentsList: any[] = Array.isArray(project?.components) && project.components.length > 0
    ? project.components
    : Array.isArray(project?.sections) ? project.sections : [];

  const minted: string[] = [];

  const client = await pool.connect();
  try {
    for (const component of componentsList) {
      const versions: any[] = Array.isArray(component?.versions) ? component.versions : [];
      const componentOwner = component?.owner || project?.owner || project?.devOwner || null;

      for (const v of versions) {
        const versionStr: string | undefined = v?.version;
        if (!versionStr || typeof versionStr !== 'string') continue;

        const exists = await client.query(
          `SELECT 1 FROM org_studio_roadmap_versions
           WHERE project_id = $1 AND version = $2 AND workspace_id = $3 LIMIT 1`,
          [projectId, versionStr, workspaceId],
        );
        if (exists.rows.length > 0) continue;

        const items = Array.isArray(v?.items) ? v.items : [];
        // Auto-mint ids for items lacking one (matches roadmap upsert behavior).
        const itemsWithIds = items.map((it: any) => {
          if (it && typeof it === 'object' && !it.id) {
            const newId = `item-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
            return { ...it, id: newId };
          }
          return it;
        });

        const rvId = v?.id || `rv-${projectId}-${versionStr.replace(/\./g, '-')}`;
        const sortOrder = typeof v?.sort_order === 'number' ? v.sort_order : versionSortKeyLocal(versionStr);
        const status = v?.status || 'planned';
        const versionType = v?.version_type || v?.versionType || 'outcome';
        const title = v?.title || `${versionStr}`;
        const owner = v?.owner || componentOwner;
        const createdAt = typeof v?.createdAt === 'number' ? v.createdAt : Date.now();

        await client.query(
          `INSERT INTO org_studio_roadmap_versions
             (id, project_id, version, title, status, items, sort_order, created_at, version_type, workspace_id, owner)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)
           ON CONFLICT (project_id, version) DO NOTHING`,
          [
            rvId,
            projectId,
            versionStr,
            title,
            status,
            JSON.stringify(itemsWithIds),
            sortOrder,
            createdAt,
            versionType,
            workspaceId,
            owner,
          ],
        );
        minted.push(versionStr);
      }
    }
  } finally {
    client.release();
  }

  return minted;
}

/**
 * Auto-mint a vision doc stub if none exists. Returns whether it minted one.
 */
export async function ensureVisionDoc(
  projectId: string,
  project: any,
  pool: Pool,
  workspaceId: string,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    const exists = await client.query(
      `SELECT 1 FROM org_studio_vision_docs WHERE project_id = $1 AND workspace_id = $2 LIMIT 1`,
      [projectId, workspaceId],
    );
    if (exists.rows.length > 0) return false;

    const stub = buildStubVisionDoc(project);
    await client.query(
      `INSERT INTO org_studio_vision_docs (project_id, content, updated_at, workspace_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id) DO NOTHING`,
      [projectId, stub, Date.now(), workspaceId],
    );
    console.info(`[launch-prep] auto-minted stub vision doc for ${projectId}`);
    return true;
  } finally {
    client.release();
  }
}

/**
 * Run all launch-time auto-mints. Order:
 *   1. Mirror any missing rv-table rows from `sections[].versions[]`.
 *   2. Mirror missing vision doc.
 *
 * Vision doc is *last* so we don't waste a stub on a project that fails the
 * roadmap check anyway. Idempotent. Safe to call on every launch attempt.
 */
export async function ensureLaunchPreconditions(
  projectId: string,
  project: any,
  deps: PrepDeps = {},
): Promise<LaunchPrepResult> {
  const pool = await getPool(deps);
  if (!pool) {
    // No DATABASE_URL: file-store mode. There's no rv-table or vision-docs
    // table in that mode, and the launch path falls back to disk for both
    // — nothing for us to do. Treat as success.
    return { ok: true, mintedDoc: false, mintedVersions: [] };
  }

  const wsId = deps.workspaceId || 'default-workspace';

  let mintedVersions: string[] = [];
  try {
    mintedVersions = await mirrorMissingRoadmapVersions(projectId, project, pool, wsId);
  } catch (e: any) {
    console.error(`[launch-prep] mirrorMissingRoadmapVersions failed for ${projectId}:`, e?.message);
    return { ok: false, reason: `roadmap mirror failed: ${e?.message}` };
  }

  let mintedDoc = false;
  try {
    mintedDoc = await ensureVisionDoc(projectId, project, pool, wsId);
  } catch (e: any) {
    console.error(`[launch-prep] ensureVisionDoc failed for ${projectId}:`, e?.message);
    return { ok: false, reason: `vision doc mint failed: ${e?.message}` };
  }

  return { ok: true, mintedDoc, mintedVersions };
}
