/**
 * #1592 — POST/GET /api/memory/search
 *
 * Runtime-neutral semantic retrieval over the org-memory vector store. Any
 * agent (OpenClaw, Hermes, or a human with curl) hits this and gets ranked
 * snippets WITH source citations + deep links for verification.
 *
 *   POST { query, filters?: { projectId?, owner?, sourceTypes? }, limit? }
 *   GET  ?q=...&projectId=...&owner=...&limit=...
 *
 * Auth is consistent with the store API: in cloud mode (DATABASE_URL set) a
 * session cookie OR Bearer token is required unless ALLOW_ANONYMOUS_READS. In
 * OSS/file mode, reads are open (mirrors the store GET gate).
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import { searchMemory, normalizeLimit, type MemorySearchFilters } from '@/lib/embedding/search';
import type { CorpusSourceType } from '@/lib/embedding/corpus';

const VALID_SOURCE_TYPES: CorpusSourceType[] = [
  'vision-doc', 'change-history', 'task-description', 'task-comment',
  'task-review-notes', 'status-history', 'blocked-reason',
];

/** Cloud-mode read gate, identical in spirit to the store GET. */
async function gate(req: NextRequest): Promise<NextResponse | null> {
  if (process.env.DATABASE_URL && process.env.ALLOW_ANONYMOUS_READS !== 'true') {
    const authErr = await authenticateRequest(req);
    if (authErr) return authErr; // 401 when neither session nor bearer present
  }
  return null;
}

function sanitizeFilters(raw: any): MemorySearchFilters {
  const f: MemorySearchFilters = {};
  if (raw?.projectId && typeof raw.projectId === 'string') f.projectId = raw.projectId;
  if (raw?.owner && typeof raw.owner === 'string') f.owner = raw.owner;
  if (Array.isArray(raw?.sourceTypes)) {
    const valid = raw.sourceTypes.filter((s: any) => VALID_SOURCE_TYPES.includes(s));
    if (valid.length > 0) f.sourceTypes = valid;
  }
  return f;
}

async function run(query: string, filters: MemorySearchFilters, limit: number) {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json(
      { error: 'memory search requires Postgres (DATABASE_URL not set)' },
      { status: 503 },
    );
  }
  if (!query || !query.trim()) {
    return NextResponse.json({ error: 'query is required' }, { status: 400 });
  }
  try {
    const result = await searchMemory(query, filters, limit);
    return NextResponse.json(result);
  } catch (e: any) {
    console.error('[memory/search] failed:', e?.message || e);
    return NextResponse.json({ error: 'search failed', detail: e?.message || String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const denied = await gate(req);
  if (denied) return denied;
  let body: any = {};
  try { body = await req.json(); } catch { /* empty body ok → 400 below */ }
  return run(body?.query ?? '', sanitizeFilters(body?.filters), normalizeLimit(body?.limit));
}

export async function GET(req: NextRequest) {
  const denied = await gate(req);
  if (denied) return denied;
  const sp = new URL(req.url).searchParams;
  const filters = sanitizeFilters({
    projectId: sp.get('projectId') || undefined,
    owner: sp.get('owner') || undefined,
    sourceTypes: sp.get('sourceTypes') ? sp.get('sourceTypes')!.split(',') : undefined,
  });
  return run(sp.get('q') || sp.get('query') || '', filters, normalizeLimit(sp.get('limit')));
}
