/**
 * GET /api/roadmap/{projectId}/health
 *
 * Diagnostic endpoint for canonical-vs-shadow roadmap drift on a single
 * project. Added 2026-05-12 (#1314) after Trevor caught Thrivor returning
 * 200 OK on POST /api/roadmap upserts while the dashboard rendered stale
 * roadmaps for hours — the canonical table had the new versions but the
 * `project.sections[].versions[]` shadow didn't.
 *
 * Returns:
 * {
 *   projectId: string,
 *   canonicalVersions: number,           // count in org_studio_roadmap_versions
 *   shadowSummary: [
 *     { container: 'sections'|'components', id, name?, count }
 *   ],
 *   missingFromAllShadows: string[],     // versions present in canonical but not in any shadow
 *   inSync: boolean,
 *   mode: 'postgres' | 'file',
 * }
 *
 * Read-only. No auth (matches /api/health/roadmap).
 */
import { NextRequest, NextResponse } from 'next/server';
import { cloudReadGate } from '@/lib/read-gate';
import { inspectRoadmapDrift } from '@/lib/roadmap-sync';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const denied = await cloudReadGate(req); // #1624 F-P5
  if (denied) return denied;
  const { projectId } = await params;

  if (!process.env.DATABASE_URL) {
    return NextResponse.json({
      projectId,
      mode: 'file',
      canonicalVersions: 0,
      shadowSummary: [],
      missingFromAllShadows: [],
      inSync: true,
      detail: 'Drift inspection only meaningful in Postgres mode (file mode has no shadow split).',
    });
  }

  try {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const client = await pool.connect();
    try {
      const drift = await inspectRoadmapDrift(client, projectId);
      return NextResponse.json({
        projectId,
        mode: 'postgres',
        canonicalVersions: drift.canonicalCount,
        shadowSummary: drift.shadowSummary,
        missingFromAllShadows: drift.missingFromAllShadows,
        inSync: drift.inSync,
      });
    } finally {
      client.release();
      await pool.end();
    }
  } catch (err: any) {
    console.error('[Roadmap Health]', err);
    return NextResponse.json(
      { error: err?.message || String(err), projectId },
      { status: 500 },
    );
  }
}
