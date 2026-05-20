import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequestWithContext, requireWriteScope } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * GET|POST /api/admin/roadmap-audit
 *
 * #1461 — Surface historical roadmap-versions data quality issues so a
 * human can decide per-project remediation. Detect-only; never auto-repair
 * (per ticket constraint: "Don't auto-repair historical bad data").
 *
 * Findings:
 *
 *   - multi_current:  more than one row with status='current' for the same
 *                     (workspace_id, project_id). Blocks the partial unique
 *                     index from migrations/1461.
 *
 *   - empty_title:    title IS NULL or whitespace-only. Means version
 *                     cards render with no human-readable label.
 *
 *   - missing_owner:  owner IS NULL/empty. Means the version has no
 *                     responsible party — auto-dispatch/notification logic
 *                     has to fall back to project-level defaults.
 *
 *   - unknown_version_type:  version_type outside the allow-list
 *                            {outcome, foundation, chore, qa, gtm}. Should
 *                            be impossible after migrations/1461 installs
 *                            the CHECK constraint, but we audit anyway
 *                            because the constraint can be dropped/
 *                            bypassed in older envs.
 *
 * Auth: Bearer ORG_STUDIO_API_KEY + write scope. Read-only operation, but
 * gating writes keeps admin endpoints behind a single key.
 *
 * Response shape:
 *   {
 *     ok: true,
 *     summary: { multi_current, empty_title, missing_owner, unknown_version_type },
 *     findings: {
 *       multi_current: [{ workspace_id, project_id, count, versions: [...] }],
 *       empty_title:   [{ workspace_id, project_id, version, id }],
 *       missing_owner: [{ workspace_id, project_id, version, id }],
 *       unknown_version_type: [{ workspace_id, project_id, version, version_type, id }],
 *     }
 *   }
 */

const ALLOWED_VERSION_TYPES = ['outcome', 'foundation', 'chore', 'qa', 'gtm'];

async function runAudit(req: NextRequest): Promise<NextResponse> {
  // Auth: require write scope (admin endpoint). Read-only output, but
  // gated so casual reads don't leak the full multi-workspace shape.
  const authCtx = await authenticateRequestWithContext(req);
  if (authCtx.error) return authCtx.error;
  const scopeFail = requireWriteScope(authCtx.context);
  if (scopeFail) return scopeFail;

  if (!process.env.DATABASE_URL) {
    return NextResponse.json(
      { ok: false, error: 'database_required', message: 'roadmap-audit requires DATABASE_URL.' },
      { status: 400 },
    );
  }

  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const multiCurrentRes = await client.query(
      `SELECT workspace_id, project_id, COUNT(*) AS count,
              array_agg(version ORDER BY sort_order, version) AS versions,
              array_agg(id ORDER BY sort_order, version) AS ids
         FROM org_studio_roadmap_versions
        WHERE status = 'current'
        GROUP BY workspace_id, project_id
        HAVING COUNT(*) > 1`,
    );
    const emptyTitleRes = await client.query(
      `SELECT workspace_id, project_id, version, id
         FROM org_studio_roadmap_versions
        WHERE title IS NULL OR btrim(title) = ''
        ORDER BY workspace_id, project_id, sort_order`,
    );
    const missingOwnerRes = await client.query(
      `SELECT workspace_id, project_id, version, id
         FROM org_studio_roadmap_versions
        WHERE owner IS NULL OR btrim(owner) = ''
        ORDER BY workspace_id, project_id, sort_order`,
    );
    const unknownTypeRes = await client.query(
      `SELECT workspace_id, project_id, version, version_type, id
         FROM org_studio_roadmap_versions
        WHERE version_type IS NOT NULL
          AND version_type <> ALL($1::text[])
        ORDER BY workspace_id, project_id, sort_order`,
      [ALLOWED_VERSION_TYPES],
    );

    const multi_current = multiCurrentRes.rows.map((r: any) => ({
      workspace_id: r.workspace_id,
      project_id: r.project_id,
      count: Number(r.count),
      versions: r.versions,
      ids: r.ids,
    }));

    return NextResponse.json({
      ok: true,
      summary: {
        multi_current: multi_current.length,
        empty_title: emptyTitleRes.rows.length,
        missing_owner: missingOwnerRes.rows.length,
        unknown_version_type: unknownTypeRes.rows.length,
      },
      findings: {
        multi_current,
        empty_title: emptyTitleRes.rows,
        missing_owner: missingOwnerRes.rows,
        unknown_version_type: unknownTypeRes.rows,
      },
      // Hint to the human: every finding here is informational. The audit
      // never mutates rows. Fix manually per-project, then re-run
      // migrations/1461-roadmap-version-invariants.mjs to install the
      // partial unique index once multi_current is clean.
      next_action: multi_current.length > 0
        ? 'multi_current_violations_must_be_resolved_manually_then_rerun_migration_1461'
        : 'all_clean_or_only_advisory_findings',
    });
  } catch (err: any) {
    console.error('[roadmap-audit #1461]', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  } finally {
    client.release();
    await pool.end();
  }
}

export async function GET(req: NextRequest) {
  return runAudit(req);
}

export async function POST(req: NextRequest) {
  return runAudit(req);
}
