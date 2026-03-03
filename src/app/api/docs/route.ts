import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

// Known doc locations
const DOC_SOURCES = [
  { dir: '/home/openclaw_user/catpilot/2026_DOCS', category: 'Catpilot Design', prefix: 'catpilot' },
  { dir: '/home/openclaw_user/.openclaw/workspace', category: 'Workspace', prefix: 'workspace', pattern: /\.(md|txt)$/i, maxDepth: 1 },
  { dir: '/home/openclaw_user/.openclaw/workspace/research', category: 'Research', prefix: 'research' },
  { dir: '/home/openclaw_user/catpilot/tests', category: 'Test Docs', prefix: 'tests', pattern: /README\.md$/i },
  { dir: '/home/openclaw_user/catpilot/migrations', category: 'Migrations', prefix: 'migrations', pattern: /\.sql$/i },
  { dir: '/home/openclaw_user/catpilot/scripts', category: 'Scripts', prefix: 'scripts', pattern: /\.sql$/i },
];

interface Doc {
  id: string;
  name: string;
  category: string;
  path: string;
  size: number;
  modifiedAt: number;
}

function scanDir(dir: string, category: string, prefix: string, pattern?: RegExp, maxDepth = 2, depth = 0): Doc[] {
  const docs: Doc[] = [];
  if (!fs.existsSync(dir) || depth > maxDepth) return docs;
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory() && depth < maxDepth) {
        docs.push(...scanDir(full, category, prefix, pattern, maxDepth, depth + 1));
      } else if (stat.isFile()) {
        const matchPattern = pattern || /\.(md|txt|sql)$/i;
        if (matchPattern.test(entry)) {
          docs.push({
            id: `${prefix}/${entry}`,
            name: entry,
            category,
            path: full,
            size: stat.size,
            modifiedAt: stat.mtimeMs,
          });
        }
      }
    }
  } catch {}
  return docs;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || 'list';
  const filePath = searchParams.get('path');
  const query = searchParams.get('q');

  try {
    if (action === 'list') {
      const allDocs: Doc[] = [];
      for (const src of DOC_SOURCES) {
        allDocs.push(...scanDir(src.dir, src.category, src.prefix, src.pattern));
      }
      allDocs.sort((a, b) => b.modifiedAt - a.modifiedAt);
      const categories = [...new Set(allDocs.map(d => d.category))];
      return NextResponse.json({ docs: allDocs, categories });
    }

    if (action === 'read' && filePath) {
      // Security: only allow known prefixes
      const allowed = DOC_SOURCES.some(s => filePath.startsWith(s.dir));
      if (!allowed) return NextResponse.json({ error: 'Access denied' }, { status: 403 });
      if (!fs.existsSync(filePath)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      const content = fs.readFileSync(filePath, 'utf-8');
      return NextResponse.json({ content, path: filePath });
    }

    if (action === 'search' && query) {
      const q = query.toLowerCase();
      const results: { name: string; category: string; path: string; line: number; text: string }[] = [];
      for (const src of DOC_SOURCES) {
        const docs = scanDir(src.dir, src.category, src.prefix, src.pattern);
        for (const doc of docs) {
          try {
            const lines = fs.readFileSync(doc.path, 'utf-8').split('\n');
            lines.forEach((line, i) => {
              if (line.toLowerCase().includes(q)) {
                results.push({ name: doc.name, category: doc.category, path: doc.path, line: i + 1, text: line.trim().slice(0, 200) });
              }
            });
          } catch {}
        }
      }
      return NextResponse.json({ results: results.slice(0, 50), query });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
