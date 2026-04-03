import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, readdirSync, existsSync, statSync, mkdirSync, copyFileSync } from 'fs';
import { join } from 'path';
import { authenticateRequest } from '@/lib/auth';

const BACKUP_DIR = join(process.cwd(), 'data', 'backups');
const STORE_PATH = join(process.cwd(), 'data', 'store.json');

function extractCounts(data: any) {
  return {
    tasks: Array.isArray(data?.tasks) ? data.tasks.length : 0,
    projects: Array.isArray(data?.projects) ? data.projects.length : 0,
    teammates: Array.isArray(data?.settings?.teammates) ? data.settings.teammates.length : 0,
  };
}

function filenameToTimestamp(filename: string): string {
  // store-2026-03-15T20-19-12-863Z.json → 2026-03-15T20:19:12.863Z
  const inner = filename.replace(/^store-/, '').replace(/\.json$/, '');
  // Pattern: YYYY-MM-DDTHH-MM-SS-mmmZ
  const match = inner.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
  if (match) {
    return `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
  }
  // Fallback: try replacing hyphens in time portion
  return inner.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, 'T$1:$2:$3.$4Z');
}

// GET — list backups or return a specific one
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const filename = searchParams.get('filename');

    if (filename) {
      // Return full JSON of a specific backup
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '');
      const filePath = join(BACKUP_DIR, safeName);
      if (!existsSync(filePath)) {
        return NextResponse.json({ error: 'Backup not found' }, { status: 404 });
      }
      const content = JSON.parse(readFileSync(filePath, 'utf-8'));
      return NextResponse.json(content);
    }

    // List all backups with summary stats
    if (!existsSync(BACKUP_DIR)) {
      return NextResponse.json({ backups: [] });
    }

    const files = readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('store-') && f.endsWith('.json'))
      .sort()
      .reverse(); // newest first

    const backups = files.map(f => {
      const filePath = join(BACKUP_DIR, f);
      const stat = statSync(filePath);
      let counts = { tasks: 0, projects: 0, teammates: 0 };
      try {
        const data = JSON.parse(readFileSync(filePath, 'utf-8'));
        counts = extractCounts(data);
      } catch {
        // skip parse errors
      }
      return {
        filename: f,
        timestamp: filenameToTimestamp(f),
        size: stat.size,
        ...counts,
      };
    });

    return NextResponse.json({ backups });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST — restore a backup
export async function POST(req: NextRequest) {
  const authError = await authenticateRequest(req);
  if (authError) return authError;

  try {
    const body = await req.json();
    const { action, filename } = body;

    if (action !== 'restore' || !filename) {
      return NextResponse.json({ error: 'Invalid action or missing filename' }, { status: 400 });
    }

    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '');
    const backupPath = join(BACKUP_DIR, safeName);

    if (!existsSync(backupPath)) {
      return NextResponse.json({ error: 'Backup not found' }, { status: 404 });
    }

    // 1. Create a backup of the CURRENT store.json first
    if (existsSync(STORE_PATH)) {
      mkdirSync(BACKUP_DIR, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      copyFileSync(STORE_PATH, join(BACKUP_DIR, `store-${ts}.json`));
    }

    // 2. Copy the selected backup file over store.json
    copyFileSync(backupPath, STORE_PATH);

    return NextResponse.json({ ok: true, restored: safeName });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
