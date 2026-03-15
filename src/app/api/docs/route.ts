import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

// Doc sources — configure via DOC_SOURCES env var (JSON array) or use defaults
const DOC_SOURCES: { dir: string; category: string; prefix: string; pattern?: RegExp; maxDepth?: number }[] = (() => {
  const env = process.env.DOC_SOURCES;
  if (env) {
    try {
      return JSON.parse(env).map((s: any) => ({
        ...s,
        pattern: s.pattern ? new RegExp(s.pattern, 'i') : undefined,
      }));
    } catch {}
  }
  // Default: scan workspace markdown files
  const home = process.env.HOME || '/home/user';
  return [
    { dir: path.join(home, '.openclaw/workspace'), category: 'Workspace', prefix: 'workspace', pattern: /\.(md|txt)$/i, maxDepth: 1 },
  ];
})();

interface Doc {
  id: string;
  name: string;
  category: string;
  path: string;
  size: number;
  modifiedAt: number;
}

function scanDir(baseDir: string, dir: string, category: string, prefix: string, pattern?: RegExp, maxDepth = 2, depth = 0, exclude?: string[]): Doc[] {
  const docs: Doc[] = [];
  if (!fs.existsSync(dir) || depth > maxDepth) return docs;
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      const full = path.join(dir, entry);
      // Skip excluded subdirs (avoids double-scanning)
      if (exclude?.some(e => full.startsWith(e))) continue;
      const stat = fs.statSync(full);
      if (stat.isDirectory() && depth < maxDepth) {
        docs.push(...scanDir(baseDir, full, category, prefix, pattern, maxDepth, depth + 1, exclude));
      } else if (stat.isFile()) {
        const matchPattern = pattern || /\.(md|txt|sql)$/i;
        if (matchPattern.test(entry)) {
          // Use path relative to baseDir for unique id
          const relPath = path.relative(baseDir, full);
          docs.push({
            id: `${prefix}/${relPath}`,
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

  const allDirs = DOC_SOURCES.map(s => s.dir);

  try {
    if (action === 'list') {
      const allDocs: Doc[] = [];
      for (const src of DOC_SOURCES) {
        // Exclude other sources that are subdirs of this source
        const exclude = allDirs.filter(d => d !== src.dir && d.startsWith(src.dir));
        allDocs.push(...scanDir(src.dir, src.dir, src.category, src.prefix, src.pattern, (src as any).maxDepth, 0, exclude));
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
        const exclude = allDirs.filter(d => d !== src.dir && d.startsWith(src.dir));
        const docs = scanDir(src.dir, src.dir, src.category, src.prefix, src.pattern, (src as any).maxDepth, 0, exclude);
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
