import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { rpc } from '@/lib/gateway-rpc';
import { getStoreProvider } from '@/lib/store-provider';

interface VisionDocResponse {
  content: string;
  parsedMeta?: Record<string, any>;
  roadmapProgress?: {
    currentVersion?: string;
    total: number;
    done: number;
  };
}

/**
 * Parse the ## Meta section of a VISION.md file
 */
function parseMeta(content: string): Record<string, any> {
  const meta: Record<string, any> = {};
  const metaMatch = content.match(/## Meta\n([\s\S]*?)(?=\n## (?!#)|$)/);
  if (!metaMatch) return meta;

  const metaBlock = metaMatch[1];
  const lines = metaBlock.split('\n');
  
  for (const line of lines) {
    const match = line.match(/^-\s+\*\*(.+?)\*\*\s*(.+)$/);
    if (match) {
      const key = match[1].replace(/:$/, '').toLowerCase().replace(/\s+/g, '');
      const value = match[2].trim();
      meta[key] = value;
    }
  }
  
  return meta;
}

/**
 * Parse the ## Roadmap section to calculate progress
 */
function parseRoadmapProgress(content: string): { currentVersion?: string; total: number; done: number } {
  const result: { currentVersion?: string; total: number; done: number } = { currentVersion: undefined, total: 0, done: 0 };
  
  const roadmapMatch = content.match(/## Roadmap\n([\s\S]*?)(?=\n## (?!#)|$)/);
  if (!roadmapMatch) return result;

  const roadmapBlock = roadmapMatch[1];
  
  // Extract current version from first version header
  const versionMatch = roadmapBlock.match(/###\s+v([\d.]+)\s+\(current\)/);
  if (versionMatch) {
    result.currentVersion = versionMatch[1];
  }
  
  // Count all checkboxes in the current version section
  const checkboxes = roadmapBlock.match(/- \[([ xX])\]/g) || [];
  result.total = checkboxes.length;
  result.done = checkboxes.filter(cb => cb.includes('x') || cb.includes('X')).length;
  
  return result;
}

/**
 * Resolve the file path for a project's vision doc.
 * Returns { absPath, content } or { absPath: null, content: null }.
 */
async function resolveDocPath(projectId: string): Promise<{ absPath: string | null; content: string | null; visionDocPath?: string }> {
  let visionDocPath: string | undefined;
  try {
    const store = await getStoreProvider().read();
    const project = (store.projects || []).find((p: any) => p.id === projectId);
    visionDocPath = project?.visionDocPath;
  } catch { /* ignore errors */ }

  // Try visionDocPath first
  if (visionDocPath) {
    const absPath = visionDocPath.startsWith('/') ? visionDocPath : join(process.cwd(), visionDocPath);
    if (existsSync(absPath)) {
      try { return { absPath, content: readFileSync(absPath, 'utf-8'), visionDocPath }; } catch { /* fall through */ }
    }
    // Path configured but file doesn't exist yet — return path for creation
    return { absPath, content: null, visionDocPath };
  }

  // Fallback to docs/visions/{id}.md
  const fallbackPath = join(process.cwd(), 'docs', 'visions', `${projectId}.md`);
  if (existsSync(fallbackPath)) {
    try { return { absPath: fallbackPath, content: readFileSync(fallbackPath, 'utf-8') }; } catch { /* fall through */ }
  }

  // Default creation path
  return { absPath: fallbackPath, content: null };
}

/**
 * GET /api/vision/[id]/doc
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await params;
    let content: string | null = null;

    // Try Postgres first (if DATABASE_URL is set)
    if (process.env.DATABASE_URL) {
      try {
        const pg = await import('pg');
        const client = new pg.Client(process.env.DATABASE_URL);
        await client.connect();
        try {
          const result = await client.query(
            'SELECT content FROM org_studio_vision_docs WHERE project_id = $1',
            [projectId]
          );
          if (result.rows.length > 0) {
            content = result.rows[0].content;
          }
        } finally {
          await client.end();
        }
      } catch (pgErr: any) {
        console.error(`[vision-doc GET] Postgres error: ${pgErr.message}`);
        // Fall through to filesystem
      }
    }

    // Fall back to filesystem
    if (!content) {
      const { content: fsContent } = await resolveDocPath(projectId);
      content = fsContent;
    }

    // If still not found, check if remote access without storage
    if (!content) {
      const isRemote = req.headers.get('host')?.includes('localhost') === false;
      if (isRemote && !process.env.DATABASE_URL) {
        return NextResponse.json(
          {
            error: 'Vision documents require database storage for remote access. Configure DATABASE_URL to enable.',
            noRemoteStorage: true,
          },
          { status: 404 }
        );
      }
      return NextResponse.json(
        { error: `Vision document not found for project ${projectId}`, content: null },
        { status: 404 }
      );
    }

    const parsedMeta = parseMeta(content);
    const roadmapProgress = parseRoadmapProgress(content);

    return NextResponse.json({ content, parsedMeta, roadmapProgress } as VisionDocResponse);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/**
 * PUT /api/vision/[id]/doc
 * Body: { content: string }
 * Saves the vision document markdown to Postgres (or disk if not available), then:
 *  1. Notifies devOwner/qaOwner agents via chat.send RPC
 *  2. Triggers ORG.md re-sync (touch store.json to fire the fs.watch)
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await params;
    const body = await req.json();
    const newContent = body?.content;

    if (typeof newContent !== 'string') {
      return NextResponse.json({ error: 'content (string) is required' }, { status: 400 });
    }

    // Try Postgres first
    let savedToDb = false;
    if (process.env.DATABASE_URL) {
      try {
        const pg = await import('pg');
        const client = new pg.Client(process.env.DATABASE_URL);
        await client.connect();
        try {
          const updatedAt = Math.floor(Date.now());
          await client.query(
            `INSERT INTO org_studio_vision_docs (project_id, content, updated_at)
             VALUES ($1, $2, $3)
             ON CONFLICT (project_id) DO UPDATE SET content = $2, updated_at = $3`,
            [projectId, newContent, updatedAt]
          );
          savedToDb = true;
        } finally {
          await client.end();
        }
      } catch (pgErr: any) {
        console.error(`[vision-doc PUT] Postgres error: ${pgErr.message}`);
        // Fall through to filesystem
      }
    }

    // Fall back to filesystem if Postgres failed or not configured
    if (!savedToDb) {
      const { absPath } = await resolveDocPath(projectId);
      if (!absPath) {
        return NextResponse.json({ error: 'Could not resolve doc path' }, { status: 500 });
      }

      // Ensure directory exists
      const dir = dirname(absPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(absPath, newContent, 'utf-8');
    }

    // Re-parse after save
    const parsedMeta = parseMeta(newContent);
    const roadmapProgress = parseRoadmapProgress(newContent);

    // --- Load project + store for notifications ---
    let project: any = null;
    let store: any = null;
    try {
      store = await getStoreProvider().read();
      project = (store.projects || []).find((p: any) => p.id === projectId);
    } catch { /* non-fatal */ }

    const projectName = project?.name || projectId;

    // --- 1. Notify agents (devOwner, qaOwner) ---
    if (project) {
      const agentIds = new Set<string>();
      const teammates = store?.settings?.teammates || [];

      // Resolve name → agentId
      for (const ownerField of ['devOwner', 'qaOwner'] as const) {
        const name = project[ownerField];
        if (!name) continue;
        const match = teammates.find((t: any) =>
          t.name?.toLowerCase() === name.toLowerCase() ||
          t.agentId?.toLowerCase() === name.toLowerCase()
        );
        if (match?.agentId) agentIds.add(match.agentId);
      }

      for (const agentId of agentIds) {
        const message = `📝 **Vision doc updated: ${projectName}**\n` +
          `↳ Edited in Org Studio by ${project.visionOwner || 'a team member'}.\n` +
          `Version: ${parsedMeta.version || '?'} · Roadmap: ${roadmapProgress.done}/${roadmapProgress.total}\n` +
          `Review the latest vision doc for any changes to roadmap, priorities, or boundaries.`;

        rpc('chat.send', {
          sessionKey: `agent:${agentId}:main`,
          message,
          idempotencyKey: `vision-doc-${projectId}-${Date.now()}`,
        }).catch(() => {}); // best-effort
      }
    }

    // --- 2. Trigger ORG.md re-sync ---
    // The LISTEN/NOTIFY mechanism in Postgres handles this automatically.
    // For file-based storage, a write to the vision doc file doesn't need ORG.md re-sync triggered separately.
    // (If needed in the future, use an explicit endpoint instead of touching store.json.)

    return NextResponse.json({ ok: true, parsedMeta, roadmapProgress });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
